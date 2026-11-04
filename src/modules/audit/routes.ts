import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { assertCan } from '../../plugins/auth';

const query = z.object({
  entity: z.string().max(50).optional(),
  entity_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(), // id terakhir dari halaman sebelumnya
});

export default async function auditRoutes(app: FastifyInstance) {
  app.get('/audit-logs', { preHandler: app.authenticate }, async (req) => {
    assertCan(req.auth, 'audit', 'R');
    const q = query.parse(req.query);

    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.entity) add('a.entity = ?', q.entity);
    if (q.entity_id) add('a.entity_id = ?', q.entity_id);
    if (q.user_id) add('a.user_id = ?', q.user_id);
    if (q.from) add('a.at >= ?', q.from);
    if (q.to) add("a.at < (?::date + 1)", q.to.slice(0, 10));
    if (q.cursor) add('a.id < ?', q.cursor);
    params.push(q.limit + 1);

    const r = await pool.query(
      `SELECT a.id, a.entity, a.entity_id, a.action, a.old_data, a.new_data, a.user_id,
              u.full_name AS user_name, a.device_id, a.at
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY a.id DESC LIMIT $${params.length}`,
      params,
    );
    const items = r.rows.slice(0, q.limit);
    return { items, next_cursor: r.rows.length > q.limit ? items[items.length - 1].id : null };
  });
}
