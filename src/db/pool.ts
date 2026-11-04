import { Pool, types } from 'pg';
import type { PoolClient } from 'pg';
import { config } from '../config';

// bigint (rupiah, server_version) -> number; date -> string 'YYYY-MM-DD' (tanpa konversi zona waktu)
types.setTypeParser(types.builtins.INT8, (v: string) => Number(v));
types.setTypeParser(types.builtins.DATE, (v: string) => v);

export const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });

export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
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

/**
 * Semua penulisan data yang bisa disinkronkan diserialkan dengan satu kunci.
 * Akibatnya urutan server_version = urutan commit, sehingga pull berbasis
 * "versi > X" tidak pernah melewatkan baris. Untuk skala usaha tani ini cukup.
 */
export const WRITE_LOCK = 727001;
export const lockWrites = (c: PoolClient) => c.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
