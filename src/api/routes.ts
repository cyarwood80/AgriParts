import type { FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ingestBatches, ingestIssues, webhookSubscriptions } from '../db/schema.js';
import { importLegacyFile, LegacyImportSchema } from '../integrations/legacy-import/ibcos-bridge.js';
import { FitmentImportSchema, importFitment, inferFitmentFromSales } from '../integrations/parts-books/fitment-import.js';
import { importPriceFile } from '../integrations/price-files/import.js';
import {
  addDocumentLink, DocumentLinkSchema, editStep, ExtractedDocumentSchema, flagStep, getDocumentFile, getPage, listDocuments,
  RegisterDocumentSchema, registerDocument, reviewDetail, reviewProcedure, reviewQueue, StepEditSchema, storePages, submitExtraction,
} from '../services/content.js';
import { listDataSources } from '../services/data-sources.js';
import {
  addCustomerMessage, getEnquiry, listEnquiries, OpenEnquirySchema, openEnquiry, requestCallback, resolveEnquiry, sendReply,
} from '../services/parts-finder.js';
import { deliveryStats, listEvents, newWebhookSecret } from '../integrations/webhooks/dispatcher.js';
import { AppError } from '../lib/errors.js';
import { customerSummary, listBackorders, searchCustomers } from '../services/customers.js';
import { guidanceForPart, issueJobPack, listPacks, machineDetail, packStatus, searchMachines } from '../services/guidance.js';
import { deadStock, rebalanceSuggestions, reorderSuggestions } from '../services/insights.js';
import { getCustomerByAccount, listDepots } from '../services/lookups.js';
import { cancelOrder, confirmOrder, createQuote, getOrder, invoiceOrder, listOrders } from '../services/orders.js';
import { partDetail, resolvePart, searchParts } from '../services/parts.js';
import { priceFor } from '../services/pricing.js';
import { createPurchaseOrder, getPurchaseOrder, receivePurchaseOrder, sendPurchaseOrder } from '../services/purchasing.js';
import { adjustStock, partMovements, reconcileLedger, transferStock } from '../services/stock.js';
import type { App, AppDeps } from './app.js';

const svc = (req: FastifyRequest) => req.svc!;
const make = z.string().optional();
const lineSchema = z.object({ partNumber: z.string().min(1), make, qty: z.number().int().positive() });

