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
 * Registry of every feed a dealer's data comes from (ADR-0005). Batches point
 * here, so "where did this fact come from?" always has an answer, and when two
 * sources disagree the lower `precedence` wins.
 */
export const dataSources = pgTable(
  'data_sources',
  {
    id: id(),
    tenantId: tenantId(),
    /** ibcos-gold | kramp-prices | mcconnel-parts-books | dealer-uploads ... */
    code: text('code').notNull(),
    /** dms_export | supplier_price_file | parts_book | manual | dealer_upload | oem_portal */
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    licenceId: uuid('licence_id').references(() => contentLicences.id),
    precedence: integer('precedence').notNull().default(50),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    lastLoadedAt: timestamp('last_loaded_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('data_sources_tenant_code_uq').on(t.tenantId, t.code)],
);

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
    dataSourceId: uuid('data_source_id').references(() => dataSources.id),
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

// ---------------------------------------------------------------------------
// Field guidance: licensed manufacturer content aligned to parts and machines
//
// Rules (carried over from v1):
//  - Content is licensed or invisible. Every document hangs off a licence;
//    expired licences hide their content, and only licences that allow it
//    can be packed for offline use or shown to AI agents.
//  - Specs (torques, pressures, capacities) are stored and shown verbatim
//    with their page reference. Nothing is estimated.
//  - Procedures reference parts by normalised number (like supersessions),
//    because manuals cite OEM numbers the dealer may never have stocked.
// ---------------------------------------------------------------------------

export const contentLicences = pgTable('content_licences', {
  id: id(),
  tenantId: tenantId(),
  publisher: text('publisher').notNull(),
  title: text('title').notNull(),
  reference: text('reference'),
  /** dealer_owned | manufacturer_licence | oem_consent | link_only */
  kind: text('kind').notNull().default('manufacturer_licence'),
  /** tenant | platform. Only tenant scope is served until shared-row RLS exists (ADR-0005). */
  scope: text('scope').notNull().default('tenant'),
  /** Where the signed letter / consent email lives. No reference, no licence. */
  permissionRef: text('permission_ref'),
  sourceUrl: text('source_url'),
  contact: text('contact'),
  allowOffline: boolean('allow_offline').notNull().default(false),
  allowAi: boolean('allow_ai').notNull().default(false),
  /** Max days an offline pack may live on a device before it must re-validate. */
  offlineDays: integer('offline_days').notNull().default(14),
  validFrom: date('valid_from'),
  expiresOn: date('expires_on'),
  createdAt: createdAt(),
});

export const machineModels = pgTable(
  'machine_models',
  {
    id: id(),
    tenantId: tenantId(),
    make: text('make').notNull(),
    model: text('model').notNull(),
    series: text('series'),
    kind: text('kind'),
    yearFrom: integer('year_from'),
    yearTo: integer('year_to'),
  },
  (t) => [uniqueIndex('machine_models_tenant_make_model_uq').on(t.tenantId, t.make, t.model)],
);

/** A customer's machine. The engineer's job usually starts from a serial number. */
export const machines = pgTable(
  'machines',
  {
    id: id(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').references(() => customers.id),
    machineModelId: uuid('machine_model_id')
      .notNull()
      .references(() => machineModels.id),
    serial: text('serial').notNull(),
    regNo: text('reg_no'),
    year: integer('year'),
    engineHours: integer('engine_hours'),
    site: text('site'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('machines_tenant_serial_uq').on(t.tenantId, t.serial)],
);

/**
 * Historical sales lines from the dealer's DMS (Ibcos). Separate from
 * sales_orders: this is what was invoiced before AgriParts, used as the parts
 * finder's "what did they buy last time" prior, to infer fitment, and to build
 * the accuracy eval set. Keyed by part number like supersessions, because old
 * lines cite numbers that may have been superseded since.
 */
export const partSalesHistory = pgTable(
  'part_sales_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantId(),
    invoiceRef: text('invoice_ref').notNull(),
    lineNo: integer('line_no').notNull().default(1),
    invoicedOn: date('invoiced_on').notNull(),
    customerId: uuid('customer_id').references(() => customers.id),
    machineId: uuid('machine_id').references(() => machines.id),
    make: text('make').notNull(),
    partNumber: text('part_number').notNull(),
    partNumberNorm: text('part_number_norm').notNull(),
    qty: integer('qty').notNull(),
    netPence: integer('net_pence'),
    batchId: uuid('batch_id').references(() => ingestBatches.id),
  },
  (t) => [
    uniqueIndex('part_sales_history_line_uq').on(t.tenantId, t.invoiceRef, t.lineNo),
    index('part_sales_history_customer_idx').on(t.tenantId, t.customerId, t.invoicedOn),
    index('part_sales_history_part_idx').on(t.tenantId, t.make, t.partNumberNorm),
    index('part_sales_history_machine_idx').on(t.machineId),
  ],
);

export const partFitment = pgTable(
  'part_fitment',
  {
    tenantId: tenantId(),
    machineModelId: uuid('machine_model_id')
      .notNull()
      .references(() => machineModels.id),
    make: text('make').notNull(),
    partNumberNorm: text('part_number_norm').notNull(),
    assembly: text('assembly'),
    qtyPerMachine: integer('qty_per_machine').notNull().default(1),
    /** parts_book | oem_epc | sales_inferred | manual | seed */
    source: text('source').notNull().default('manual'),
    batchId: uuid('batch_id').references(() => ingestBatches.id),
    /** The parts-book page and diagram callout this line came from. */
    documentId: uuid('document_id').references(() => serviceDocuments.id),
    page: integer('page'),
    figureRef: text('figure_ref'),
    /** Serial break: the same model changes parts mid-run. Null = open-ended. */
    serialFrom: text('serial_from'),
    serialTo: text('serial_to'),
    /** 0-100. sales_inferred lines are low until verified. */
    confidence: integer('confidence').notNull().default(100),
    verifiedBy: text('verified_by'),
  },
  (t) => [primaryKey({ columns: [t.machineModelId, t.make, t.partNumberNorm] })],
);

export const serviceDocuments = pgTable(
  'service_documents',
  {
    id: id(),
    tenantId: tenantId(),
    licenceId: uuid('licence_id')
      .notNull()
      .references(() => contentLicences.id),
    make: text('make').notNull(),
    /** workshop_manual | operator_manual | service_bulletin */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    docRef: text('doc_ref').notNull(),
    revision: text('revision'),
    publishedOn: date('published_on'),
    /** Blob-store key of the source PDF (local in dev, R2 in production). */
    fileKey: text('file_key'),
    fileSha256: text('file_sha256'),
    pageCount: integer('page_count'),
    sourceUrl: text('source_url'),
    language: text('language').notNull().default('en'),
    /** uploaded | paged | extracting | in_review | live | withdrawn */
    status: text('status').notNull().default('live'),
    createdAt: createdAt(),
  },
  (t) => [index('service_documents_tenant_idx').on(t.tenantId, t.make), index('service_documents_sha_idx').on(t.tenantId, t.fileSha256)],
);

/**
 * The text layer of every page. Ground truth for the verbatim spec check and
 * the "show me the original page" view. `label` is the page number printed in
 * the manual ("4-12"), which rarely matches the PDF page index.
 */
export const documentPages = pgTable(
  'document_pages',
  {
    tenantId: tenantId(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => serviceDocuments.id, { onDelete: 'cascade' }),
    page: integer('page').notNull(),
    label: text('label'),
    text: text('text').notNull(),
    textSha256: text('text_sha256').notNull(),
    imageKey: text('image_key'),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.page] })],
);

