import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config';
import auditRoutes from './modules/audit/routes';
import authRoutes from './modules/auth/routes';
import syncRoutes from './modules/sync/routes';
import usersRoutes from './modules/users/routes';
import { pool } from './db/pool';
import authPlugin from './plugins/auth';
import { ApiError } from './shared/errors';

export async function buildApp() {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: 'info' },
    trustProxy: true, // di belakang Caddy
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(authPlugin);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.setErrorHandler((err: any, req, reply) => {
    const send = (status: number, code: string, message: string, field: string | null = null) =>
      reply.status(status).send({ error: { code, message, field } });

    if (err instanceof ApiError) return send(err.status, err.code, err.message, err.field ?? null);
    if (err instanceof ZodError) {
      const i = err.issues[0];
      return send(400, 'VALIDATION', i.message, i.path.join('.') || null);
    }
    if (err.code === '23505') return send(409, 'CONFLICT', 'Data dengan nilai yang sama sudah ada.');
    if (err.statusCode === 429) return send(429, 'RATE_LIMITED', 'Terlalu banyak permintaan. Coba lagi sebentar lagi.');
    if (err.statusCode && err.statusCode < 500) return send(err.statusCode, 'BAD_REQUEST', err.message);
    req.log.error(err);
    return send(500, 'SERVER_ERROR', 'Terjadi kesalahan di server.');
  });

  await app.register(
    async (api) => {
      api.get('/health', async () => {
        await pool.query('SELECT 1');
        return { ok: true };
      });
      await api.register(authRoutes);
      await api.register(syncRoutes);
      await api.register(usersRoutes);
      await api.register(auditRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
