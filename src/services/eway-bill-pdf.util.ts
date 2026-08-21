// QR/barcode image generation for the E-Way Bill print document — kept
// separate from eway-bill.component.ts so the (fairly heavy) qrcode/jsbarcode
// libraries are only pulled in via dynamic import when a PDF is actually
// printed, matching the jsPDF dynamic-import pattern used elsewhere.

// Webtel's GenEWaybyIRN response (unlike GenIRN2 for e-Invoices) does not
// return a ready-made QR image, so the QR is generated client-side. Content
// follows NIC's published E-Way Bill QR format (pipe-delimited key facts of
// the actual generated E-Way Bill) rather than encoding only the EWB number.
export function buildEwbQrContent(fields: {
  ewbNo: string;
  ewbDate: string;
  generatorGstin: string;
  docNo: string;
  docDate: string;
  fromGstin?: string;
  toGstin?: string;
  totalValue: number;
  distance?: number;
  transporterId?: string;
  vehicleNo?: string;
}): string {
  return [
    `EwbNo:${fields.ewbNo}`,
    `EwbDt:${fields.ewbDate}`,
    `GenGstin:${fields.generatorGstin}`,
    `DocNo:${fields.docNo}`,
    `DocDt:${fields.docDate}`,
    `FromGstin:${fields.fromGstin || ''}`,
    `ToGstin:${fields.toGstin || ''}`,
    `TotVal:${fields.totalValue}`,
    `Distance:${fields.distance ?? ''}`,
    `TransId:${fields.transporterId || ''}`,
    `VehNo:${fields.vehicleNo || ''}`,
  ].join('|');
}

export async function generateQrDataUrl(content: string): Promise<string> {
  try {
    const QRCode: any = await import('qrcode');
    return await QRCode.toDataURL(content, { errorCorrectionLevel: 'M', margin: 1, width: 200 });
  } catch {
    return '';
  }
}

// Renders a scannable CODE128 barcode for the E-Way Bill number onto an
// off-screen canvas and returns it as a PNG data URI.
export async function generateBarcodeDataUrl(value: string): Promise<string> {
  if (!value) return '';
  try {
    const mod: any = await import('jsbarcode');
    const JsBarcode = mod.default ?? mod;
    const canvas = document.createElement('canvas');
    JsBarcode(canvas, value, {
      format: 'CODE128',
      displayValue: true,
      fontSize: 14,
      height: 50,
      width: 2,
      margin: 8,
    });
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  }
}
