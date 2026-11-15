import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { openDatabase, type Database } from '../src/db/client.js';
import { seedDemo } from '../src/db/seed.js';
import { ServiceContext, type Scope } from '../src/services/context.js';

export interface TestEnv {
  database: Database;
  tenantId: string;
  keys: { admin: string; counter: string; readonly: string };
  ctx: (scopes?: Scope[]) => ServiceContext;
}

/**
 * Fresh database per test file, migrated and seeded.
 *  - default: in-process Postgres (PGlite), no setup needed
 *  - TEST_PG_URL=postgres://user@host:port/postgres : real Postgres; a
 *    throwaway database is created per file and dropped afterwards
 */
async function freshDatabase(): Promise<Database> {
  const admin = process.env.TEST_PG_URL;
  if (!admin) return openDatabase('pglite://memory');
  const name = `agriparts_test_${randomBytes(6).toString('hex')}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const db = await openDatabase(url.toString());
  return {
    ...db,
    async close() {
      await db.close();
      const c2 = new pg.Client({ connectionString: admin });
      await c2.connect();
      await c2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c2.end();
    },
  };
}

export async function setupTestEnv(): Promise<TestEnv> {
  const database = await freshDatabase();
  const { tenantId, keys } = await seedDemo(database.db);
  return {
    database,
    tenantId,
    keys,
    ctx: (scopes) =>
      scopes
        ? new ServiceContext(database.db, tenantId, { type: 'user', id: 'test', name: 'test' }, new Set(scopes), 'rest')
        : ServiceContext.system(database.db, tenantId),
  };
}
