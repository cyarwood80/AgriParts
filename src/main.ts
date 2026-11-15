/**
 * AgriParts server: REST API (/v1, docs at /docs), MCP (/mcp) and the outbox
 * dispatcher in one process. Split them later by running with different
 * flags; they share nothing but the database.
 */
import { buildApp } from './api/app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { seedDemo } from './db/seed.js';
import { tenants } from './db/schema.js';
import { createLogAccountingAdapter, createXeroAdapter } from './integrations/accounting/xero.js';
import type { AccountingAdapter } from './integrations/accounting/types.js';
import { defaultOrderingRegistry } from './integrations/ordering/adapters.js';
import { startDispatcher } from './integrations/webhooks/dispatcher.js';

const config = loadConfig();
const database = await openDatabase(config.databaseUrl, { migrate: config.autoMigrate });

if (config.seedDemo) {
  const existing = await database.db.select({ id: tenants.id }).from(tenants).limit(1);
  if (existing.length === 0) {
    const { keys } = await seedDemo(database.db, { log: console.log });
    console.log('\nDemo API keys (shown once):');
    console.log(`  admin     ${keys.admin}`);
    console.log(`  counter   ${keys.counter}   <- use this one for MCP clients`);
    console.log(`  readonly  ${keys.readonly}\n`);
  }
}

const accounting = new Map<string, AccountingAdapter>([
  ['log', createLogAccountingAdapter()],
  [
    'xero',
    createXeroAdapter({
      fetch: (url, init) => fetch(url, init),
      // Pilot only: a token from env. The OAuth connect flow is on the roadmap.
      getToken: async () => {
        if (!process.env.XERO_ACCESS_TOKEN) throw new Error('XERO_ACCESS_TOKEN not set');
        return process.env.XERO_ACCESS_TOKEN;
      },
    }),
  ],
]);

const app = await buildApp({
  db: database.db,
  ordering: defaultOrderingRegistry(),
  confirmSecret: config.confirmSecret,
  logger: { level: config.logLevel },
});
const stopDispatcher = startDispatcher(
  database.db,
  { fetch: (url, init) => fetch(url, init), accounting, log: (msg, data) => app.log.warn(data ?? {}, msg) },
  config.dispatcherIntervalMs,
);

await app.listen({ port: config.port, host: config.host });
app.log.info(`AgriParts on :${config.port} (db: ${database.driver}) - API docs /docs, MCP /mcp`);

const shutdown = async () => {
  stopDispatcher();
  await app.close();
  await database.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
