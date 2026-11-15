/**
 * AgriParts MCP server.
 *
 * Built per request/session from a ServiceContext, so:
 *  - tenant and identity come from the transport's credentials, NEVER from tool arguments
 *  - the tool list is filtered by the principal's scopes (a read-only key
 *    simply doesn't see write tools)
 *  - every tool calls the same service layer as the REST API: one set of rules
 *
 * Write tools are two-phase (see confirm.ts) and audited. Invoicing is
 * deliberately not exposed to agents.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { stockLevels, toolCallLog } from '../db/schema.js';
import type { OrderingAdapterRegistry } from '../integrations/ordering/adapters.js';
import { AppError } from '../lib/errors.js';
import type { Scope, ServiceContext } from '../services/context.js';
import { customerSummary, listBackorders, searchCustomers } from '../services/customers.js';
import { deadStock, rebalanceSuggestions, reorderSuggestions } from '../services/insights.js';
import { getCustomerByAccount, getDepotByCode, getSupplierByCode, listDepots } from '../services/lookups.js';
import { confirmOrder, createQuote, getOrder } from '../services/orders.js';
import { partDetail, resolvePart, searchParts, stockByDepot } from '../services/parts.js';
import { priceFor } from '../services/pricing.js';
import { createPurchaseOrder } from '../services/purchasing.js';
import { transferStock } from '../services/stock.js';
import { checkConfirmation, issueConfirmation } from './confirm.js';
import { present } from './present.js';
import { COUNTER_ASSISTANT_PROMPT, morningReviewPrompt } from './prompts.js';

export const MCP_SERVER_INFO = { name: 'agriparts', version: '2.0.0-alpha.1' };

export interface McpDeps {
  ordering: OrderingAdapterRegistry;
  /** HMAC secret for confirmation codes. */
  confirmSecret: string;
}

const partRef = {
  part_number: z.string().min(1).describe('Part number in any format, e.g. "ACM-10044", "acm 10044"'),
  make: z.string().optional().describe('Make/franchise code (e.g. ACM, NFB, GEN). Only needed if the number exists under several makes.'),
};
const confirmationCode = z
  .string()
  .optional()
  .describe('Leave empty to get a preview and a confirmation code. Only send the code after the human has approved the preview.');

type Handler<A> = (args: A) => Promise<unknown>;

