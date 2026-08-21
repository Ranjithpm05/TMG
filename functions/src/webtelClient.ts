export class WebtelApiError extends Error {
  code?: string;
  details?: unknown;

  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'WebtelApiError';
    this.code = code;
    this.details = details;
  }
}

// Webtel's sandbox endpoints are plain HTTP JSON POSTs that return either a
// bare array `[ {...} ]` or (rarely) a single object — this normalizes both
// into the first result object every caller here actually needs.
export async function postWebtel(url: string, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    throw new WebtelApiError(`Could not reach Webtel sandbox at ${url}: ${err?.message || err}`);
  }

  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WebtelApiError(`Webtel API returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    throw new WebtelApiError(`Webtel API request failed (HTTP ${res.status})`, undefined, parsed);
  }

  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first) {
    throw new WebtelApiError('Webtel API returned an empty response.');
  }
  return first;
}

export function isSuccessFlag(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const normalized = String(value).toLowerCase().trim();
  return normalized === '1' || normalized === 'true';
}
