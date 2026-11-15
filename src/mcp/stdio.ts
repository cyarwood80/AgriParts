/**
 * MCP over stdio, for Claude Desktop / Claude Code on a dealer workstation.
 *
 *   DATABASE_URL=postgres://...  AGRIPARTS_API_KEY=ap_...  npx tsx src/mcp/stdio.ts
 *
 * Identity comes from the API key (tenant + scopes), never from tool input.
 * stdout is the protocol channel: log to stderr only.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/client.js';
import { defaultOrderingRegistry } from '../integrations/ordering/adapters.js';
import { authenticate } from '../services/auth.js';
import { ServiceContext } from '../services/context.js';
import { buildMcpServer } from './server.js';

const config = loadConfig();
const database = await openDatabase(config.databaseUrl, { migrate: config.autoMigrate });
const principal = await authenticate(database.db, process.env.AGRIPARTS_API_KEY);
const ctx = new ServiceContext(database.db, principal.tenantId, { type: 'api_key', id: principal.keyId, name: principal.name }, principal.scopes, 'mcp');
const server = buildMcpServer(ctx, { ordering: defaultOrderingRegistry(), confirmSecret: config.confirmSecret });
await server.connect(new StdioServerTransport());
console.error(`[agriparts-mcp] ready for ${principal.name} (${[...principal.scopes].join(', ')})`);
process.on('SIGINT', () => void database.close().finally(() => process.exit(0)));
