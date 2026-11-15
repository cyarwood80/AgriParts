/**
 * Accounting connectors. AgriParts owns parts, stock and sales; the dealer's
 * ledger stays where it is (Xero, Sage, or Ibcos Gold itself during a
 * pilot). Connectors consume `invoice.created` from the outbox and post it.
 */
export interface InvoiceCreatedPayload {
  invoiceNumber: string;
  orderNumber: string;
  customerRef: string | null;
  customer: { accountCode: string; name: string; email: string | null; accountingRef: string | null };
  issuedAt: string;
  dueDate: string;
  netPence: number;
  vatPence: number;
  grossPence: number;
  lines: { partNumber: string; make: string; description: string; qty: number; unitNetPence: number; lineNetPence: number; vatRateBps: number; lineVatPence: number }[];
}

export interface AccountingResult {
  externalId: string | null;
  detail?: Record<string, unknown>;
}

export interface AccountingAdapter {
  readonly id: string;
  pushInvoice(invoice: InvoiceCreatedPayload, config: Record<string, unknown>): Promise<AccountingResult>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;
