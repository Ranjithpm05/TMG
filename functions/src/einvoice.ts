import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  WEBTEL_CDKEY,
  WEBTEL_EF_USERNAME,
  WEBTEL_EF_PASSWORD,
  WEBTEL_EINV_USERNAME,
  WEBTEL_EINV_PASSWORD,
  WEBTEL_EINVOICE_BASE_URL,
  EINVOICE_DEBUG_LOG,
  EINVOICE_SECRETS,
} from './config';
import { postWebtel, WebtelApiError } from './webtelClient';

interface GenerateEInvoiceRequest {
  gstin: string;
  payload: {
    SellerDtls: Record<string, unknown>;
    BuyerDtls: Record<string, unknown>;
    [key: string]: unknown;
  };
}

// Fields never to be written to logs, even in debug mode.
const SECRET_BODY_KEYS = ['CDKey', 'EInvUserName', 'EInvPassword', 'EFUserName', 'EFPassword'];

function redactSecrets(body: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...body };
  for (const key of SECRET_BODY_KEYS) redacted[key] = '[REDACTED]';
  return redacted;
}

// Proxies Webtel's GenIRN2 sandbox API (hierarchical-JSON e-Invoice
// generation).
export const generateEInvoiceIrn = onCall(
  { secrets: EINVOICE_SECRETS, cors: true },
  async (request) => {
    const data = request.data as GenerateEInvoiceRequest;
    if (!data?.gstin || !data?.payload?.SellerDtls || !data?.payload?.BuyerDtls)
    {
      throw new HttpsError('invalid-argument', 'gstin and a complete e-Invoice payload are required.');
    }

    const body = {
      CDKey: WEBTEL_CDKEY.value(),
      EInvUserName: WEBTEL_EINV_USERNAME.value(),
      EInvPassword: WEBTEL_EINV_PASSWORD.value(),
      EFUserName: WEBTEL_EF_USERNAME.value(),
      EFPassword: WEBTEL_EF_PASSWORD.value(),
      // Business GSTIN comes from the caller (company.gstin, configured in
      // Company Settings) — never hardcoded. If testing against Webtel's
      // public sandbox, which only accepts its own pre-registered test
      // GSTINs, set that value in Company Settings (master data), not here.
      GSTIN: "29AAACW3775F000", //data.gstin,
      GetQRImg: '1',
      GetSignedInvoice: '1',
      ...data.payload,
    };

    if (EINVOICE_DEBUG_LOG.value() === 'true') {
      console.log('generateEInvoiceIrn request URL:', `${WEBTEL_EINVOICE_BASE_URL.value()}/GenIRN2`);
      console.log('generateEInvoiceIrn request body (secrets redacted):', JSON.stringify(redactSecrets(body), null, 2));
    }

    try {
        console.log('generateEInvoiceIrn', JSON.stringify(body))
      const result = await postWebtel(`${WEBTEL_EINVOICE_BASE_URL.value()}/GenIRN2`, body);
      if (EINVOICE_DEBUG_LOG.value() === 'true') {
        console.log('generateEInvoiceIrn response:', JSON.stringify(result, null, 2));
      }
      if (String(result.Status) !== '1') {
        throw new HttpsError('failed-precondition', result.ErrorMessage || 'E-Invoice generation failed.', {
          errorCode: result.ErrorCode,
          infoDtls: result.InfoDtls,
        });
      }
      return {
        irn: result.Irn as string,
        ackNo: String(result.AckNo ?? ''),
        ackDt: result.AckDate as string,
        signedQrCode: result.SignedQRCode as string,
        signedInvoice: result.SignedInvoice as string,
      };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      const message = err instanceof WebtelApiError ? err.message : 'Failed to reach the e-Invoice sandbox.';
      throw new HttpsError('unavailable', message);
    }
  }
);

interface CancelEInvoiceRequest {
  irn: string;
  gstin: string;
  reasonCode: string;
  remark: string;
}

export const cancelEInvoiceIrn = onCall(
  { secrets: EINVOICE_SECRETS, cors: true },
  async (request) => {
    const data = request.data as CancelEInvoiceRequest;
    if (!data?.irn || !data?.gstin || !data?.reasonCode) {
      throw new HttpsError('invalid-argument', 'irn, gstin and reasonCode are required.');
    }

    const body = {
      Push_Data_List: {
        Data: [
          {
            Irn: data.irn,
            GSTIN: data.gstin,
            CnlRsn: data.reasonCode,
            CnlRem: data.remark || 'Cancelled',
            CDKey: WEBTEL_CDKEY.value(),
            EFUserName: WEBTEL_EF_USERNAME.value(),
            EFPassword: WEBTEL_EF_PASSWORD.value(),
            EInvUserName: WEBTEL_EINV_USERNAME.value(),
            EInvPassword: WEBTEL_EINV_PASSWORD.value(),
          },
        ],
      },
    };

    try {
      const result = await postWebtel(`${WEBTEL_EINVOICE_BASE_URL.value()}/CanIRN`, body);
      if (String(result.Status) !== '1') {
        throw new HttpsError('failed-precondition', result.ErrorMessage || 'E-Invoice cancellation failed.', {
          errorCode: result.ErrorCode,
        });
      }
      return { cancelDate: result.CancelDate as string };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      const message = err instanceof WebtelApiError ? err.message : 'Failed to reach the e-Invoice sandbox.';
      throw new HttpsError('unavailable', message);
    }
  }
);
