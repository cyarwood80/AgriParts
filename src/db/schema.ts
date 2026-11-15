/**
 * AgriParts data model.
 *
 * Conventions
 *  - Every business table carries `tenant_id`. Services always scope by tenant;
 *    Postgres row-level security is the planned second line of defence.
 *  - Money is integer pence (ex VAT unless the column says otherwise).
 *  - Rates/discounts are integer basis points (1% = 100 bps).
 *  - Quantities are integers in the part's unit of measure.
 *  - Stock is a ledger: `stock_movements` is append-only and `stock_levels` is a
 *    materialised balance updated in the same transaction as each movement.
 */
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Tenancy & organisation
// ---------------------------------------------------------------------------

export const tenants = pgTable('tenants', {
  id: id(),
  name: text('name').notNull(),
  settings: jsonb('settings').$type<TenantSettings>().notNull().default({}),
  createdAt: createdAt(),
});

export interface TenantSettings {
  /** Permit sales to drive on-hand below zero (some dealers sell before receipting). Default false. */
  allowNegativeStock?: boolean;
  /** Days before an unpaid invoice is due; used by accounting sync. */
  defaultPaymentTermsDays?: number;
}

export const depots = pgTable(
  'depots',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('depots_tenant_code_uq').on(t.tenantId, t.code)],
);

// ---------------------------------------------------------------------------
// Suppliers, parts, supersessions
// ---------------------------------------------------------------------------

export const suppliers = pgTable(
  'suppliers',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Key into the ordering-adapter registry (e.g. "manual", "csv-export", "mock-oem"). */
    orderingAdapter: text('ordering_adapter').notNull().default('manual'),
    adapterConfig: jsonb('adapter_config').$type<Record<string, unknown>>().notNull().default({}),
    leadTimeDays: integer('lead_time_days').notNull().default(7),
    accountRef: text('account_ref'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('suppliers_tenant_code_uq').on(t.tenantId, t.code)],
);

export const parts = pgTable(
  'parts',
  {
    id: id(),
    tenantId: tenantId(),
    /** Franchise / brand code. Dealers are multi-franchise: the same number can exist under two makes. */
    make: text('make').notNull(),
    partNumber: text('part_number').notNull(),
    /** Upper-cased, whitespace/punctuation stripped. Used for matching and uniqueness. */
    partNumberNorm: text('part_number_norm').notNull(),
    description: text('description').notNull(),
    uom: text('uom').notNull().default('EA'),
    discountCode: text('discount_code'),
    listPricePence: integer('list_price_pence').notNull().default(0),
    costPricePence: integer('cost_price_pence').notNull().default(0),
    /** S = standard rate, Z = zero rate, E = exempt. */
    vatCode: text('vat_code').notNull().default('S'),
    packQty: integer('pack_qty').notNull().default(1),
    barcode: text('barcode'),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    isActive: boolean('is_active').notNull().default(true),
    /** Provenance: the ingest batch that last set this part's prices. "Where did this price come from?" */
    priceBatchId: uuid('price_batch_id').references(() => ingestBatches.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('parts_tenant_make_pn_uq').on(t.tenantId, t.make, t.partNumberNorm),
    index('parts_tenant_pn_idx').on(t.tenantId, t.partNumberNorm),
    index('parts_tenant_barcode_idx').on(t.tenantId, t.barcode),
  ],
);

/**
 * Supersessions are keyed by part *number* rather than part id because the
 * manufacturer can supersede to a number the dealer has never stocked.
 */
export const partSupersessions = pgTable(
  'part_supersessions',
  {
    id: id(),
    tenantId: tenantId(),
    make: text('make').notNull(),
    fromPartNumberNorm: text('from_part_number_norm').notNull(),
    toPartNumberNorm: text('to_part_number_norm').notNull(),
    /** How many of the new part replace one of the old. */
    qtyRatio: integer('qty_ratio').notNull().default(1),
    /** false = the swap changes fitting; the counter/engineer must check instructions. */
    interchangeable: boolean('interchangeable').notNull().default(true),
    effectiveDate: date('effective_date'),
    note: text('note'),
    source: text('source').notNull().default('manual'),
    batchId: uuid('batch_id').references(() => ingestBatches.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('supersessions_from_uq').on(t.tenantId, t.make, t.fromPartNumberNorm)],
);

export const crossrefKind = pgEnum('crossref_kind', ['oem_equivalent', 'pattern_for', 'rebadge']);

/**
 * Equivalents across brands (OEM <-> pattern, rebadges). `verifiedBy IS NULL`
 * means machine-suggested: agents may show it but must label it unverified.
 */
export const partCrossrefs = pgTable(
  'part_crossrefs',
  {
    tenantId: tenantId(),
    partId: uuid('part_id')
      .notNull()
      .references(() => parts.id),
    refPartId: uuid('ref_part_id')
      .notNull()
      .references(() => parts.id),
    kind: crossrefKind('kind').notNull(),
    /** 0-100 */
    confidence: integer('confidence').notNull().default(100),
    verifiedBy: text('verified_by'),
    batchId: uuid('batch_id').references(() => ingestBatches.id),
  },
  (t) => [primaryKey({ columns: [t.partId, t.refPartId, t.kind] }), index('crossrefs_ref_idx').on(t.refPartId)],
);

// ---------------------------------------------------------------------------
// Stock ledger
// ---------------------------------------------------------------------------

export const stockLevels = pgTable(
  'stock_levels',
  {
    tenantId: tenantId(),
    partId: uuid('part_id')
      .notNull()
      .references(() => parts.id),
    depotId: uuid('depot_id')
      .notNull()
      .references(() => depots.id),
    onHand: integer('on_hand').notNull().default(0),
    allocated: integer('allocated').notNull().default(0),
    onOrder: integer('on_order').notNull().default(0),
    bin: text('bin'),
    minQty: integer('min_qty'),
    maxQty: integer('max_qty'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.partId, t.depotId] }), index('stock_levels_tenant_depot_idx').on(t.tenantId, t.depotId)],
);

