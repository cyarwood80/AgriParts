/**
 * Supplier ordering adapters: how a purchase order leaves the building.
 *
 * Every manufacturer/supplier does this differently (OEM dealer portals,
 * allmakes APIs, EDI, emailed spreadsheets, a phone call). The platform only
 * ever talks to this interface; each route is an adapter.
 */
export interface OutboundPurchaseOrder {
  /** Our PO number. Adapters must send it as the supplier-side reference so retries can be de-duplicated. */
  number: string;
  orderType: 'stock' | 'vor';
  depot: { code: string; name: string };
  supplier: { code: string; name: string; accountRef: string | null };
  lines: { lineId: string; make: string; partNumber: string; description: string; qty: number; unitCostPence: number }[];
}

export interface SubmitResult {
  externalRef: string | null;
  acceptedLineIds: string[];
  rejected: { lineId: string; reason: string }[];
  /** Artefact for manual routes (e.g. CSV body to email/upload). */
  document?: { filename: string; contentType: string; body: string };
  /** Free-form adapter detail, stored on the integration run. */
  detail?: Record<string, unknown>;
}

export interface SupplierOrderingAdapter {
  readonly id: string;
  readonly description: string;
  submit(po: OutboundPurchaseOrder, config: Record<string, unknown>): Promise<SubmitResult>;
}