export interface ProcedureSpec {
  label: string;
  /** Verbatim from the source document. */
  value: string;
  unit?: string;
}

export const procedures = pgTable(
  'procedures',
  {
    id: id(),
    tenantId: tenantId(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => serviceDocuments.id),
    /** Null = applies to every model the document covers. */
    machineModelId: uuid('machine_model_id').references(() => machineModels.id),
    code: text('code').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    estMinutes: integer('est_minutes'),
    /** basic | competent | specialist */
    skill: text('skill').notNull().default('competent'),
    pageFrom: integer('page_from'),
    pageTo: integer('page_to'),
    tools: jsonb('tools').$type<string[]>().notNull().default([]),
    safety: jsonb('safety').$type<string[]>().notNull().default([]),
    /**
     * draft | in_review | published | rejected | withdrawn.
     * Only `published` is ever shown to engineers, packs or agents.
     */
    status: text('status').notNull().default('draft'),
    /** extracted | manual_entry | seed */
    origin: text('origin').notNull().default('manual_entry'),
    extractionRunId: uuid('extraction_run_id').references(() => extractionRuns.id),
    /** Result of the deterministic checks (verbatim specs, pages, units). */
    checkReport: jsonb('check_report').$type<CheckReport>(),
    version: integer('version').notNull().default(1),
    verifiedBy: text('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('procedures_tenant_doc_idx').on(t.tenantId, t.documentId), index('procedures_tenant_status_idx').on(t.tenantId, t.status)],
);

export interface CheckIssue {
  severity: 'error' | 'warn';
  code: string;
  message: string;
  stepSeq?: number;
}
export interface CheckReport {
  ok: boolean;
  checkedAt: string;
  issues: CheckIssue[];
}

/** One Claude extraction call (or batch item) over a document page window. */
export const extractionRuns = pgTable(
  'extraction_runs',
  {
    id: id(),
    tenantId: tenantId(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => serviceDocuments.id),
    model: text('model').notNull(),
    /** sync | batch | import (structured output supplied from elsewhere) */
    mode: text('mode').notNull().default('sync'),
    pageFrom: integer('page_from'),
    pageTo: integer('page_to'),
    /** running | succeeded | failed */
    status: text('status').notNull().default('running'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    output: jsonb('output').$type<unknown>(),
    error: text('error'),
    actor: text('actor').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('extraction_runs_doc_idx').on(t.documentId)],
);

/** The foreman's decision on a procedure version. Append-only. */
export const contentReviews = pgTable(
  'content_reviews',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantId(),
    procedureId: uuid('procedure_id')
      .notNull()
      .references(() => procedures.id),
    version: integer('version').notNull(),
    reviewer: text('reviewer').notNull(),
    /** approve | reject | edit | withdraw */
    decision: text('decision').notNull(),
    notes: text('notes'),
    at: createdAt(),
  },
  (t) => [index('content_reviews_proc_idx').on(t.procedureId)],
);

/** An engineer says "this step doesn't match the machine". Open flags send the procedure back for review. */
export const contentFlags = pgTable(
  'content_flags',
  {
    id: id(),
    tenantId: tenantId(),
    procedureId: uuid('procedure_id')
      .notNull()
      .references(() => procedures.id),
    stepSeq: integer('step_seq'),
    flaggedBy: text('flagged_by').notNull(),
    message: text('message').notNull(),
    /** open | resolved | dismissed */
    status: text('status').notNull().default('open'),
    resolution: text('resolution'),
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('content_flags_tenant_status_idx').on(t.tenantId, t.status)],
);

/**
 * Deep links into manufacturer portals (e.g. the OEM's service-information
 * site). We store where to go, never the content: the day-one route for
 * franchise content before written consent (ADR-0004).
 */
export const documentLinks = pgTable(
  'document_links',
  {
    id: id(),
    tenantId: tenantId(),
    make: text('make').notNull(),
    machineModelId: uuid('machine_model_id').references(() => machineModels.id),
    partNumberNorm: text('part_number_norm'),
    label: text('label').notNull(),
    /** May contain {serial} and {partNumber} placeholders. https only. */
    urlTemplate: text('url_template').notNull(),
    portal: text('portal').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('document_links_lookup_idx').on(t.tenantId, t.make)],
);

export const procedureSteps = pgTable(
  'procedure_steps',
  {
    id: id(),
    tenantId: tenantId(),
    procedureId: uuid('procedure_id')
      .notNull()
      .references(() => procedures.id),
    seq: integer('seq').notNull(),
    instruction: text('instruction').notNull(),
    page: integer('page'),
    specs: jsonb('specs').$type<ProcedureSpec[]>().notNull().default([]),
    caution: text('caution'),
  },
  (t) => [uniqueIndex('procedure_steps_proc_seq_uq').on(t.procedureId, t.seq)],
);

export const procedureParts = pgTable(
  'procedure_parts',
  {
    tenantId: tenantId(),
    procedureId: uuid('procedure_id')
      .notNull()
      .references(() => procedures.id),
    make: text('make').notNull(),
    partNumberNorm: text('part_number_norm').notNull(),
    /** replaced | consumable | may_need */
    role: text('role').notNull().default('replaced'),
    qty: integer('qty').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.procedureId, t.make, t.partNumberNorm] }),
    index('procedure_parts_lookup_idx').on(t.tenantId, t.make, t.partNumberNorm),
  ],
);

