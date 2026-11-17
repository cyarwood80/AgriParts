/**
 * AgriParts server: REST API (/v1, docs at /docs), MCP (/mcp) and the outbox
 * dispatcher in one process. Split them later by running with different
 * flags; they share nothing but the database.
 */
import { buildApp } from './api/app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { seedDemo } from './db/seed.js';
import { apiKeys, tenants } from './db/schema.js';
import { seedGuidanceDemo } from './db/seed-guidance.js';
import { createApiKey } from './services/auth.js';
import { SCOPES } from './services/context.js';
import { and, eq, isNull } from 'drizzle-orm';
import { createLogAccountingAdapter, createXeroAdapter } from './integrations/accounting/xero.js';
import type { AccountingAdapter } from './integrations/accounting/types.js';
import { defaultOrderingRegistry } from './integrations/ordering/adapters.js';
import { startDispatcher } from './integrations/webhooks/dispatcher.js';

// Settings from .env when present (never committed). Variables already set win.
try { process.loadEnvFile(); } catch { /* no .env */ }

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

// Demo only: a fresh key for the web UI on every start, so the printed link always works.
let uiLink: string | undefined;
if (config.seedDemo) {
  const [tenant] = await database.db.select({ id: tenants.id }).from(tenants).limit(1);
  if (tenant) {
    if (await seedGuidanceDemo(database.db, tenant.id)) console.log('Added demo field-guidance content');
    await database.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.tenantId, tenant.id), eq(apiKeys.name, 'Web UI (demo)'), isNull(apiKeys.revokedAt)));
    const ui = await createApiKey(database.db, tenant.id, 'Web UI (demo)', [...SCOPES]);
    uiLink = `http://localhost:${config.port}/app/#key=${ui.key}`;
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
app.log.info(`AgriParts on :${config.port} (db: ${database.driver}) - web UI /app, API docs /docs, MCP /mcp`);
if (uiLink) console.log(`\nOpen the web UI (demo key included):\n  ${uiLink}\n`);

const shutdown = async () => {
  stopDispatcher();
  await app.close();
  await database.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
