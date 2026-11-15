import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { and, eq } from 'drizzle-orm';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { DB } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';
import type { OrderingAdapterRegistry } from '../integrations/ordering/adapters.js';
import { AppError } from '../lib/errors.js';
import { buildMcpServer } from '../mcp/server.js';
import { authenticate } from '../services/auth.js';
import { ServiceContext } from '../services/context.js';
import { registerRoutes } from './routes.js';

export interface AppDeps {
  db: DB;
  ordering: OrderingAdapterRegistry;
  confirmSecret: string;
  logger?: boolean | object;
}

declare module 'fastify' {
  interface FastifyRequest {
    svc?: ServiceContext;
    idempotency?: { key: string };
  }
}

export type App = FastifyInstance<any, any, any, any, ZodTypeProvider>;

export async function buildApp(deps: AppDeps): Promise<App> {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 25 * 1024 * 1024 }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'AgriParts API',
        version: '2.0.0-alpha.1',
        description:
          'Parts, stock, pricing, sales and purchasing for UK agricultural machinery dealers.\n\n' +
          'Auth: `Authorization: Bearer ap_...`. Money is integer pence ex VAT. POSTs accept an `Idempotency-Key` header. ' +
          'The same operations are available to AI agents over MCP at `/mcp`.',
      },
      components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } } },
      security: [{ apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // ---- errors -------------------------------------------------------------
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Request validation failed', details: { issues: err.validation } } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal error' } });
  });

  // ---- auth ---------------------------------------------------------------
  const authed = async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const p = await authenticate(deps.db, token);
    req.svc = new ServiceContext(deps.db, p.tenantId, { type: 'api_key', id: p.keyId, name: p.name }, p.scopes, req.url.startsWith('/mcp') ? 'mcp' : 'rest');
  };
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/v1/') || req.url.startsWith('/mcp')) await authed(req);
  });

  // ---- idempotency --------------------------------------------------------
  app.addHook('preHandler', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (req.method !== 'POST' || !req.url.startsWith('/v1/') || typeof key !== 'string' || !req.svc) return;
    if (key.length > 200) throw new AppError('VALIDATION', 'Idempotency-Key too long');
    const hash = createHash('sha256').update(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`).digest('hex');
    const tenantId = req.svc.tenantId;
    const inserted = await deps.db.insert(idempotencyKeys).values({ tenantId, key, requestHash: hash }).onConflictDoNothing().returning();
    if (inserted.length) {
      req.idempotency = { key };
      return;
    }
    const [row] = await deps.db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)));
    if (row!.requestHash !== hash) throw new AppError('VALIDATION', 'Idempotency-Key was already used for a different request');
    if (row!.responseStatus == null) throw new AppError('CONFLICT', 'A request with this Idempotency-Key is still in progress');
    reply.header('idempotent-replayed', 'true').code(row!.responseStatus).type('application/json').send(row!.responseBody);
    return reply;
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.idempotency || !req.svc) return payload;
    const where = and(eq(idempotencyKeys.tenantId, req.svc.tenantId), eq(idempotencyKeys.key, req.idempotency.key));
    if (reply.statusCode >= 500) {
      await deps.db.delete(idempotencyKeys).where(where); // let the client retry
    } else {
      await deps.db.update(idempotencyKeys).set({ responseStatus: reply.statusCode, responseBody: typeof payload === 'string' ? payload : JSON.stringify(payload) }).where(where);
    }
    return payload;
  });

  app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));

  // ---- MCP over Streamable HTTP (stateless: one server per request) -------
  app.post('/mcp', { schema: { hide: true } }, async (req: FastifyRequest, reply: FastifyReply) => {
    const server = buildMcpServer(req.svc!, { ordering: deps.ordering, confirmSecret: deps.confirmSecret });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.status(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
  app.get('/mcp', { schema: { hide: true } }, methodNotAllowed);
  app.delete('/mcp', { schema: { hide: true } }, methodNotAllowed);

  await registerRoutes(app, deps);
  return app;
}