/** Every offline pack issued to a device: who, what, until when. Publishers ask for this. */
export const guidancePacks = pgTable(
  'guidance_packs',
  {
    id: id(),
    tenantId: tenantId(),
    packRef: text('pack_ref').notNull(),
    issuedTo: text('issued_to').notNull(),
    machineId: uuid('machine_id').references(() => machines.id),
    jobRef: text('job_ref'),
    partNumbers: jsonb('part_numbers').$type<string[]>().notNull().default([]),
    procedureIds: jsonb('procedure_ids').$type<string[]>().notNull().default([]),
    contentHash: text('content_hash').notNull(),
    issuedAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('guidance_packs_tenant_ref_uq').on(t.tenantId, t.packRef)],
);

// ---------------------------------------------------------------- parts finder (ADR-0003)

/** What the agent proposes for one candidate part. Evidence is computed from our data, never by the model. */
export interface EnquiryEvidence {
  /** parts_book | supersession | history | described | number | equivalent | manual | machine */
  kind: string;
  text: string;
  ref?: string;
}
export interface EnquiryCandidate {
  make: string;
  partNumber: string;
  description: string;
  /** best | option | alternative | ruled_out */
  role: string;
  why: string;
  evidence: EnquiryEvidence[];
  requested?: string | null;
  superseded?: boolean;
  straightSwap?: boolean;
  warning?: string | null;
  unitNetPence?: number | null;
  priceBasis?: string | null;
  stock?: { depot: string; available: number }[];
  guide?: { procedureId: string; code: string; title: string; pages: string | null; estMinutes: number | null } | null;
  /** Service bulletins that mention this part. */
  bulletins?: { code: string; title: string; summary: string | null }[];
  /** Consumables and likely extras from the fitting procedure. */
  withIt?: { make: string; partNumber: string; description: string | null; role: string; qty: number }[];
  safetyCritical?: boolean;
}
export interface EnquiryResult {
  engine: 'claude' | 'claude-local' | 'rules';
  /** high | medium | low */
  confidence: string;
  /** Draft reply for the parts person to send (or edit). */
  reply: string;
  question: string | null;
  candidates: EnquiryCandidate[];
  escalate: { reason: string; urgency: string } | null;
  notes: string[];
  at: string;
}

