import { randomUUID } from 'node:crypto';
import { toCsv } from '../../lib/csv.js';
import type { OutboundPurchaseOrder, SubmitResult, SupplierOrderingAdapter } from './types.js';

/** Dealer orders by phone or portal by hand; we just record that it was sent. */
export const manualAdapter: SupplierOrderingAdapter = {
  id: 'manual',
  description: 'Record the order as sent; staff place it by phone or portal.',
  async submit(po) {
    return { externalRef: null, acceptedLineIds: po.lines.map((l) => l.lineId), rejected: [] };
  },
};

/**
 * Produce the order as a CSV for emailing or uploading to a supplier portal.
 * The universal fallback: nearly every supplier accepts a spreadsheet.
 * Config: { columns?: string[] } to match a supplier's template order.
 */
export const csvExportAdapter: SupplierOrderingAdapter = {
  id: 'csv-export',
  description: 'Generate a CSV order file for email or portal upload.',
  async submit(po, config) {
    const header = (config.columns as string[] | undefined) ?? ['OrderRef', 'Account', 'OrderType', 'PartNumber', 'Description', 'Qty'];
    const rows = po.lines.map((l) => {
      const values: Record<string, string | number> = {
        OrderRef: po.number,
        Account: po.supplier.accountRef ?? '',
        OrderType: po.orderType === 'vor' ? 'VOR' : 'STOCK',
        PartNumber: l.partNumber,
        Description: l.description,
        Qty: l.qty,
        Make: l.make,
        Depot: po.depot.code,
      };
      return header.map((h) => values[h] ?? '');
    });
    return {
      externalRef: null,
      acceptedLineIds: po.lines.map((l) => l.lineId),
      rejected: [],
      document: { filename: `${po.number}.csv`, contentType: 'text/csv', body: toCsv([header, ...rows]) },
    };
  },
};

/**
 * Simulated OEM ordering API, for demos and tests. Behaves like the real ones
 * we expect to integrate: accepts known lines, rejects unknown/obsolete numbers,
 * returns a supplier order reference, de-duplicates on our PO number.
 * Config: { rejectPartNumbers?: string[], fail?: boolean }
 */
export function createMockOemAdapter(): SupplierOrderingAdapter & { received: OutboundPurchaseOrder[] } {
  const seen = new Map<string, SubmitResult>();
  const received: OutboundPurchaseOrder[] = [];
  return {
    id: 'mock-oem',
    description: 'Simulated OEM dealer ordering API (demo/test).',
    received,
    async submit(po, config) {
      if (config.fail) throw new Error('Supplier API unavailable (simulated)');
      const prior = seen.get(po.number);
      if (prior) return prior; // idempotent on our PO number
      received.push(po);
      const reject = new Set((config.rejectPartNumbers as string[] | undefined) ?? []);
      const result: SubmitResult = {
        externalRef: `OEM-${randomUUID().slice(0, 8).toUpperCase()}`,
        acceptedLineIds: po.lines.filter((l) => !reject.has(l.partNumber)).map((l) => l.lineId),
        rejected: po.lines.filter((l) => reject.has(l.partNumber)).map((l) => ({ lineId: l.lineId, reason: 'Part number not orderable' })),
        detail: { priority: po.orderType === 'vor' ? 'next-day' : 'standard' },
      };
      seen.set(po.number, result);
      return result;
    },
  };
}

export class OrderingAdapterRegistry {
  private adapters = new Map<string, SupplierOrderingAdapter>();
  constructor(adapters: SupplierOrderingAdapter[] = []) {
    adapters.forEach((a) => this.register(a));
  }
  register(adapter: SupplierOrderingAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }
  get(id: string): SupplierOrderingAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`No ordering adapter registered for "${id}"`);
    return a;
  }
  list() {
    return [...this.adapters.values()].map((a) => ({ id: a.id, description: a.description }));
  }
}

export function defaultOrderingRegistry(): OrderingAdapterRegistry {
  return new OrderingAdapterRegistry([manualAdapter, csvExportAdapter, createMockOemAdapter()]);
}
