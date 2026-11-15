import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Confirmation codes for MCP write tools.
 *
 * A write tool called without a code returns a PREVIEW and a code. Calling it
 * again with the code executes. The code is an HMAC over:
 *   tenant + principal + tool + the exact arguments + a fingerprint of the
 *   current state (e.g. the order's totals, the source depot's free stock)
 *   + a 15-minute window.
 * So the agent can only commit exactly what it showed the human, by the same
 * principal, while the facts it showed are still true. Stateless: nothing to
 * store or expire.
 */
const WINDOW_MS = 15 * 60_000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface ConfirmationScope {
  tenantId: string;
  principal: string;
  tool: string;
  args: Record<string, unknown>;
  state: unknown;
}

function code(secret: string, scope: ConfirmationScope, window: number): string {
  const { confirmation_code: _ignored, ...args } = scope.args;
  const mac = createHmac('sha256', secret)
    .update([scope.tenantId, scope.principal, scope.tool, canonical(args), canonical(scope.state), window].join('|'))
    .digest('base64url');
  return `CONF-${mac.slice(0, 10).toUpperCase()}`;
}

export function issueConfirmation(secret: string, scope: ConfirmationScope, now = Date.now()): string {
  return code(secret, scope, Math.floor(now / WINDOW_MS));
}

export function checkConfirmation(secret: string, scope: ConfirmationScope, supplied: string, now = Date.now()): boolean {
  const w = Math.floor(now / WINDOW_MS);
  // Accept the current and previous window so a code issued at 14:59 works at 15:01.
  return [w, w - 1].some((win) => {
    const a = Buffer.from(code(secret, scope, win));
    const b = Buffer.from(supplied.trim().toUpperCase());
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
