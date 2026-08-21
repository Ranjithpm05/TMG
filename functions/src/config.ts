import { defineSecret, defineString } from 'firebase-functions/params';

// Secrets — never committed, never sent to the client. Set the real values
// with (run once per environment, values are never echoed back):
//   firebase functions:secrets:set WEBTEL_CDKEY
//   firebase functions:secrets:set WEBTEL_EF_USERNAME
//   firebase functions:secrets:set WEBTEL_EF_PASSWORD
//   firebase functions:secrets:set WEBTEL_EINV_USERNAME
//   firebase functions:secrets:set WEBTEL_EINV_PASSWORD
//   firebase functions:secrets:set WEBTEL_EWB_USERNAME
//   firebase functions:secrets:set WEBTEL_EWB_PASSWORD
export const WEBTEL_CDKEY = defineSecret('WEBTEL_CDKEY');
export const WEBTEL_EF_USERNAME = defineSecret('WEBTEL_EF_USERNAME');
export const WEBTEL_EF_PASSWORD = defineSecret('WEBTEL_EF_PASSWORD');
export const WEBTEL_EINV_USERNAME = defineSecret('WEBTEL_EINV_USERNAME');
export const WEBTEL_EINV_PASSWORD = defineSecret('WEBTEL_EINV_PASSWORD');
export const WEBTEL_EWB_USERNAME = defineSecret('WEBTEL_EWB_USERNAME');
export const WEBTEL_EWB_PASSWORD = defineSecret('WEBTEL_EWB_PASSWORD');

// Non-secret base URLs, defaulted to Webtel's published SANDBOX endpoints.
// To switch to production once Webtel issues production URLs, just redeploy
// with these overridden (functions:config / .env.<project>) — no code change.
export const WEBTEL_EINVOICE_BASE_URL = defineString('WEBTEL_EINVOICE_BASE_URL', {
  default: 'http://einvSandbox.webtel.in/v1.03',
});
export const WEBTEL_EWAYBILL_BASE_URL = defineString('WEBTEL_EWAYBILL_BASE_URL', {
  default: 'http://ewaysandbox.webtel.in/Sandbox/EWayBill/v1.3',
});

export const EINVOICE_SECRETS = [
  WEBTEL_CDKEY,
  WEBTEL_EF_USERNAME,
  WEBTEL_EF_PASSWORD,
  WEBTEL_EINV_USERNAME,
  WEBTEL_EINV_PASSWORD,
];

export const EWAYBILL_SECRETS = [
  WEBTEL_CDKEY,
  WEBTEL_EF_USERNAME,
  WEBTEL_EF_PASSWORD,
  WEBTEL_EWB_USERNAME,
  WEBTEL_EWB_PASSWORD,
];
