import type { SQL } from 'drizzle-orm';
import type { DB } from './client.js';

/** Run raw SQL and return rows, smoothing over driver result-shape differences. */
export async function rows<T>(db: DB, query: SQL): Promise<T[]> {
  const res = (await db.execute(query)) as unknown as { rows?: T[] } | T[];
  return Array.isArray(res) ? res : (res.rows ?? []);
}
