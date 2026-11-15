import { openDatabase, type Database } from '../src/db/client.js';
import { seedDemo } from '../src/db/seed.js';
import { ServiceContext, type Scope } from '../src/services/context.js';

export interface TestEnv {
  database: Database;
  tenantId: string;
  keys: { admin: string; counter: string; readonly: string };
  ctx: (scopes?: Scope[]) => ServiceContext;
}

/** Fresh in-process Postgres (PGlite), migrated and seeded. ~1-2s. */
export async function setupTestEnv(): Promise<TestEnv> {
  const database = await openDatabase('pglite://memory');
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
