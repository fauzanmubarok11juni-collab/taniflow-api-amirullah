import type { PoolClient } from 'pg';
import { ZodError } from 'zod';
import { lockWrites, pool, withTx } from '../../db/pool';
import type { AuthUser } from '../../plugins/auth';
import { permissions } from '../../shared/permissions';
import { audit } from '../audit/log';
import { ENTITIES } from './entities';
import { Denied, PushOp, Row, WriteContext, authorizeWrite, checkTransferPairs, clampCreatedAt } from './rules';

export type OpStatus = 'applied' | 'duplicate' | 'conflict_overwritten';
export interface OpResult {
  op_id: string;
  status: OpStatus | 'rejected';
  code?: string;
  message?: string;
}

class OpRejected extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Kesalahan yang berarti "op ini ditolak" (bukan gangguan server). null = kesalahan tak terduga. */
function rejection(e: unknown): { code: string; message: string } | null {
  if (e instanceof OpRejected || e instanceof Denied) return { code: e.code, message: e.message };
  if (e instanceof ZodError) {
    const i = e.issues[0];
    return { code: 'VALIDATION', message: `${i.path.join('.') || 'data'}: ${i.message}` };
  }
  const pgCode = (e as { code?: string }).code;
  if (pgCode === '23503') return { code: 'UNKNOWN_REFERENCE', message: 'Data yang dirujuk belum ada di server. Kirim data master lebih dulu.' };
  if (pgCode === '23505') return { code: 'VALIDATION', message: 'Nilai yang sama sudah dipakai data lain (mis. kode barang).' };
  if (pgCode === '23514') return { code: 'VALIDATION', message: 'Data melanggar aturan (jumlah, jenis, atau status sewa lahan).' };
  return null;
}

async function loadContext(c: PoolClient, entity: string, row: Row): Promise<WriteContext> {
  if (entity === 'cash_transactions' && row.category_id) {
    const r = await c.query('SELECT direction, field_allowed FROM trx_categories WHERE id = $1 AND deleted_at IS NULL', [row.category_id]);
    if (!r.rows[0]) throw new OpRejected('UNKNOWN_REFERENCE', 'Kategori transaksi tidak ditemukan di server.');
    return { category: r.rows[0] };
  }
  return {};
}

