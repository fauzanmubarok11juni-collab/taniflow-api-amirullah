import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import { pull } from './pull';
import { applyPush } from './push';

const pushBody = z.object({
  device_id: z.string().min(8).max(100),
  ops: z
    .array(
      z.object({
        op_id: z.string().uuid(),
        entity: z.string().max(50),
        entity_id: z.string().uuid(),
        op: z.enum(['upsert', 'delete']),
        base_version: z.number().int().nonnegative().nullish(),
        data: z.record(z.any()).optional(),
      }),
    )
    .max(200),
});

const pullQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export default async function syncRoutes(app: FastifyInstance) {
  app.post('/sync/push', { preHandler: app.authenticate }, async (req) => {
    const b = pushBody.parse(req.body);
    if (b.device_id !== req.auth.deviceId) {
      throw new ApiError(400, 'VALIDATION', 'device_id tidak cocok dengan token.', 'device_id');
    }
    return applyPush(req.auth, b.ops);
  });

  app.get('/sync/pull', { preHandler: app.authenticate }, async (req) => {
    const q = pullQuery.parse(req.query);
    return pull(req.auth, q.since, q.limit);
  });
}