export const movementType = pgEnum('movement_type', [
  'opening',
  'receipt',
  'sale',
  'sale_return',
  'transfer_out',
  'transfer_in',
  'adjustment',
  'workshop_issue',
]);

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantId(),
    partId: uuid('part_id')
      .notNull()
      .references(() => parts.id),
    depotId: uuid('depot_id')
      .notNull()
      .references(() => depots.id),
    type: movementType('type').notNull(),
    /** Signed: positive into stock, negative out. */
    qty: integer('qty').notNull(),
    unitCostPence: integer('unit_cost_pence').notNull().default(0),
    referenceType: text('reference_type'),
    referenceId: text('reference_id'),
    note: text('note'),
    actor: text('actor').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('movements_part_depot_time_idx').on(t.partId, t.depotId, t.createdAt),
    index('movements_tenant_type_time_idx').on(t.tenantId, t.type, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Customers & pricing
// ---------------------------------------------------------------------------

export const customers = pgTable(
  'customers',
  {
    id: id(),
    tenantId: tenantId(),
    accountCode: text('account_code').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    postcode: text('postcode'),
    priceBand: text('price_band').notNull().default('RETAIL'),
    onStop: boolean('on_stop').notNull().default(false),
    creditLimitPence: integer('credit_limit_pence'),
    /** Reference of the matching contact in the accounting system. */
    accountingRef: text('accounting_ref'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('customers_tenant_account_uq').on(t.tenantId, t.accountCode)],
);

/** Price band x part discount code -> discount off list price. */
export const discountMatrix = pgTable(
  'discount_matrix',
  {
    tenantId: tenantId(),
    priceBand: text('price_band').notNull(),
    discountCode: text('discount_code').notNull(),
    discountBps: integer('discount_bps').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.priceBand, t.discountCode] })],
);

/** Contract prices for specific customer/part pairs; beats the matrix. */
export const customerSpecialPrices = pgTable(
  'customer_special_prices',
  {
    tenantId: tenantId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    partId: uuid('part_id')
      .notNull()
      .references(() => parts.id),
    pricePence: integer('price_pence').notNull(),
    validUntil: date('valid_until'),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.partId] })],
);

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export const salesOrderStatus = pgEnum('sales_order_status', [
  'quote',
  'confirmed',
  'part_invoiced',
  'invoiced',
  'cancelled',
]);

