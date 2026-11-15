import type { AccountingAdapter, FetchLike, InvoiceCreatedPayload } from './types.js';

/**
 * Xero (UK) sales invoices via the Accounting API.
 *
 * Config:
 *   xeroTenantId     – the organisation's tenant id from the Xero connection
 *   salesAccountCode – revenue account for parts sales (e.g. "200")
 *   status           – "DRAFT" (default; accounts team approves) or "AUTHORISED"
 * Token: supplied by a TokenProvider (OAuth 2.0 refresh handled outside the
 * adapter). The connect/consent flow is on the roadmap; until then a token
 * can be injected for a pilot.
 */
export type TokenProvider = (config: Record<string, unknown>) => Promise<string>;

const XERO_TAX_TYPE: Record<number, string> = {
  2000: 'OUTPUT2', // 20% VAT on income
  500: 'RROUTPUT', // 5% reduced rate
  0: 'ZERORATEDOUTPUT',
};

const pounds = (pence: number) => Math.round(pence) / 100;

export function buildXeroInvoice(inv: InvoiceCreatedPayload, config: Record<string, unknown>) {
  const contact = inv.customer.accountingRef
    ? { ContactID: inv.customer.accountingRef }
    : { ContactNumber: inv.customer.accountCode, Name: inv.customer.name, ...(inv.customer.email ? { EmailAddress: inv.customer.email } : {}) };
  return {
    Invoices: [
      {
        Type: 'ACCREC',
        Contact: contact,
        InvoiceNumber: inv.invoiceNumber,
        Reference: inv.customerRef ?? inv.orderNumber,
        Date: inv.issuedAt.slice(0, 10),
        DueDate: inv.dueDate,
        LineAmountTypes: 'Exclusive',
        Status: (config.status as string | undefined) ?? 'DRAFT',
        CurrencyCode: 'GBP',
        LineItems: inv.lines.map((l) => ({
          Description: l.description,
          Quantity: l.qty,
          UnitAmount: pounds(l.unitNetPence),
          AccountCode: (config.salesAccountCode as string | undefined) ?? '200',
          TaxType: XERO_TAX_TYPE[l.vatRateBps] ?? 'OUTPUT2',
          ...(config.trackItems ? { ItemCode: l.partNumber } : {}),
        })),
      },
    ],
  };
}

export function createXeroAdapter(deps: { fetch: FetchLike; getToken: TokenProvider; baseUrl?: string }): AccountingAdapter {
  const base = deps.baseUrl ?? 'https://api.xero.com/api.xro/2.0';
  return {
    id: 'xero',
    async pushInvoice(inv, config) {
      if (!config.xeroTenantId) throw new Error('Xero connection missing xeroTenantId');
      const token = await deps.getToken(config);
      const res = await deps.fetch(`${base}/Invoices`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'xero-tenant-id': String(config.xeroTenantId),
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // Retries of the same invoice must not create duplicates in the ledger.
          'Idempotency-Key': `agriparts-${inv.invoiceNumber}`,
        },
        body: JSON.stringify(buildXeroInvoice(inv, config)),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Xero ${res.status}: ${text.slice(0, 500)}`);
      const body = JSON.parse(text) as { Invoices?: { InvoiceID?: string }[] };
      return { externalId: body.Invoices?.[0]?.InvoiceID ?? null };
    },
  };
}

/** Development stand-in: records what would have been posted. */
export function createLogAccountingAdapter(): AccountingAdapter & { posted: InvoiceCreatedPayload[] } {
  const posted: InvoiceCreatedPayload[] = [];
  return {
    id: 'log',
    posted,
    async pushInvoice(inv) {
      posted.push(inv);
      return { externalId: `LOG-${inv.invoiceNumber}` };
    },
  };
}
