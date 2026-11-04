import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { lockWrites, pool, withTx } from '../../db/pool';
import { assertCan } from '../../plugins/auth';
import { hashSecret } from '../../shared/crypto';
import { ApiError } from '../../shared/errors';
import { audit } from '../audit/log';

const roleEnum = z.enum(['owner', 'admin', 'gudang', 'mandor']);
const phone = z.string().regex(/^62\d{8,13}$/, 'Nomor WhatsApp berformat 62812xxxxxxx');
const idParam = z.object({ id: z.string().uuid() });

const createBody = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,32}$/, 'Username 3–32 karakter: huruf kecil, angka, titik, strip, garis bawah'),
  full_name: z.string().trim().min(1).max(100),
  role: roleEnum,
  secret: z.string().min(6, 'PIN/kata sandi minimal 6 karakter').max(128),
  phone_wa: phone.nullish(),
  email: z.string().email().nullish(),
});

const patchBody = z
  .object({
    full_name: z.string().trim().min(1).max(100),
    role: roleEnum,
    phone_wa: phone.nullable(),
    email: z.string().email().nullable(),
    is_active: z.boolean(),
  })
  .partial()
  .strict();

const resetBody = z.object({ new_secret: z.string().min(6, 'PIN/kata sandi minimal 6 karakter').max(128) });

const PUBLIC_COLS = 'id, username, full_name, role, phone_wa, email, is_active, last_login_at, created_at';
const MAX_OWNERS = 2;

export default async function usersRoutes(app: FastifyInstance) {
  app.get('/users', { preHandler: app.authenticate }, async (req) => {
    assertCan(req.auth, 'users', 'R');
    const r = await pool.query(`SELECT ${PUBLIC_COLS} FROM users WHERE deleted_at IS NULL ORDER BY full_name`);
    return { items: r.rows };
  });

  app.post('/users', { preHandler: app.authenticate }, async (req, reply) => {
    assertCan(req.auth, 'users', 'C');
    const b = createBody.parse(req.body);
    const hash = await hashSecret(b.secret);

    const created = await withTx(async (c) => {
      await lockWrites(c);
      if (b.role === 'owner') {
        const n = (await c.query("SELECT count(*)::int AS n FROM users WHERE role = 'owner' AND deleted_at IS NULL")).rows[0].n;
        if (n >= MAX_OWNERS) throw new ApiError(409, 'OWNER_LIMIT', `Maksimal ${MAX_OWNERS} akun Owner.`);
      }
      const r = await c.query(
        `INSERT INTO users (username, full_name, role, password_hash, phone_wa, email)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PUBLIC_COLS}`,
        [b.username, b.full_name, b.role, hash, b.phone_wa ?? null, b.email ?? null],
      );
      await audit(c, { entity: 'users', entityId: r.rows[0].id, action: 'create', newData: r.rows[0], userId: req.auth.id, deviceId: req.auth.deviceId });
      return r.rows[0];
    });
    return reply.status(201).send(created);
  });

  app.patch('/users/:id', { preHandler: app.authenticate }, async (req) => {
    assertCan(req.auth, 'users', 'U');
    const { id } = idParam.parse(req.params);
    const b = patchBody.parse(req.body);

    return withTx(async (c) => {
      await lockWrites(c);
      const cur = (await c.query(`SELECT ${PUBLIC_COLS} FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
      if (!cur) throw new ApiError(404, 'NOT_FOUND', 'Pengguna tidak ditemukan.');

      const newRole = b.role ?? cur.role;
      const newActive = b.is_active ?? cur.is_active;
      const wasActiveOwner = cur.role === 'owner' && cur.is_active;
      const stillActiveOwner = newRole === 'owner' && newActive;

      if (wasActiveOwner && !stillActiveOwner) {
        const others = (await c.query("SELECT count(*)::int AS n FROM users WHERE role = 'owner' AND is_active AND deleted_at IS NULL AND id <> $1", [id])).rows[0].n;
        if (others < 1) throw new ApiError(409, 'LAST_OWNER', 'Tidak bisa menonaktifkan atau menurunkan Owner terakhir.');
      }
      if (newRole === 'owner' && cur.role !== 'owner') {
        const n = (await c.query("SELECT count(*)::int AS n FROM users WHERE role = 'owner' AND deleted_at IS NULL")).rows[0].n;
        if (n >= MAX_OWNERS) throw new ApiError(409, 'OWNER_LIMIT', `Maksimal ${MAX_OWNERS} akun Owner.`);
      }

      const cols = Object.keys(b);
      const vals = b as Record<string, unknown>;
      if (cols.length === 0) return cur;
      const sets = cols.map((k, i) => `${k} = $${i + 2}`).join(', '); // kunci berasal dari skema zod (strict), aman
      const r = await c.query(`UPDATE users SET ${sets} WHERE id = $1 RETURNING ${PUBLIC_COLS}`, [id, ...cols.map((k) => vals[k])]);

      if (b.is_active === false || (b.role && b.role !== cur.role)) {
        await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      }
      await audit(c, { entity: 'users', entityId: id, action: 'update', oldData: cur, newData: r.rows[0], userId: req.auth.id, deviceId: req.auth.deviceId });
      return r.rows[0];
    });
  });

  app.post('/users/:id/reset-secret', { preHandler: app.authenticate }, async (req) => {
    assertCan(req.auth, 'users', 'U');
    const { id } = idParam.parse(req.params);
    const b = resetBody.parse(req.body);
    const hash = await hashSecret(b.new_secret);

    await withTx(async (c) => {
      const r = await c.query(
        'UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1 AND deleted_at IS NULL',
        [id, hash],
      );
      if (!r.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Pengguna tidak ditemukan.');
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await audit(c, { entity: 'users', entityId: id, action: 'update', newData: { reset_secret: true }, userId: req.auth.id, deviceId: req.auth.deviceId });
    });
    return { ok: true };
  });
}
