import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { config } from '../../config';
import { pool, withTx } from '../../db/pool';
import { hashSecret, newToken, sha256, verifySecret } from '../../shared/crypto';
import { ApiError } from '../../shared/errors';

const loginBody = z.object({
  username: z.string().trim().min(1).max(64),
  secret: z.string().min(1).max(128),
  device_id: z.string().min(8).max(100),
  device_name: z.string().max(100).optional(),
  fcm_token: z.string().max(500).optional(),
});

const refreshBody = z.object({
  refresh_token: z.string().min(10).max(200),
  device_id: z.string().min(8).max(100),
});

const changeBody = z.object({
  current_secret: z.string().min(1).max(128),
  new_secret: z.string().min(6, 'PIN/kata sandi baru minimal 6 karakter').max(128),
});

// Hash palsu agar waktu respons sama baik username ada maupun tidak (cegah penebakan username).
let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hashSecret('taniflow-dummy-secret'));

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export default async function authRoutes(app: FastifyInstance) {
  const issueRefresh = async (c: PoolClient, userId: string, deviceId: string) => {
    const token = newToken();
    await c.query(
      `INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4::int))`,
      [userId, deviceId, sha256(token), config.REFRESH_TTL_DAYS],
    );
    return token;
  };

  const session = (u: { id: string; full_name: string; role: string }, deviceId: string, refresh: string) => ({
    access_token: app.jwt.sign({ sub: u.id, did: deviceId }),
    expires_in: config.ACCESS_TTL_SECONDS,
    refresh_token: refresh,
    user: { id: u.id, full_name: u.full_name, role: u.role },
    server_time: new Date().toISOString(),
  });

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = loginBody.parse(req.body);
    const invalid = new ApiError(401, 'INVALID_CREDENTIALS', 'Username atau PIN/kata sandi salah.');

    const { rows } = await pool.query(
      `SELECT id, role, full_name, password_hash, is_active, failed_logins, locked_until
         FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL`,
      [b.username],
    );
    const u = rows[0];
    if (!u) {
      await verifySecret(await dummyHash(), b.secret);
      throw invalid;
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      throw new ApiError(429, 'ACCOUNT_LOCKED', `Akun terkunci sementara. Coba lagi dalam ${LOCK_MINUTES} menit.`);
    }
    if (!(await verifySecret(u.password_hash, b.secret))) {
      const failed = u.failed_logins + 1;
      if (failed >= MAX_FAILED) {
        await pool.query(
          `UPDATE users SET failed_logins = 0, locked_until = now() + make_interval(mins => $2::int) WHERE id = $1`,
          [u.id, LOCK_MINUTES],
        );
      } else {
        await pool.query('UPDATE users SET failed_logins = $2 WHERE id = $1', [u.id, failed]);
      }
      throw invalid;
    }
    if (!u.is_active) throw new ApiError(403, 'USER_INACTIVE', 'Akun dinonaktifkan. Hubungi Owner.');

    const refresh = await withTx(async (c) => {
      await c.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
      await c.query(
        `INSERT INTO devices (id, user_id, name, fcm_token, last_seen_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id,
           name = COALESCE(EXCLUDED.name, devices.name),
           fcm_token = COALESCE(EXCLUDED.fcm_token, devices.fcm_token), last_seen_at = now()`,
        [b.device_id, u.id, b.device_name ?? null, b.fcm_token ?? null],
      );
      await c.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL',
        [u.id, b.device_id],
      );
      return issueRefresh(c, u.id, b.device_id);
    });
    return session(u, b.device_id, refresh);
  });

  // Rotasi: setiap refresh token hanya boleh dipakai sekali.
  app.post('/auth/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const b = refreshBody.parse(req.body);
    const bad = new ApiError(401, 'UNAUTHENTICATED', 'Sesi tidak valid. Silakan login ulang.');

    const t = (
      await pool.query(
        'SELECT id, user_id, device_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1',
        [sha256(b.refresh_token)],
      )
    ).rows[0];
    if (!t || t.device_id !== b.device_id) throw bad;
    if (t.revoked_at) {
      // Token lama dipakai lagi: kemungkinan bocor, cabut semua sesi perangkat ini.
      await pool.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL',
        [t.user_id, t.device_id],
      );
      throw bad;
    }
    if (new Date(t.expires_at) < new Date()) throw bad;

    const u = (
      await pool.query('SELECT id, role, full_name, is_active FROM users WHERE id = $1 AND deleted_at IS NULL', [t.user_id])
    ).rows[0];
    if (!u || !u.is_active) throw bad;

    const next = await withTx(async (c) => {
      const r = await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [t.id]);
      if (!r.rowCount) return null; // keduluan permintaan lain
      return issueRefresh(c, u.id, t.device_id);
    });
    if (!next) throw bad;
    return session(u, t.device_id, next);
  });

  app.post('/auth/logout', { preHandler: app.authenticate }, async (req) => {
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL',
      [req.auth.id, req.auth.deviceId],
    );
    return { ok: true };
  });

  app.post('/auth/change-secret', { preHandler: app.authenticate }, async (req) => {
    const b = changeBody.parse(req.body);
    const u = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.auth.id])).rows[0];
    if (!(await verifySecret(u.password_hash, b.current_secret))) {
      throw new ApiError(403, 'INVALID_CREDENTIALS', 'PIN/kata sandi saat ini salah.', 'current_secret');
    }
    const hash = await hashSecret(b.new_secret);
    await withTx(async (c) => {
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.auth.id, hash]);
      // Perangkat lain harus login ulang; perangkat ini tetap masuk.
      await c.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND device_id <> $2 AND revoked_at IS NULL',
        [req.auth.id, req.auth.deviceId],
      );
    });
    return { ok: true };
  });
}