export const salesOrders = pgTable(
  'sales_orders',
  {
    id: id(),
    tenantId: tenantId(),
    number: text('number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    depotId: uuid('depot_id')
      .notNull()
      .references(() => depots.id),
    status: salesOrderStatus('status').notNull().default('quote'),
    customerRef: text('customer_ref'),
    /** counter | phone | web | api | mcp */
    channel: text('channel').notNull().default('counter'),
    notes: text('notes'),
    netPence: integer('net_pence').notNull().default(0),
    vatPence: integer('vat_pence').notNull().default(0),
    grossPence: integer('gross_pence').notNull().default(0),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('sales_orders_tenant_number_uq').on(t.tenantId, t.number),
    index('sales_orders_customer_idx').on(t.customerId),
  ],
);

export const salesOrderLines = pgTable(
  'sales_order_lines',
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => salesOrders.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    partId: uuid('part_id')
      .notNull()
      .references(() => parts.id),
    /** What the customer asked for, before supersession. Kept for audit and for the customer's paperwork. */
    requestedPartNumber: text('requested_part_number').notNull(),
    qty: integer('qty').notNull(),
    qtyAllocated: integer('qty_allocated').notNull().default(0),
    qtyBackordered: integer('qty_backordered').notNull().default(0),
    qtyInvoiced: integer('qty_invoiced').notNull().default(0),
    unitListPence: integer('unit_list_pence').notNull(),
    unitNetPence: integer('unit_net_pence').notNull(),
    unitCostPence: integer('unit_cost_pence').notNull(),
    vatRateBps: integer('vat_rate_bps').notNull(),
    lineNetPence: integer('line_net_pence').notNull(),
    priceExplanation: jsonb('price_explanation').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('so_lines_order_idx').on(t.orderId), index('so_lines_part_idx').on(t.partId)],
);

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    tenantId: tenantId(),
    number: text('number').notNull(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => salesOrders.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    netPence: integer('net_pence').notNull(),
    vatPence: integer('vat_pence').notNull(),
    grossPence: integer('gross_pence').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    dueDate: date('due_date').notNull(),
    accountingRef: text('accounting_ref'),
  },
  (t) => [uniqueIndex('invoices_tenant_number_uq').on(t.tenantId, t.number)],
);

export const invoiceLines = pgTable('invoice_lines', {
  id: id(),
  tenantId: tenantId(),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  orderLineId: uuid('order_line_id')
    .notNull()
    .references(() => salesOrderLines.id),
  partId: uuid('part_id')
    .notNull()
    .references(() => parts.id),
  description: text('description').notNull(),
  qty: integer('qty').notNull(),
  unitNetPence: integer('unit_net_pence').notNull(),
  lineNetPence: integer('line_net_pence').notNull(),
  vatRateBps: integer('vat_rate_bps').notNull(),
  lineVatPence: integer('line_vat_pence').notNull(),
});

// ---------------------------------------------------------------------------
// Purchasing
// ---------------------------------------------------------------------------

export const purchaseOrderStatus = pgEnum('purchase_order_status', [
  'draft',
  'sent',
  'part_received',
  'received',
  'cancelled',
]);

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: id(),
    tenantId: tenantId(),
    number: text('number').notNull(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    depotId: uuid('depot_id')
      .notNull()
      .references(() => depots.id),
    status: purchaseOrderStatus('status').notNull().default('draft'),
    /** stock | vor (vehicle-off-road: a customer machine is down, ship urgently) */
    orderType: text('order_type').notNull().default('stock'),
    externalRef: text('external_ref'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('purchase_orders_tenant_number_uq').on(t.tenantId, t.number)],
);

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: id(),
    tenantId: tenantId(),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    partId: uuid('part_id')
      .notNull()
      .references(() => parts.id),
    qtyOrdered: integer('qty_ordered').notNull(),
    qtyReceived: integer('qty_received').notNull().default(0),
    unitCostPence: integer('unit_cost_pence').notNull(),
  },
  (t) => [index('po_lines_po_idx').on(t.purchaseOrderId)],
);

// ---------------------------------------------------------------------------
// Platform: sequences, events/outbox, webhooks, integrations, auth, audit
// ---------------------------------------------------------------------------