export async function registerRoutes(app: App, deps: AppDeps) {
  // ---------------------------------------------------------------- parts
  app.get('/v1/parts', {
    schema: { tags: ['parts'], summary: 'Search parts by number, barcode or description', querystring: z.object({ q: z.string().min(2), make, limit: z.coerce.number().int().min(1).max(100).default(20) }) },
  }, (req) => searchParts(svc(req), { query: req.query.q, make: req.query.make, limit: req.query.limit }));

  app.get('/v1/parts/resolve', {
    schema: { tags: ['parts'], summary: 'Resolve a part number through supersessions; stock and equivalents', querystring: z.object({ partNumber: z.string(), make }) },
  }, (req) => partDetail(svc(req), { partNumber: req.query.partNumber, make: req.query.make }));

  app.get('/v1/parts/:make/:partNumber/movements', {
    schema: { tags: ['stock'], summary: 'Stock ledger for a part (latest first)', params: z.object({ make: z.string(), partNumber: z.string() }), querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }) },
  }, async (req) => {
    const r = await resolvePart(svc(req), { partNumber: req.params.partNumber, make: req.params.make });
    return partMovements(svc(req), r.part.id, req.query.limit);
  });

  app.get('/v1/depots', { schema: { tags: ['parts'], summary: 'List depots' } }, async (req) => {
    svc(req).require('parts:read');
    return listDepots(svc(req));
  });

  // ---------------------------------------------------------------- pricing
  app.get('/v1/prices', {
    schema: { tags: ['pricing'], summary: 'Price a part for a customer account', querystring: z.object({ partNumber: z.string(), make, customer: z.string() }) },
  }, async (req) => {
    const ctx = svc(req);
    ctx.require('customers:read');
    const r = await resolvePart(ctx, { partNumber: req.query.partNumber, make: req.query.make });
    const price = await priceFor(ctx, r.part, await getCustomerByAccount(ctx, req.query.customer));
    return { part: { make: r.part.make, partNumber: r.part.partNumber, description: r.part.description }, superseded: r.superseded, warning: r.warning, ...price };
  });

  // ---------------------------------------------------------------- stock
  app.post('/v1/stock/adjustments', {
    schema: {
      tags: ['stock'], summary: 'Adjust stock (count or delta)',
      body: z.object({ partNumber: z.string(), make, depotCode: z.string(), countedQty: z.number().int().min(0).optional(), delta: z.number().int().optional(), reason: z.string().min(3) }),
    },
  }, async (req, reply) => reply.status(201).send(await adjustStock(svc(req), req.body)));

  app.post('/v1/stock/transfers', {
    schema: {
      tags: ['stock'], summary: 'Transfer stock between depots',
      body: z.object({ partNumber: z.string(), make, fromDepotCode: z.string(), toDepotCode: z.string(), qty: z.number().int().positive(), reason: z.string().optional() }),
    },
  }, async (req, reply) => reply.status(201).send(await transferStock(svc(req), req.body)));

  app.get('/v1/stock/reconcile', { schema: { tags: ['stock'], summary: 'Ledger integrity check (should return [])' } }, async (req) => {
    svc(req).require('stock:read');
    return reconcileLedger(svc(req));
  });

  // ---------------------------------------------------------------- customers
  app.get('/v1/customers', {
    schema: { tags: ['customers'], summary: 'Search customers', querystring: z.object({ q: z.string().min(2) }) },
  }, (req) => searchCustomers(svc(req), req.query.q));

  app.get('/v1/customers/:accountCode', {
    schema: { tags: ['customers'], summary: 'Customer summary', params: z.object({ accountCode: z.string() }) },
  }, (req) => customerSummary(svc(req), req.params.accountCode));

  // ---------------------------------------------------------------- sales
  app.get('/v1/sales-orders', {
    schema: { tags: ['sales'], summary: 'List sales orders', querystring: z.object({ customer: z.string().optional(), status: z.enum(['quote', 'confirmed', 'part_invoiced', 'invoiced', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(200).default(25) }) },
  }, (req) => listOrders(svc(req), { customerAccount: req.query.customer, status: req.query.status, limit: req.query.limit }));

  app.post('/v1/sales-orders', {
    schema: {
      tags: ['sales'], summary: 'Create a quote (no stock effect)',
      body: z.object({ customerAccount: z.string(), depotCode: z.string(), lines: z.array(lineSchema).min(1).max(200), customerRef: z.string().optional(), notes: z.string().optional(), channel: z.string().optional() }),
    },
  }, async (req, reply) => reply.status(201).send(await createQuote(svc(req), req.body)));

  const orderParam = { params: z.object({ order: z.string().describe('Order number (SO-000123) or id') }) };
  app.get('/v1/sales-orders/:order', { schema: { tags: ['sales'], summary: 'Get order', ...orderParam } }, (req) => getOrder(svc(req), req.params.order));
  app.post('/v1/sales-orders/:order/confirm', { schema: { tags: ['sales'], summary: 'Confirm quote: allocate stock, backorder shortfall', ...orderParam } }, (req) => confirmOrder(svc(req), req.params.order));
  app.post('/v1/sales-orders/:order/invoice', { schema: { tags: ['sales'], summary: 'Invoice allocated quantities', ...orderParam } }, (req) => invoiceOrder(svc(req), req.params.order));
  app.post('/v1/sales-orders/:order/cancel', {
    schema: { tags: ['sales'], summary: 'Cancel outstanding quantities', ...orderParam, body: z.object({ reason: z.string().min(3) }) },
  }, (req) => cancelOrder(svc(req), req.params.order, req.body.reason));

  app.get('/v1/backorders', {
    schema: { tags: ['sales'], summary: 'Customer lines waiting for stock', querystring: z.object({ depot: z.string().optional() }) },
  }, (req) => listBackorders(svc(req), { depotCode: req.query.depot }));

  // ---------------------------------------------------------------- purchasing
  app.post('/v1/purchase-orders', {
    schema: {
      tags: ['purchasing'], summary: 'Create draft purchase order',
      body: z.object({ supplierCode: z.string(), depotCode: z.string(), orderType: z.enum(['stock', 'vor']).optional(), lines: z.array(lineSchema.extend({ unitCostPence: z.number().int().min(0).optional() })).min(1).max(500) }),
    },
  }, async (req, reply) => reply.status(201).send(await createPurchaseOrder(svc(req), req.body)));

  const poParam = { params: z.object({ po: z.string().describe('PO number (PO-000123) or id') }) };
  app.get('/v1/purchase-orders/:po', { schema: { tags: ['purchasing'], summary: 'Get purchase order', ...poParam } }, (req) => getPurchaseOrder(svc(req), req.params.po));
  app.post('/v1/purchase-orders/:po/send', { schema: { tags: ['purchasing'], summary: "Send via the supplier's ordering adapter", ...poParam } }, (req) => sendPurchaseOrder(svc(req), req.params.po, deps.ordering));
  app.post('/v1/purchase-orders/:po/receive', {
    schema: { tags: ['purchasing'], summary: 'Book in goods; allocates waiting backorders', ...poParam, body: z.object({ all: z.boolean().optional(), lines: z.array(lineSchema).optional() }) },
  }, (req) => receivePurchaseOrder(svc(req), req.params.po, req.body));

  // ---------------------------------------------------------------- insights
  const insightQuery = z.object({ depot: z.string().optional(), supplier: z.string().optional(), lookbackDays: z.coerce.number().int().min(7).max(730).optional(), coverDays: z.coerce.number().int().min(1).max(180).optional() });
  app.get('/v1/insights/reorder', { schema: { tags: ['insights'], summary: 'Reorder suggestions with reasoning', querystring: insightQuery } }, (req) =>
    reorderSuggestions(svc(req), { depotCode: req.query.depot, supplierCode: req.query.supplier, lookbackDays: req.query.lookbackDays, coverDays: req.query.coverDays }));
  app.get('/v1/insights/rebalance', { schema: { tags: ['insights'], summary: 'Inter-depot transfer suggestions', querystring: insightQuery } }, (req) =>
    rebalanceSuggestions(svc(req), { lookbackDays: req.query.lookbackDays, coverDays: req.query.coverDays }));
  app.get('/v1/insights/dead-stock', {
    schema: { tags: ['insights'], summary: 'Dead stock valued at cost', querystring: z.object({ depot: z.string().optional(), days: z.coerce.number().int().min(30).max(1095).default(365) }) },
  }, (req) => deadStock(svc(req), { depotCode: req.query.depot, days: req.query.days }));

  // ---------------------------------------------------------------- field guidance
  app.get('/v1/machines', {
    schema: { tags: ['guidance'], summary: 'Find customer machines by serial, reg, model or customer', querystring: z.object({ q: z.string().min(2) }) },
  }, (req) => searchMachines(svc(req), req.query.q));

  app.get('/v1/machines/:serial', {
    schema: { tags: ['guidance'], summary: 'Machine, its fitted parts and which have licensed guidance', params: z.object({ serial: z.string() }) },
  }, (req) => machineDetail(svc(req), req.params.serial));

  app.get('/v1/guidance', {
    schema: {
      tags: ['guidance'], summary: 'Licensed fitting procedures for a part (follows supersessions), optionally for a machine',
      querystring: z.object({ partNumber: z.string(), make, serial: z.string().optional() }),
    },
  }, (req) => guidanceForPart(svc(req), { partNumber: req.query.partNumber, make: req.query.make, serial: req.query.serial }));

  app.post('/v1/guidance/packs', {
    schema: {
      tags: ['guidance'], summary: 'Issue an offline job pack (machine + parts + licensed procedures); audited, expires',
      body: z.object({ serial: z.string(), jobRef: z.string().max(60).optional(), parts: z.array(z.object({ partNumber: z.string().min(1), make })).min(1).max(30) }),
    },
  }, async (req, reply) => reply.status(201).send(await issueJobPack(svc(req), req.body)));

  app.get('/v1/guidance/packs', {
    schema: { tags: ['guidance'], summary: 'Recently issued offline packs', querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }) },
  }, (req) => listPacks(svc(req), req.query.limit));

  app.get('/v1/guidance/packs/:packRef', {
    schema: { tags: ['guidance'], summary: 'Is an offline pack still valid? (devices check when back online)', params: z.object({ packRef: z.string() }) },
  }, (req) => packStatus(svc(req), req.params.packRef));

  // ---------------------------------------------------------------- content pipeline (ADR-0005)
  const pageSchema = z.object({ page: z.number().int().min(1), text: z.string(), label: z.string().nullable().optional() });

  app.get('/v1/documents', { schema: { tags: ['content'], summary: 'Licensed documents with procedure counts by status' } }, (req) => listDocuments(svc(req)));

  app.post('/v1/documents', {
    schema: {
      tags: ['content'], summary: 'Register a licensed document: metadata, PDF (base64, optional) and page text (optional)',
      body: z.object({ meta: RegisterDocumentSchema, pdfBase64: z.string().optional(), pages: z.array(pageSchema).max(2000).optional() }),
    },
  }, async (req, reply) => {
    const pdf = req.body.pdfBase64 ? new Uint8Array(Buffer.from(req.body.pdfBase64, 'base64')) : undefined;
    if (pdf && Buffer.from(pdf.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new AppError('VALIDATION', 'pdfBase64 is not a PDF');
    const r = await registerDocument(svc(req), { meta: req.body.meta, pdf, pages: req.body.pages });
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });

  app.put('/v1/documents/:id/pages', {
    schema: { tags: ['content'], summary: 'Replace a document\'s page text (ground truth for verbatim checks)', params: z.object({ id: z.uuid() }), body: z.object({ pages: z.array(pageSchema).min(1).max(2000) }) },
  }, (req) => storePages(svc(req), req.params.id, req.body.pages));

  app.get('/v1/documents/:id/pages/:page', {
    schema: { tags: ['content'], summary: 'One page of a licensed document (text layer)', params: z.object({ id: z.uuid(), page: z.coerce.number().int().min(1) }) },
  }, (req) => getPage(svc(req), req.params.id, req.params.page));

  app.get('/v1/documents/:id/file', {
    schema: { tags: ['content'], summary: 'The source PDF (licence-checked, audited). Open at #page=N', params: z.object({ id: z.uuid() }) },
  }, async (req, reply) => {
    const f = await getDocumentFile(svc(req), req.params.id);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${f.filename}"`).header('cache-control', 'private, no-store');
    return reply.send(Buffer.from(f.data));
  });

  app.post('/v1/documents/:id/extractions', {
    schema: {
      tags: ['content'], summary: 'Submit an extraction (from Claude or keyed by hand); creates draft procedures with check reports',
      params: z.object({ id: z.uuid() }),
      body: z.object({
        extraction: ExtractedDocumentSchema,
        run: z.object({
          model: z.string(), mode: z.enum(['sync', 'batch', 'import']), pageFrom: z.number().int().nullable().optional(), pageTo: z.number().int().nullable().optional(),
          inputTokens: z.number().int().nullable().optional(), outputTokens: z.number().int().nullable().optional(), cacheReadTokens: z.number().int().nullable().optional(),
        }).optional(),
      }),
    },
  }, (req) => submitExtraction(svc(req), { documentId: req.params.id, extraction: req.body.extraction, run: req.body.run }));

  app.get('/v1/content/review-queue', {
    schema: { tags: ['content'], summary: 'Procedures awaiting the foreman: drafts, in review, and live ones with open flags', querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
  }, (req) => reviewQueue(svc(req), req.query.limit));

  app.get('/v1/procedures/:id/review', {
    schema: { tags: ['content'], summary: 'Review screen: steps, check report, cited page text, flags and history', params: z.object({ id: z.uuid() }) },
  }, (req) => reviewDetail(svc(req), req.params.id));

  app.patch('/v1/procedures/:id/steps/:seq', {
    schema: {
      tags: ['content'], summary: 'Fix a step; re-runs checks and sends the procedure back to review',
      params: z.object({ id: z.uuid(), seq: z.coerce.number().int().min(1) }), body: StepEditSchema.extend({ notes: z.string().optional() }),
    },
  }, (req) => {
    const { notes, ...edit } = req.body;
    return editStep(svc(req), req.params.id, req.params.seq, edit, notes);
  });

  app.post('/v1/procedures/:id/review', {
    schema: {
      tags: ['content'], summary: 'Foreman decision: approve (publish), reject or withdraw',
      params: z.object({ id: z.uuid() }), body: z.object({ decision: z.enum(['approve', 'reject', 'withdraw']), notes: z.string().max(2000).optional() }),
    },
  }, (req) => reviewProcedure(svc(req), req.params.id, req.body));

  app.post('/v1/procedures/:id/flags', {
    schema: {
      tags: ['content'], summary: 'Engineer flags a step that doesn\'t match the machine',
      params: z.object({ id: z.uuid() }), body: z.object({ stepSeq: z.number().int().min(1).optional(), message: z.string().min(1).max(2000) }),
    },
  }, async (req, reply) => {
    reply.code(201);
    return flagStep(svc(req), req.params.id, req.body);
  });

  app.post('/v1/content/links', {
    schema: { tags: ['content'], summary: 'Add a manufacturer-portal deep link (we store the link, never the content)', body: DocumentLinkSchema },
  }, async (req, reply) => {
    reply.code(201);
    return addDocumentLink(svc(req), req.body);
  });

  // ---------------------------------------------------------------- parts finder (ADR-0003)
  app.get('/v1/enquiries', {
    schema: { tags: ['parts-finder'], summary: 'Enquiry queue: stopped machines first, then callbacks by due time', querystring: z.object({ include: z.enum(['active', 'all']).default('active') }) },
  }, (req) => listEnquiries(svc(req), { include: req.query.include }));

  app.post('/v1/enquiries', {
    schema: { tags: ['parts-finder'], summary: 'Open an enquiry from what the customer said; the parts agent takes the first turn', body: OpenEnquirySchema },
  }, async (req, reply) => {
    reply.code(201);
    return openEnquiry(svc(req), req.body);
  });

  app.get('/v1/enquiries/:id', {
    schema: { tags: ['parts-finder'], summary: "Enquiry with conversation, machine and the agent's checked candidates", params: z.object({ id: z.uuid() }) },
  }, (req) => getEnquiry(svc(req), req.params.id));

  app.post('/v1/enquiries/:id/messages', {
    schema: { tags: ['parts-finder'], summary: 'Record what the customer said next; the agent takes another turn', params: z.object({ id: z.uuid() }), body: z.object({ body: z.string().min(1).max(4000) }) },
  }, (req) => addCustomerMessage(svc(req), req.params.id, req.body.body));

  app.post('/v1/enquiries/:id/replies', {
    schema: { tags: ['parts-finder'], summary: "Send a reply to the customer (the agent's draft, edited or not)", params: z.object({ id: z.uuid() }), body: z.object({ body: z.string().min(1).max(4000) }) },
  }, (req) => sendReply(svc(req), req.params.id, req.body.body));

  app.post('/v1/enquiries/:id/callback', {
    schema: { tags: ['parts-finder'], summary: 'Hand over to a person: 15 minutes for a stopped machine, otherwise 1 hour', params: z.object({ id: z.uuid() }), body: z.object({ reason: z.string().min(3).max(500), assignee: z.string().max(80).optional() }) },
  }, (req) => requestCallback(svc(req), req.params.id, req.body));

  app.post('/v1/enquiries/:id/resolve', {
    schema: { tags: ['parts-finder'], summary: 'Close with the part that was right; teaches fitment for the machine model', params: z.object({ id: z.uuid() }), body: z.object({ partNumber: z.string().min(1), make: z.string().optional(), notes: z.string().max(1000).optional() }) },
  }, (req) => resolveEnquiry(svc(req), req.params.id, req.body));

  // ---------------------------------------------------------------- integrations
  app.get('/v1/integrations/sources', { schema: { tags: ['integrations'], summary: 'Registered data sources with load history' } }, (req) => listDataSources(svc(req)));

  app.post('/v1/integrations/fitment', {
    schema: {
      tags: ['integrations'], summary: 'Import fitment from a licensed parts book / EPC export (dry run recommended first)',
      body: z.object({ options: FitmentImportSchema, content: z.string().min(1), sourceName: z.string().min(1), dryRun: z.boolean().default(true) }),
    },
  }, (req) => importFitment(svc(req), req.body));

  app.post('/v1/integrations/fitment/infer', {
    schema: { tags: ['integrations'], summary: 'Propose unverified fitment from sales history', body: z.object({ minInvoices: z.number().int().min(2).max(50).default(3) }) },
  }, (req) => inferFitmentFromSales(svc(req), req.body));

  app.post('/v1/integrations/price-files', {
    schema: {
      tags: ['integrations'], summary: 'Import a supplier price file (dry run recommended first)',
      body: z.object({ mapping: z.record(z.string(), z.unknown()), content: z.string().min(1), sourceName: z.string().min(1), dryRun: z.boolean().default(true) }),
    },
  }, (req) => importPriceFile(svc(req), req.body));

  app.post('/v1/integrations/ibcos/import', {
    schema: {
      tags: ['integrations'], summary: 'Import an Ibcos Gold export (customers, parts, stock, machines or sales history)',
      body: z.object({ options: LegacyImportSchema, content: z.string().min(1), sourceName: z.string().min(1), dryRun: z.boolean().default(true) }),
    },
  }, (req) => importLegacyFile(svc(req), req.body));

  app.get('/v1/integrations/batches', {
    schema: { tags: ['integrations'], summary: 'Recent import batches (provenance)', querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }) },
  }, async (req) => {
    svc(req).require('integrations:write');
    return req.svc!.db.select().from(ingestBatches).where(eq(ingestBatches.tenantId, svc(req).tenantId)).orderBy(desc(ingestBatches.startedAt)).limit(req.query.limit);
  });

  app.get('/v1/integrations/batches/:id/issues', {
    schema: { tags: ['integrations'], summary: 'Row-level issues for a batch', params: z.object({ id: z.uuid() }) },
  }, async (req) => {
    svc(req).require('integrations:write');
    return req.svc!.db.select().from(ingestIssues).where(and(eq(ingestIssues.tenantId, svc(req).tenantId), eq(ingestIssues.batchId, req.params.id))).orderBy(ingestIssues.rowNo);
  });

  app.get('/v1/integrations/ordering-adapters', { schema: { tags: ['integrations'], summary: 'Available supplier ordering adapters' } }, async () => deps.ordering.list());

  // ---------------------------------------------------------------- events & webhooks
  app.get('/v1/events', {
    schema: { tags: ['events'], summary: 'Event feed after a cursor (pull alternative to webhooks)', querystring: z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }) },
  }, async (req) => {
    svc(req).require('webhooks:manage');
    const events = await listEvents(req.svc!.db, svc(req).tenantId, req.query.after, req.query.limit);
    return { events, nextCursor: events.at(-1)?.id ?? req.query.after };
  });

  app.post('/v1/webhooks', {
    schema: { tags: ['events'], summary: 'Subscribe a URL to events (secret returned once)', body: z.object({ url: z.url().refine((u) => u.startsWith('https://') || u.startsWith('http://localhost'), 'https required'), eventTypes: z.array(z.string()).min(1) }) },
  }, async (req, reply) => {
    const ctx = svc(req);
    ctx.require('webhooks:manage');
    const secret = newWebhookSecret();
    const [row] = await ctx.db.insert(webhookSubscriptions).values({ tenantId: ctx.tenantId, url: req.body.url, eventTypes: req.body.eventTypes, secret }).returning();
    return reply.status(201).send({ id: row!.id, url: row!.url, eventTypes: row!.eventTypes, secret, note: 'Store the secret now; it is not shown again. Verify AgriParts-Signature on every delivery.' });
  });

  app.get('/v1/webhooks', { schema: { tags: ['events'], summary: 'List webhook subscriptions and delivery health' } }, async (req) => {
    const ctx = svc(req);
    ctx.require('webhooks:manage');
    const subs = await ctx.db.select({ id: webhookSubscriptions.id, url: webhookSubscriptions.url, eventTypes: webhookSubscriptions.eventTypes, isActive: webhookSubscriptions.isActive }).from(webhookSubscriptions).where(eq(webhookSubscriptions.tenantId, ctx.tenantId));
    return { subscriptions: subs, deliveries: await deliveryStats(ctx.db, ctx.tenantId) };
  });

  app.delete('/v1/webhooks/:id', { schema: { tags: ['events'], summary: 'Deactivate a subscription', params: z.object({ id: z.uuid() }) } }, async (req) => {
    const ctx = svc(req);
    ctx.require('webhooks:manage');
    const r = await ctx.db.update(webhookSubscriptions).set({ isActive: false }).where(and(eq(webhookSubscriptions.tenantId, ctx.tenantId), eq(webhookSubscriptions.id, req.params.id))).returning();
    if (!r.length) throw new AppError('NOT_FOUND', 'Webhook subscription not found');
    return { ok: true };
  });
}