export function buildMcpServer(ctx: ServiceContext, deps: McpDeps): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions:
      'AgriParts: parts, stock, pricing and ordering for a UK agricultural machinery dealer. ' +
      'Always resolve part numbers (supersessions!) before pricing or ordering. Money is GBP ex VAT unless stated. ' +
      'Write tools are two-phase: call without confirmation_code to preview, show the human, then call again with the code.',
  });

  const tool = <S extends z.ZodRawShape>(
    name: string,
    scopes: Scope[],
    config: { title: string; description: string; input: S; readOnly: boolean },
    handler: Handler<z.infer<z.ZodObject<S>>>,
  ) => {
    if (!scopes.every((s) => ctx.can(s))) return; // not visible to this principal
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.input,
        annotations: { readOnlyHint: config.readOnly, destructiveHint: false, openWorldHint: false },
      },
      (async (args: z.infer<z.ZodObject<S>>): Promise<CallToolResult> => {
        const started = Date.now();
        try {
          const result = present(await handler(args));
          const text = JSON.stringify(result, null, 2);
          await logCall(ctx, name, args, true, text, Date.now() - started);
          return { content: [{ type: 'text', text }] };
        } catch (e) {
          const err =
            e instanceof AppError
              ? { error: e.code, message: e.message, details: e.details }
              : e instanceof z.ZodError
                ? { error: 'VALIDATION', message: e.message }
                : { error: 'INTERNAL', message: 'Unexpected error; the request was not completed.' };
          if (!(e instanceof AppError) && !(e instanceof z.ZodError)) console.error(`[mcp] ${name} failed`, e);
          await logCall(ctx, name, args, false, err.message, Date.now() - started);
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(err, null, 2) }] };
        }
      }) as never,
    );
  };

  // Two-phase helper for write tools.
  const twoPhase = async <T>(
    toolName: string,
    args: Record<string, unknown> & { confirmation_code?: string | undefined },
    state: unknown,
    preview: unknown,
    commit: () => Promise<T>,
  ) => {
    const scope = { tenantId: ctx.tenantId, principal: ctx.actorLabel, tool: toolName, args, state };
    if (!args.confirmation_code) {
      return {
        status: 'PREVIEW_ONLY_NOTHING_CHANGED',
        preview,
        confirmation_code: issueConfirmation(deps.confirmSecret, scope),
        next_step: `Show this preview to the user. If they approve, call ${toolName} again with identical arguments plus confirmation_code. Codes expire after ~15 minutes or if the underlying data changes.`,
      };
    }
    if (!checkConfirmation(deps.confirmSecret, scope, args.confirmation_code)) {
      throw new AppError('CONFLICT', 'Confirmation code is invalid, expired, or the data changed since the preview. Call again without a code for a fresh preview.');
    }
    return { status: 'DONE', result: await commit() };
  };

  // -------------------------------------------------------------------------
  // Read tools
  // -------------------------------------------------------------------------

  tool('search_parts', ['parts:read'], {
    title: 'Search parts',
    description: 'Search the parts master by part number (any brand format, typos tolerated), barcode, or description words. Use first when someone describes a part. Returns candidates; then call resolve_part_number on the right one.',
    input: { query: z.string().min(2), make: z.string().optional(), limit: z.number().int().min(1).max(50).default(10) },
    readOnly: true,
  }, ({ query, make, limit }) => searchParts(ctx, { query, make, limit }));

  tool('resolve_part_number', ['parts:read'], {
    title: 'Resolve part number',
    description: 'Follow supersessions to the part to supply today; returns the chain, stock by depot, and cross-brand equivalents. If straightSwap is false, warn that fitting changes and the engineer must check instructions. Equivalents marked UNVERIFIED must be presented as unconfirmed.',
    input: partRef,
    readOnly: true,
  }, ({ part_number, make }) => partDetail(ctx, { partNumber: part_number, make }));

  tool('check_availability', ['stock:read'], {
    title: 'Check availability',
    description: 'Free stock (on hand minus allocated), on-order and bin at every depot for a part, after resolving supersessions. Use before promising a customer anything.',
    input: partRef,
    readOnly: true,
  }, async ({ part_number, make }) => {
    const r = await resolvePart(ctx, { partNumber: part_number, make });
    const depots = await stockByDepot(ctx, r.part.id);
    return {
      supplied: { make: r.part.make, partNumber: r.part.partNumber, description: r.part.description },
      superseded: r.superseded, warning: r.warning,
      depots: depots.map(({ depotId: _d, ...d }) => d),
      totalAvailable: depots.reduce((s, d) => s + d.available, 0),
    };
  });

  tool('get_price', ['parts:read', 'customers:read'], {
    title: 'Get customer price',
    description: "Price a part for a specific customer account (contract price, discount band, list) ex VAT, with the reason. Quote these exact figures; don't calculate discounts yourself.",
    input: { ...partRef, customer_account: z.string().describe('Customer account code, e.g. HILL01'), qty: z.number().int().positive().default(1) },
    readOnly: true,
  }, async ({ part_number, make, customer_account, qty }) => {
    const r = await resolvePart(ctx, { partNumber: part_number, make });
    const c = await getCustomerByAccount(ctx, customer_account);
    const p = await priceFor(ctx, r.part, c);
    const units = qty * r.qtyMultiplier;
    const { unitCostPence: _c, marginBps: _m, ...customerSafe } = p;
    return {
      customer: { accountCode: c.accountCode, name: c.name, onStop: c.onStop },
      part: { make: r.part.make, partNumber: r.part.partNumber, description: r.part.description },
      superseded: r.superseded, warning: r.warning,
      qty: units, ...customerSafe, lineNetPence: p.unitNetPence * units,
      ...(ctx.can('insights:read') ? { internal: { unitCostPence: p.unitCostPence, marginBps: p.marginBps } } : {}),
    };
  });

  tool('find_customer', ['customers:read'], {
    title: 'Find customer',
    description: 'Find customer accounts by account code, name, postcode or phone.',
    input: { query: z.string().min(2) },
    readOnly: true,
  }, ({ query }) => searchCustomers(ctx, query));

  tool('get_customer', ['customers:read'], {
    title: 'Customer account',
    description: 'Account details, price band, on-stop status and recent orders. Check onStop before taking an order.',
    input: { account_code: z.string() },
    readOnly: true,
  }, ({ account_code }) => customerSummary(ctx, account_code));

  tool('get_order', ['orders:read'], {
    title: 'Get order',
    description: 'A quote or sales order with lines, allocation/backorder status, pricing basis and invoices.',
    input: { order_number: z.string().describe('e.g. SO-000123') },
    readOnly: true,
  }, ({ order_number }) => getOrder(ctx, order_number));

  tool('list_backorders', ['orders:read'], {
    title: 'Backorders',
    description: 'Customer order lines waiting for stock, oldest first, with customer contact details.',
    input: { depot_code: z.string().optional() },
    readOnly: true,
  }, ({ depot_code }) => listBackorders(ctx, { depotCode: depot_code }));

  tool('list_depots', ['parts:read'], {
    title: 'List depots',
    description: "The dealer's depots and their codes.",
    input: {},
    readOnly: true,
  }, async () => (await listDepots(ctx)).map((d) => ({ code: d.code, name: d.name, active: d.isActive })));

  tool('reorder_suggestions', ['insights:read'], {
    title: 'Reorder suggestions',
    description: 'What to buy: parts at or below reorder point given sales history, lead time, on-order and backorders, rounded to pack size, each with its reasoning. Check rebalance_suggestions before buying.',
    input: { depot_code: z.string().optional(), supplier_code: z.string().optional(), cover_days: z.number().int().min(1).max(120).optional() },
    readOnly: true,
  }, ({ depot_code, supplier_code, cover_days }) => reorderSuggestions(ctx, { depotCode: depot_code, supplierCode: supplier_code, coverDays: cover_days }));

  tool('rebalance_suggestions', ['insights:read'], {
    title: 'Depot rebalancing',
    description: 'Transfers between depots that would cover a shortfall from another depot\'s surplus instead of buying more.',
    input: {},
    readOnly: true,
  }, () => rebalanceSuggestions(ctx));

  tool('dead_stock', ['insights:read'], {
    title: 'Dead stock',
    description: 'Stock with no sales/issues/transfers out in N days, valued at cost, highest value first.',
    input: { depot_code: z.string().optional(), days: z.number().int().min(30).max(1095).default(365) },
    readOnly: true,
  }, ({ depot_code, days }) => deadStock(ctx, { depotCode: depot_code, days }));

  // -------------------------------------------------------------------------
  // Write tools
  // -------------------------------------------------------------------------

  tool('create_quote', ['orders:write', 'customers:read'], {
    title: 'Create quote',
    description: 'Save a priced quote for a customer (resolves supersessions, applies their pricing, shows availability). A quote reserves no stock and commits nothing; use confirm_order once the customer agrees.',
    input: {
      customer_account: z.string(),
      depot_code: z.string().describe('Depot supplying the order'),
      lines: z.array(z.object({ ...partRef, qty: z.number().int().positive() })).min(1).max(50),
      customer_ref: z.string().optional().describe("Customer's own order reference"),
    },
    readOnly: false,
  }, ({ customer_account, depot_code, lines, customer_ref }) =>
    createQuote(ctx, {
      customerAccount: customer_account, depotCode: depot_code, customerRef: customer_ref, channel: 'mcp',
      lines: lines.map((l) => ({ partNumber: l.part_number, make: l.make, qty: l.qty })),
    }));

  tool('confirm_order', ['orders:write'], {
    title: 'Confirm order',
    description: 'Turn a quote into a confirmed order: allocates free stock at the depot and backorders the rest. Two-phase: preview first, then confirm with the code after the human approves.',
    input: { order_number: z.string(), confirmation_code: confirmationCode },
    readOnly: false,
  }, async (args) => {
    const order = await getOrder(ctx, args.order_number);
    if (order.status !== 'quote') throw new AppError('INVALID_STATE', `${order.number} is ${order.status}, not a quote`);
    const preview = {
      order: order.number,
      customer: order.customer,
      depot: order.depot.code,
      totals: order.totals,
      lines: order.lines.map((l) => ({
        partNumber: l.partNumber, qty: l.qty,
        willAllocate: Math.min(l.qty, Math.max(0, l.availability?.atDepot ?? 0)),
        willBackorder: Math.max(0, l.qty - Math.max(0, l.availability?.atDepot ?? 0)),
        elsewhere: l.availability?.elsewhere,
      })),
      blockers: order.customer.onStop ? ['Customer account is ON STOP; confirmation will be refused'] : [],
    };
    const state = { status: order.status, totals: order.totals, lines: preview.lines.map((l) => [l.partNumber, l.qty, l.willAllocate]) };
    return twoPhase('confirm_order', args, state, preview, () => confirmOrder(ctx, order.number));
  });

  tool('transfer_stock', ['stock:write'], {
    title: 'Transfer stock between depots',
    description: 'Move free stock from one depot to another (e.g. to cover a customer order or a rebalance suggestion). Two-phase.',
    input: {
      ...partRef,
      from_depot: z.string(), to_depot: z.string(),
      qty: z.number().int().positive(),
      reason: z.string().min(3),
      confirmation_code: confirmationCode,
    },
    readOnly: false,
  }, async (args) => {
    const r = await resolvePart(ctx, { partNumber: args.part_number, make: args.make });
    const from = await getDepotByCode(ctx, args.from_depot);
    const to = await getDepotByCode(ctx, args.to_depot);
    const [level] = await ctx.db.select().from(stockLevels).where(and(eq(stockLevels.partId, r.part.id), eq(stockLevels.depotId, from.id)));
    const free = level ? level.onHand - level.allocated : 0;
    const preview = {
      part: { make: r.part.make, partNumber: r.part.partNumber, description: r.part.description },
      from: from.code, to: to.code, qty: args.qty, freeAtSource: free,
      blockers: free < args.qty ? [`Only ${free} free at ${from.code}`] : [],
    };
    return twoPhase('transfer_stock', args, { free, partId: r.part.id }, preview, () =>
      transferStock(ctx, { partNumber: r.part.partNumber, make: r.part.make, fromDepotCode: from.code, toDepotCode: to.code, qty: args.qty, reason: args.reason }));
  });

  tool('raise_purchase_order', ['purchasing:write', 'insights:read'], {
    title: 'Raise draft purchase order',
    description: "Create a DRAFT purchase order for a supplier, either from explicit lines or from the current reorder suggestions. Drafts are not sent; a buyer reviews and sends them. Mark order_type 'vor' when a customer's machine is off the road. Two-phase.",
    input: {
      supplier_code: z.string(),
      depot_code: z.string(),
      order_type: z.enum(['stock', 'vor']).default('stock'),
      from_suggestions: z.boolean().default(false).describe('Use reorder_suggestions for this supplier and depot'),
      lines: z.array(z.object({ ...partRef, qty: z.number().int().positive() })).max(200).optional(),
      confirmation_code: confirmationCode,
    },
    readOnly: false,
  }, async (args) => {
    const supplier = await getSupplierByCode(ctx, args.supplier_code);
    const depot = await getDepotByCode(ctx, args.depot_code);
    const lines = args.from_suggestions
      ? (await reorderSuggestions(ctx, { depotCode: depot.code, supplierCode: supplier.code })).map((s) => ({ partNumber: s.partNumber, make: s.make, qty: s.suggestedQty }))
      : (args.lines ?? []).map((l) => ({ partNumber: l.part_number, make: l.make, qty: l.qty }));
    if (lines.length === 0) throw new AppError('VALIDATION', args.from_suggestions ? `No reorder suggestions for ${supplier.code} at ${depot.code}` : 'Provide lines or set from_suggestions');
    const preview = { supplier: supplier.code, depot: depot.code, orderType: args.order_type, lines, note: 'Creates a DRAFT only; nothing is sent to the supplier.' };
    return twoPhase('raise_purchase_order', args, lines, preview, () =>
      createPurchaseOrder(ctx, { supplierCode: supplier.code, depotCode: depot.code, orderType: args.order_type, lines }));
  });

  // -------------------------------------------------------------------------
  // Resources & prompts
  // -------------------------------------------------------------------------

  if (ctx.can('parts:read')) {
    server.registerResource('depots', 'agriparts://depots', { title: 'Depots', mimeType: 'application/json' }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify((await listDepots(ctx)).map((d) => ({ code: d.code, name: d.name }))) }],
    }));
    server.registerResource(
      'part',
      new ResourceTemplate('agriparts://parts/{make}/{partNumber}', { list: undefined }),
      { title: 'Part detail', mimeType: 'application/json' },
      async (uri, { make, partNumber }) => ({
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(present(await partDetail(ctx, { make: String(make), partNumber: decodeURIComponent(String(partNumber)) }))) }],
      }),
    );
  }

  server.registerPrompt('counter_assistant', { title: 'Parts counter assistant', description: 'Operating rules for an agent working the parts counter.' }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: COUNTER_ASSISTANT_PROMPT } }],
  }));
  server.registerPrompt(
    'morning_parts_review',
    { title: 'Morning parts review', description: "Daily review: backorders, what to buy, what to move, what's dead.", argsSchema: { depot_code: z.string().optional() } },
    ({ depot_code }) => ({ messages: [{ role: 'user', content: { type: 'text', text: morningReviewPrompt(depot_code) } }] }),
  );

  return server;
}

async function logCall(ctx: ServiceContext, tool: string, args: unknown, ok: boolean, summary: string, durationMs: number) {
  try {
    await ctx.db.insert(toolCallLog).values({ tenantId: ctx.tenantId, principal: ctx.actorLabel, tool, args: args ?? {}, ok, resultSummary: summary.slice(0, 1000), durationMs });
  } catch (e) {
    console.error('[mcp] failed to write tool_call_log', e);
  }
}
