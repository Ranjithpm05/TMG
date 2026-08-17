/**
 * Selling price used across Sales Order, DC, and Invoice line items: MRP
 * reduced by the client's Margin% (Client Master). Invoice-only Discount% is
 * applied separately, on top of this, wherever invoice totals are computed.
 */
export function priceAfterMargin(mrp: number, marginPct?: number | null): number {
  const factor = 1 - (Number(marginPct) || 0) / 100;
  return Math.round(mrp * factor * 100) / 100;
}
