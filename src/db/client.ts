import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.js';

/**
 * Both drivers produce a PgDatabase; transactions (PgTransaction) extend it, so
 * services accept `DB` and work identically inside or outside a transaction.
 */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: DB;
  driver: 'postgres' | 'pglite';
  close(): Promise<void>;
}

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * DATABASE_URL=postgres://...  -> real Postgres (production)
 * DATABASE_URL=pglite://memory -> in-process Postgres (tests, demos)
 * DATABASE_URL=pglite://./.data/db -> in-process Postgres persisted to disk
 */
export async function openDatabase(url: string, opts: { migrate?: boolean } = {}): Promise<Database> {
  const shouldMigrate = opts.migrate ?? true;
  if (url.startsWith('pglite://')) {
    const loc = url.slice('pglite://'.length);
    const client = new PGlite({ ...(loc === 'memory' || loc === '' ? {} : { dataDir: loc }), extensions: { pg_trgm } });
    const db = drizzlePglite(client, { schema });
    if (shouldMigrate) await migratePglite(db, { migrationsFolder });
    return { db: db as unknown as DB, driver: 'pglite', close: () => client.close() };
  }
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
  const db = drizzlePg(pool, { schema });
  if (shouldMigrate) await migratePg(db, { migrationsFolder });
  return { db: db as unknown as DB, driver: 'postgres', close: () => pool.end() };
}
