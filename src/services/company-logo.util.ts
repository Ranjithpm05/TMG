// Single source of truth for the company logo across every printed/PDF
// document (Tax Invoice, E-Invoice, Delivery Challan, Packing List, E-Way
// Bill, ...) — change the URL here once instead of hardcoding it per
// document builder.
export const COMPANY_LOGO_URL =
  'https://firebasestorage.googleapis.com/v0/b/tmg-clothings.firebasestorage.app/o/Logo%2FTMGLogo.jpeg?alt=media&token=dc9d7e71-4bfb-4fff-a02e-9d5e5e9b9336';

// This used to fetch() the logo and re-encode it as a base64 data URI so it
// would be embedded in the print HTML rather than depend on a live <img>
// network request. That silently broke every print (E-Invoice, E-Way Bill,
// Packing List reprint) because the Firebase Storage bucket has no CORS
// configuration — a cross-origin fetch()/XHR of the download URL is blocked
// by the browser and always throws, so this always resolved to '' and every
// caller fell back to its text-only placeholder box.
//
// A plain <img src="..."> does NOT need CORS to render (CORS only gates
// script-readable access such as fetch/XHR/canvas pixel reads, not image
// display), so this now preloads the image via an off-DOM Image() — which
// warms the browser cache before a print popup's own <img> tag requests the
// same URL — and resolves to the raw URL directly instead of a data URI.
// Still resolves to '' on failure so callers can fall back to a placeholder.
export async function fetchLogoDataUri(url: string = COMPANY_LOGO_URL): Promise<string> {
  return new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(url);
    img.onerror = () => resolve('');
    img.src = url;
  });
}