/**
 * A customer enquiry: "I need the oil filter for the 165". The case the
 * parts agent works on, and the callback queue when it hands over.
 */
export const enquiries = pgTable(
  'enquiries',
  {
    id: id(),
    tenantId: tenantId(),
    ref: text('ref').notNull(),
    /** counter | phone | whatsapp | email | web */
    channel: text('channel').notNull().default('counter'),
    customerId: uuid('customer_id').references(() => customers.id),
    contactName: text('contact_name'),
    machineId: uuid('machine_id').references(() => machines.id),
    subject: text('subject').notNull(),
    /** open | waiting_customer | callback | resolved | closed */
    status: text('status').notNull().default('open'),
    /** normal | vor (vehicle off road: machine stopped) */
    priority: text('priority').notNull().default('normal'),
    assignedTo: text('assigned_to'),
    callbackDueAt: timestamp('callback_due_at', { withTimezone: true }),
    callbackReason: text('callback_reason'),
    agentRounds: integer('agent_rounds').notNull().default(0),
    result: jsonb('result').$type<EnquiryResult>(),
    resolvedMake: text('resolved_make'),
    resolvedPartNumberNorm: text('resolved_part_number_norm'),
    resolution: text('resolution'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('enquiries_ref_uq').on(t.tenantId, t.ref), index('enquiries_status_idx').on(t.tenantId, t.status, t.updatedAt)],
);

export const enquiryMessages = pgTable(
  'enquiry_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantId(),
    enquiryId: uuid('enquiry_id')
      .notNull()
      .references(() => enquiries.id, { onDelete: 'cascade' }),
    /** customer | staff | agent | system */
    role: text('role').notNull(),
    body: text('body').notNull(),
    author: text('author'),
    createdAt: createdAt(),
  },
  (t) => [index('enquiry_messages_enquiry_idx').on(t.enquiryId, t.id)],
);