async function processOp(c: PoolClient, actor: AuthUser, op: PushOp): Promise<OpStatus> {
  const spec = Object.hasOwn(ENTITIES, op.entity) ? ENTITIES[op.entity] : undefined;
  if (!spec) throw new OpRejected('UNSUPPORTED_ENTITY', `Entitas “${op.entity}” belum didukung.`);
  const who = { userId: actor.id, deviceId: actor.deviceId, clientOpId: op.op_id };

  await lockWrites(c);

  // Idempoten: op_id yang sudah pernah diterapkan dijawab 'duplicate' tanpa efek apa pun.
  const seen = await c.query(
    `INSERT INTO sync_ops (client_op_id, user_id, device_id, entity, entity_id, op)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING client_op_id`,
    [op.op_id, actor.id, actor.deviceId, op.entity, op.entity_id, op.op],
  );
  if (!seen.rowCount) return 'duplicate';

  // Nama tabel berasal dari registri (bukan input klien), aman disisipkan ke SQL.
  const existing: Row | null = (await c.query(`SELECT * FROM ${spec.table} WHERE id = $1 FOR UPDATE`, [op.entity_id])).rows[0] ?? null;

  // ------------------------------------------------------------------ hapus
  if (op.op === 'delete') {
    if (!existing || existing.deleted_at) return 'applied'; // sudah terhapus: anggap sukses
    authorizeWrite(permissions, actor, op.entity, 'delete', {}, existing);
    if (op.entity === 'trx_categories' && existing.is_system) {
      throw new OpRejected('FORBIDDEN', 'Kategori bawaan tidak bisa dihapus.');
    }
    // Transfer: kedua sisinya dihapus bersamaan.
    const res =
      op.entity === 'cash_transactions' && existing.kind === 'transfer'
        ? await c.query('UPDATE cash_transactions SET deleted_at = now() WHERE transfer_group_id = $1 AND deleted_at IS NULL RETURNING *', [existing.transfer_group_id])
        : await c.query(`UPDATE ${spec.table} SET deleted_at = now() WHERE id = $1 RETURNING *`, [op.entity_id]);
    for (const row of res.rows) {
      await audit(c, { entity: spec.table, entityId: row.id, action: 'delete', oldData: existing, newData: row, ...who });
    }
    return 'applied';
  }

  // ----------------------------------------------------------- tambah/ubah
  if (existing?.deleted_at) throw new OpRejected('ALREADY_DELETED', 'Data ini sudah dihapus di server.');
  const isCreate = !existing;
  const schema = isCreate ? spec.schema : spec.schema.partial();
  const { created_at: clientCreatedAt, ...parsed } = schema.parse(op.data ?? {}) as Row;
  const fields: Row = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined));

  if (!isCreate && Object.keys(fields).length === 0) return 'applied'; // tidak ada perubahan
  if (!isCreate && op.entity === 'cash_transactions' && existing.kind === 'transfer') {
    throw new OpRejected('VALIDATION', 'Transfer tidak bisa diubah. Hapus lalu buat ulang.');
  }

  const merged: Row = isCreate ? fields : { ...existing, ...fields };
  authorizeWrite(permissions, actor, op.entity, isCreate ? 'create' : 'update', merged, existing, await loadContext(c, op.entity, merged));

  const cols = Object.keys(fields); // kunci hanya dari skema zod (strict), aman sebagai nama kolom

  if (isCreate) {
    const sql = `INSERT INTO ${spec.table} (id, created_by, device_id, created_at${cols.map((k) => `, ${k}`).join('')})
                 VALUES ($1, $2, $3, $4${cols.map((_, i) => `, $${i + 5}`).join('')}) RETURNING *`;
    const r = await c.query(sql, [op.entity_id, actor.id, actor.deviceId, clampCreatedAt(clientCreatedAt), ...cols.map((k) => fields[k])]);
    await audit(c, { entity: spec.table, entityId: op.entity_id, action: 'create', newData: r.rows[0], ...who });
    return 'applied';
  }

  const sets = cols.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const r = await c.query(`UPDATE ${spec.table} SET ${sets} WHERE id = $1 RETURNING *`, [op.entity_id, ...cols.map((k) => fields[k])]);

  // Konflik nyata = baris sudah berubah sejak versi yang dilihat HP DAN penulis terakhirnya perangkat lain.
  let status: OpStatus = 'applied';
  if (op.base_version != null && existing.server_version > op.base_version) {
    const last = await c.query('SELECT device_id FROM audit_logs WHERE entity = $1 AND entity_id = $2 ORDER BY id DESC LIMIT 1', [spec.table, op.entity_id]);
    if (last.rows[0] && last.rows[0].device_id !== actor.deviceId) status = 'conflict_overwritten';
  }
  await audit(c, {
    entity: spec.table,
    entityId: op.entity_id,
    action: status === 'conflict_overwritten' ? 'conflict_overwritten' : 'update',
    oldData: existing,
    newData: r.rows[0],
    ...who,
  });
  return status;
}

export async function applyPush(actor: AuthUser, ops: PushOp[]): Promise<{ results: OpResult[]; server_version: number }> {
  const preErrors = checkTransferPairs(ops);
  const results: OpResult[] = [];

  // Berurutan, tiap op dalam transaksinya sendiri: satu op yang salah tidak menggagalkan yang lain.
  for (const op of ops) {
    const pre = preErrors.get(op.op_id);
    if (pre) {
      results.push({ op_id: op.op_id, status: 'rejected', code: 'VALIDATION', message: pre });
      continue;
    }
    try {
      results.push({ op_id: op.op_id, status: await withTx((c) => processOp(c, actor, op)) });
    } catch (e) {
      const rej = rejection(e);
      if (!rej) throw e; // gangguan server: seluruh permintaan gagal, HP mengulang nanti (aman karena idempoten)
      results.push({ op_id: op.op_id, status: 'rejected', ...rej });
    }
  }

  const v = await pool.query('SELECT last_value FROM sync_version_seq');
  return { results, server_version: Number(v.rows[0].last_value) };
}
