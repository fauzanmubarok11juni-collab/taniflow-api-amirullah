import type { PoolClient } from 'pg';
import { pool } from '../../db/pool';
import type { AuthUser } from '../../plugins/auth';
import { permissions } from '../../shared/permissions';
import { ENTITY_ORDER } from './entities';
import type { Row } from './rules';
import { pullScope } from './scope';

/** Semua query pull dibaca dari satu snapshot agar konsisten. */
async function inSnapshot<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export async function pull(actor: AuthUser, since: number, limit: number) {
  const { changes, nextSince, hasMore } = await inSnapshot(async (c) => {
    const out: Record<string, Row[]> = {};
    let bound = Number.POSITIVE_INFINITY; // batas versi aman bila ada entitas yang kelebihan baris
    let overflow = false;

    const take = (name: string, rows: Row[], omit: string[] = []) => {
      let r = rows;
      if (r.length > limit) {
        r = r.slice(0, limit);
        overflow = true;
        bound = Math.min(bound, r[limit - 1].server_version);
      }
      out[name] = omit.length ? r.map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !omit.includes(k)))) : r;
    };

    // Pengguna: hanya id, nama, peran (untuk "diinput oleh"), tidak pernah hash.
    const users = await c.query(
      'SELECT id, full_name, role, is_active, deleted_at, server_version FROM users WHERE server_version > $1 ORDER BY server_version LIMIT $2',
      [since, limit + 1],
    );
    take('users', users.rows);

    for (const entity of ENTITY_ORDER) {
      const scope = pullScope(permissions, actor.role, entity);
      if (!scope) continue;
      const params: unknown[] = [since, limit + 1];
      let where = 'server_version > $1';
      if (scope.filter === 'own') {
        params.push(actor.id);
        where += ` AND created_by = $${params.length}`;
      } else if (scope.filter === 'field_allowed') {
        where += ' AND field_allowed = true';
      }
      // Nama tabel dari daftar tetap ENTITY_ORDER, aman.
      const r = await c.query(`SELECT * FROM ${entity} WHERE ${where} ORDER BY server_version ASC LIMIT $2`, params);
      take(entity, r.rows, scope.omit);
    }

    if (overflow) {
      for (const k of Object.keys(out)) out[k] = out[k].filter((r) => r.server_version <= bound);
    }
    const maxVersion = Object.values(out).flat().reduce((m, r) => Math.max(m, r.server_version as number), since);
    return { changes: out, nextSince: overflow ? bound : maxVersion, hasMore: overflow };
  });

  await pool.query(
    'UPDATE devices SET last_seen_at = now(), last_synced_version = GREATEST(last_synced_version, $2) WHERE id = $1',
    [actor.deviceId, nextSince],
  );
  return { changes, next_since: nextSince, has_more: hasMore, server_time: new Date().toISOString() };
}
