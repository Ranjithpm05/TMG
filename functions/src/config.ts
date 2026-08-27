import { defineSecret, defineString } from 'firebase-functions/params';

// Secrets — never committed, never sent to the client. Set the real values
// with (run once per environment, values are never echoed back):
// E-Invoice and E-Way Bill are separate Webtel accounts (own CDKey and own
// EF credentials each) — kept as distinct secrets so the two flows can
// never cross-use each other's credentials.
export const WEBTEL_EINV_CDKEY = defineSecret('WEBTEL_EINV_CDKEY');
export const WEBTEL_EINV_EF_USERNAME = defineSecret('WEBTEL_EINV_EF_USERNAME');
export const WEBTEL_EINV_EF_PASSWORD = defineSecret('WEBTEL_EINV_EF_PASSWORD');
export const WEBTEL_EINV_USERNAME = defineSecret('WEBTEL_EINV_USERNAME');
export const WEBTEL_EINV_PASSWORD = defineSecret('WEBTEL_EINV_PASSWORD');

export const WEBTEL_EWB_CDKEY = defineSecret('WEBTEL_EWB_CDKEY');
export const WEBTEL_EWB_EF_USERNAME = defineSecret('WEBTEL_EWB_EF_USERNAME');
export const WEBTEL_EWB_EF_PASSWORD = defineSecret('WEBTEL_EWB_EF_PASSWORD');
export const WEBTEL_EWB_USERNAME = defineSecret('WEBTEL_EWB_USERNAME');
export const WEBTEL_EWB_PASSWORD = defineSecret('WEBTEL_EWB_PASSWORD');

// Non-secret base URLs, defaulted to Webtel's published SANDBOX endpoints.
export const WEBTEL_EINVOICE_BASE_URL = defineString('WEBTEL_EINVOICE_BASE_URL', {
  default: 'http://einvlive.webtel.in/v1.03',
});
export const WEBTEL_EWAYBILL_BASE_URL = defineString('WEBTEL_EWAYBILL_BASE_URL', {
  default: 'http://ewayasp.webtel.in/EWayBill/v1.3',
});

// Opt-in request/response logging for troubleshooting against the sandbox.
// Off by default in every environment (including local emulation) — enable
// explicitly with `firebase functions:config` / .env.<project> when needed.
// Never gates credential redaction: secrets are stripped from the logged
// payload regardless of this flag.
export const EINVOICE_DEBUG_LOG = defineString('EINVOICE_DEBUG_LOG', {
  default: 'false',
});

export const EWAYBILL_DEBUG_LOG = defineString('EWAYBILL_DEBUG_LOG', {
  default: 'false',
});

export const EINVOICE_SECRETS = [
  WEBTEL_EINV_CDKEY,
  WEBTEL_EINV_EF_USERNAME,
  WEBTEL_EINV_EF_PASSWORD,
  WEBTEL_EINV_USERNAME,
  WEBTEL_EINV_PASSWORD,
];

export const EWAYBILL_SECRETS = [
  WEBTEL_EWB_CDKEY,
  WEBTEL_EWB_EF_USERNAME,
  WEBTEL_EWB_EF_PASSWORD,
  WEBTEL_EWB_USERNAME,
  WEBTEL_EWB_PASSWORD,
];
