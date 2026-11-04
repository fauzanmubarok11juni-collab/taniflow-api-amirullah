// Aturan murni (tanpa database) agar mudah diuji.
import type { Act, Permissions, Role } from '../../shared/permissions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export interface Actor {
  id: string;
  role: Role;
}

export interface WriteContext {
  category?: { direction: string; field_allowed: boolean };
}

export interface PushOp {
  op_id: string;
  entity: string;
  entity_id: string;
  op: 'upsert' | 'delete';
  base_version?: number | null;
  data?: Row;
}

export class Denied extends Error {
  constructor(
    public code: 'FORBIDDEN' | 'VALIDATION',
    message: string,
  ) {
    super(message);
  }
}

/** Jenis pergerakan stok yang boleh dicatat tiap peran (selain izin dasar di permissions.json). */
const MOVES_BY_ROLE: Record<Role, string[]> = {
  owner: ['purchase_in', 'harvest_in', 'usage_out', 'sale_out', 'adjustment'],
  admin: ['purchase_in', 'sale_out'],
  gudang: ['purchase_in', 'harvest_in', 'usage_out', 'sale_out', 'adjustment'],
  mandor: ['usage_out'],
};

const VERB = { create: 'membuat', update: 'mengubah', delete: 'menghapus' } as const;

/** Entitas -> kunci di permissions.json. */
export function resourceFor(entity: string, data: Row, existing: Row | null): string {
  switch (entity) {
    case 'trx_categories':
      return 'categories';
    case 'suppliers':
      return 'stock';
    case 'warehouses':
      return 'items';
    case 'cash_transactions':
      return (existing?.kind ?? data.kind) === 'transfer' ? 'transfer' : 'cash';
    case 'stock_movements':
      return (existing?.move_type ?? data.move_type) === 'adjustment' ? 'opname' : 'stock';
    default:
      return entity; // accounts, lands, items
  }
}

/**
 * Lempar Denied bila [actor] tidak boleh melakukan [op].
 * [data] = isi baris setelah perubahan (untuk update: baris lama digabung perubahan).
 */
export function authorizeWrite(
  perms: Permissions,
  actor: Actor,
  entity: string,
  op: 'create' | 'update' | 'delete',
  data: Row,
  existing: Row | null,
  ctx: WriteContext = {},
): void {
  const act: Act = op === 'create' ? 'C' : op === 'update' ? 'U' : 'D';
  const resource = resourceFor(entity, data, existing);
  if (!perms.can(actor.role, resource, act)) {
    throw new Denied('FORBIDDEN', `Peran ${actor.role} tidak diizinkan ${VERB[op]} data ini (${resource}).`);
  }
  if (op === 'delete') return;

  if (entity === 'suppliers' && actor.role === 'mandor') {
    throw new Denied('FORBIDDEN', 'Mandor tidak boleh mengelola data pemasok.');
  }
  if (entity === 'stock_movements' && op === 'create' && !MOVES_BY_ROLE[actor.role].includes(data.move_type)) {
    throw new Denied('FORBIDDEN', `Peran ${actor.role} tidak boleh mencatat jenis stok “${data.move_type}”.`);
  }

  if (entity === 'cash_transactions') {
    if (data.kind === 'normal' && ctx.category && ctx.category.direction !== data.direction) {
      throw new Denied('VALIDATION', 'Kategori tidak sesuai dengan jenis transaksi (masuk/keluar).');
    }
    if (op === 'create' && actor.role === 'mandor') {
      if (data.kind !== 'normal' || data.direction !== 'out') {
        throw new Denied('FORBIDDEN', 'Mandor hanya boleh mencatat pengeluaran.');
      }
      if (!ctx.category?.field_allowed) {
        throw new Denied('FORBIDDEN', 'Kategori ini tidak tersedia untuk Mandor.');
      }
    }
  }
}

/**
 * Transfer kas = dua baris (keluar + masuk) dengan transfer_group_id sama, harus ada dalam
 * satu kiriman. Mengembalikan op_id -> alasan penolakan.
 */
export function checkTransferPairs(ops: PushOp[]): Map<string, string> {
  const bad = new Map<string, string>();
  const groups = new Map<string, PushOp[]>();
  for (const o of ops) {
    if (o.entity !== 'cash_transactions' || o.op !== 'upsert' || o.data?.kind !== 'transfer') continue;
    const g = String(o.data.transfer_group_id ?? '');
    if (!g) {
      bad.set(o.op_id, 'Transfer wajib punya transfer_group_id.');
      continue;
    }
    const list = groups.get(g) ?? [];
    list.push(o);
    groups.set(g, list);
  }
  for (const legs of groups.values()) {
    let msg: string | null = null;
    if (legs.length !== 2) {
      msg = 'Transfer harus terdiri dari dua baris (keluar dan masuk) dalam satu kiriman.';
    } else {
      const [a, b] = [legs[0].data as Row, legs[1].data as Row];
      if (a.direction === b.direction) msg = 'Arah transfer harus berlawanan (satu keluar, satu masuk).';
      else if (a.amount !== b.amount) msg = 'Jumlah transfer di kedua sisi harus sama.';
      else if (a.account_id === b.account_id) msg = 'Akun asal dan tujuan transfer tidak boleh sama.';
    }
    if (msg) for (const l of legs) bad.set(l.op_id, msg);
  }
  return bad;
}

/** Waktu input dari HP dipercaya, tetapi tidak boleh lebih dari 5 menit di depan jam server. */
export function clampCreatedAt(v: string | undefined, now = new Date()): Date {
  if (!v) return now;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return now;
  const max = new Date(now.getTime() + 5 * 60 * 1000);
  return d > max ? max : d;
}