export const numberSequences = pgTable(
  'number_sequences',
  {
    tenantId: tenantId(),
    name: text('name').notNull(),
    nextValue: integer('next_value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.name] })],
);

/** Transactional outbox. Written in the same transaction as the state change it describes. */
export const domainEvents = pgTable(
  'domain_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantId(),
    type: text('type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    fannedOutAt: timestamp('fanned_out_at', { withTimezone: true }),
  },
  (t) => [index('events_tenant_id_idx').on(t.tenantId, t.id), index('events_fanout_idx').on(t.fannedOutAt)],
);

export const deliveryStatus = pgEnum('delivery_status', ['pending', 'done', 'dead']);

/** One row per (event, target). Targets are webhook subscriptions or integration connections. */
export const eventDeliveries = pgTable(
  'event_deliveries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantId(),
    eventId: integer('event_id')
      .notNull()
      .references(() => domainEvents.id),
    /** "webhook:<subscriptionId>" or "connection:<connectionId>" */
    target: text('target').notNull(),
    status: deliveryStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    lastResponseCode: integer('last_response_code'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('deliveries_event_target_uq').on(t.eventId, t.target),
    index('deliveries_due_idx').on(t.status, t.nextAttemptAt),
  ],
);

export const webhookSubscriptions = pgTable('webhook_subscriptions', {
  id: id(),
  tenantId: tenantId(),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  /** Event types to receive; ["*"] for all. */
  eventTypes: text('event_types').array().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

/** A configured link to an external system (accounting package, supplier portal...). */
export const integrationConnections = pgTable('integration_connections', {
  id: id(),
  tenantId: tenantId(),
  /** accounting | supplier_ordering */
  kind: text('kind').notNull(),
  provider: text('provider').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  /** Event types this connection consumes from the outbox. */
  eventTypes: text('event_types').array().notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

export const batchStatus = pgEnum('batch_status', ['running', 'loaded', 'dry_run', 'failed']);

/**
 * Provenance: every file load (price file, Ibcos export) is a batch.
 * Re-loading the same file (same checksum) for the same source is a no-op.
 */
export const ingestBatches = pgTable(
  'ingest_batches',
  {
    id: id(),
    tenantId: tenantId(),
    /** price_file | legacy_customers | legacy_parts | legacy_stock */
    kind: text('kind').notNull(),
    /** Supplier code, or "ibcos-gold" etc. */
    source: text('source').notNull(),
    sourceName: text('source_name').notNull(),
    checksum: text('checksum').notNull(),
    mapping: jsonb('mapping').$type<Record<string, unknown>>().notNull(),
    rowCount: integer('row_count'),
    status: batchStatus('status').notNull().default('running'),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    actor: text('actor').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('ingest_batches_lookup_idx').on(t.tenantId, t.kind, t.source, t.checksum)],
);

export const ingestIssues = pgTable(
  'ingest_issues',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantId(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => ingestBatches.id, { onDelete: 'cascade' }),
    rowNo: integer('row_no'),
    severity: text('severity').notNull(),
    message: text('message').notNull(),
    raw: jsonb('raw').$type<unknown>(),
  },
  (t) => [index('ingest_issues_batch_idx').on(t.batchId)],
);

/** Every MCP tool call: who asked, what, whether it worked. */
export const toolCallLog = pgTable(
  'tool_call_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantId(),
    principal: text('principal').notNull(),
    tool: text('tool').notNull(),
    args: jsonb('args').$type<unknown>().notNull(),
    ok: boolean('ok').notNull(),
    resultSummary: text('result_summary'),
    durationMs: integer('duration_ms'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tool_call_log_tenant_idx').on(t.tenantId, t.at)],
);

/** Audit trail of every sync run (accounting pushes, supplier submissions) with a machine-readable summary. */
export const integrationRuns = pgTable(
  'integration_runs',
  {
    id: id(),
    tenantId: tenantId(),
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),
    status: text('status').notNull(),
    dryRun: boolean('dry_run').notNull().default(false),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    actor: text('actor').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('integration_runs_tenant_idx').on(t.tenantId, t.startedAt)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('api_keys_prefix_uq').on(t.prefix)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: tenantId(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantId(),
    actor: text('actor').notNull(),
    /** rest | mcp | system | import */
    channel: text('channel').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_tenant_time_idx').on(t.tenantId, t.createdAt)],
);
