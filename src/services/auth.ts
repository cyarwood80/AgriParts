import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { SCOPES, type Scope } from './context.js';

/**
 * API keys look like `ap_<12 char prefix>_<secret>`. Only a SHA-256 of the
 * whole key is stored; the prefix is indexed for lookup and is safe to log.
 * OAuth 2.1 (for MCP clients acting as a named user) is planned to issue
 * the same principal shape: tenant + identity + scopes.
 */
export interface Principal {
  tenantId: string;
  keyId: string;
  name: string;
  scopes: Set<Scope>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createApiKey(db: DB, tenantId: string, name: string, scopes: Scope[]) {
  for (const s of scopes) if (!SCOPES.includes(s)) throw new AppError('VALIDATION', `Unknown scope ${s}`);
  const prefix = randomBytes(9).toString('base64url').slice(0, 12);
  const secret = randomBytes(24).toString('base64url');
  const key = `ap_${prefix}_${secret}`;
  const [row] = await db.insert(apiKeys).values({ tenantId, name, prefix, keyHash: sha256(key), scopes }).returning({ id: apiKeys.id });
  return { id: row!.id, key, prefix, scopes };
}

export async function authenticate(db: DB, token: string | undefined): Promise<Principal> {
  if (!token) throw new AppError('UNAUTHORIZED', 'Missing API key (Authorization: Bearer ap_...)');
  const m = /^ap_([A-Za-z0-9_-]{12})_[A-Za-z0-9_-]+$/.exec(token);
  if (!m) throw new AppError('UNAUTHORIZED', 'Malformed API key');
  const [row] = await db.select().from(apiKeys).where(and(eq(apiKeys.prefix, m[1]!), isNull(apiKeys.revokedAt)));
  const expected = Buffer.from(row?.keyHash ?? sha256('no-such-key'), 'hex');
  const actual = Buffer.from(sha256(token), 'hex');
  if (!row || !timingSafeEqual(expected, actual)) throw new AppError('UNAUTHORIZED', 'Invalid or revoked API key');
  // Fire-and-forget usage stamp; never block a request on it.
  void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).catch(() => {});
  return { tenantId: row.tenantId, keyId: row.id, name: row.name, scopes: new Set(row.scopes as Scope[]) };
}
