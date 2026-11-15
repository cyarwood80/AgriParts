import { and, eq } from 'drizzle-orm';
import { customerSpecialPrices, customers, discountMatrix } from '../db/schema.js';
import { discount, vatRateFor } from '../lib/money.js';
import type { ServiceContext } from './context.js';
import type { Part } from './parts.js';

type Customer = typeof customers.$inferSelect;

export interface PriceResult {
  unitListPence: number;
  unitNetPence: number;
  discountBps: number;
  vatRateBps: number;
  unitCostPence: number;
  marginBps: number | null;
  /** How the price was reached. Shown to counter staff and returned to agents so they can explain it. */
  basis: 'special_price' | 'discount_matrix' | 'list_price';
  explanation: string;
  warnings: string[];
}

/**
 * Price one part for one customer. Order of precedence:
 *   1. In-date customer special (contract) price
 *   2. Discount matrix: customer's price band x part's discount code
 *   3. List price
 * VAT is never included in unit prices; it's added per line at invoicing.
 */
export async function priceFor(ctx: ServiceContext, part: Part, customer: Customer, today = new Date()): Promise<PriceResult> {
  const warnings: string[] = [];
  const vatRateBps = vatRateFor(part.vatCode);
  const list = part.listPricePence;
  let net = list;
  let discountBps = 0;
  let basis: PriceResult['basis'] = 'list_price';
  let explanation = `List price`;

  const [special] = await ctx.db
    .select()
    .from(customerSpecialPrices)
    .where(and(eq(customerSpecialPrices.customerId, customer.id), eq(customerSpecialPrices.partId, part.id)));
  const specialValid = special && (!special.validUntil || special.validUntil >= today.toISOString().slice(0, 10));

  if (specialValid) {
    net = special.pricePence;
    basis = 'special_price';
    discountBps = list > 0 ? Math.round(((list - net) * 10_000) / list) : 0;
    explanation = `Contract price for ${customer.accountCode}${special.validUntil ? ` (valid until ${special.validUntil})` : ''}`;
  } else if (part.discountCode) {
    const [row] = await ctx.db
      .select()
      .from(discountMatrix)
      .where(
        and(
          eq(discountMatrix.tenantId, ctx.tenantId),
          eq(discountMatrix.priceBand, customer.priceBand),
          eq(discountMatrix.discountCode, part.discountCode),
        ),
      );
    if (row && row.discountBps > 0) {
      discountBps = row.discountBps;
      net = discount(list, discountBps);
      basis = 'discount_matrix';
      explanation = `${(discountBps / 100).toFixed(2)}% off list (band ${customer.priceBand}, discount code ${part.discountCode})`;
    }
  }

  if (list === 0) warnings.push('Part has no list price; check the price file');
  if (part.costPricePence > 0 && net < part.costPricePence) warnings.push('Selling below cost');
  const marginBps = net > 0 ? Math.round(((net - part.costPricePence) * 10_000) / net) : null;

  return {
    unitListPence: list,
    unitNetPence: net,
    discountBps,
    vatRateBps,
    unitCostPence: part.costPricePence,
    marginBps,
    basis,
    explanation,
    warnings,
  };
}
