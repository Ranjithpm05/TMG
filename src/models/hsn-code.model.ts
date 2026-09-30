// Default GST HSN/SAC codes by product type. The key is the product name as
// it already flows through the app (Design.group -> PackingListLine.partName
// -> DCItem.partName -> InvoiceItem.description), so no new field or mapping
// step is needed elsewhere — an Invoice line just looks up its own
// description here. Business-provided list; falls back to a manually-entered
// default (see PackingListComponent.generateInvoiceForPackingList) only for
// a product not yet in this table.
export const DEFAULT_HSN_BY_PRODUCT: Record<string, string> = {
  'CASUAL SHIRTS': '62052000',
  'FORMAL SHIRTS': '62059090',
  'CASUAL TROUSER': '62034200',
  'FORMAL TROUSER': '62034200',
  'DENIM TROUSER': '62034200',
  'DENIM SHORTS': '62034200',
  'DENIM BAGGY': '62034200',
};

// SAC for freight charged on the invoice (goods transport by road). Freight
// billed with the goods is part of a composite supply, so it's taxed at the
// goods' own GST rate — this code only labels its own tax-summary row and
// e-Invoice line.
export const FREIGHT_SAC = '996511';

export function resolveHsnCode(productName: string | undefined, fallback: string): string {
  const key = (productName ?? '').trim().toUpperCase();
  return DEFAULT_HSN_BY_PRODUCT[key] || fallback;
}
