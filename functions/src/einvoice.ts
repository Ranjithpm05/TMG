import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  WEBTEL_CDKEY,
  WEBTEL_EF_USERNAME,
  WEBTEL_EF_PASSWORD,
  WEBTEL_EINV_USERNAME,
  WEBTEL_EINV_PASSWORD,
  WEBTEL_EINVOICE_BASE_URL,
  EINVOICE_SECRETS,
} from './config';
import { postWebtel, WebtelApiError } from './webtelClient';

interface EInvoicePartyDtls {
  Gstin: string;
  LglNm: string;
  TrdNm?: string;
  Addr1: string;
  Addr2?: string;
  Loc: string;
  Pin: number;
  Stcd: string;
  Ph?: string;
  Em?: string;
}

interface GenerateEInvoiceRequest {
  gstin: string;
  payload: {
    TranDtls: { SupTyp: string; RegRev: string; EcmGstin?: string | null; IgstOnIntra: string };
    DocDtls: { Typ: string; No: string; Dt: string };
    SellerDtls: EInvoicePartyDtls;
    BuyerDtls: EInvoicePartyDtls & { Pos: string };
    ItemList: Record<string, unknown>[];
    ValDtls: Record<string, unknown>;
  };
}

// Proxies Webtel's GenIRN2 sandbox API (hierarchical-JSON e-Invoice
// generation). The Angular EInvoiceService already builds the IRP-shaped
// payload locally via preparePayload() — this function only adds the secret
// credentials and forwards it, so business logic (item/tax computation)
// stays in one place instead of being duplicated here.
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
      GSTIN: '29AAACW3775F000',//data.gstin,
      GetQRImg: '1',
      GetSignedInvoice: '1',
      TranDtls: {
        SupTyp: data.payload.TranDtls.SupTyp,
        RegRev: data.payload.TranDtls.RegRev,
        EcmGstin: data.payload.TranDtls.EcmGstin ?? null,
        IgstOnIntra: data.payload.TranDtls.IgstOnIntra,
      },
      DocDtls: data.payload.DocDtls,
      SellerDtls: data.payload.SellerDtls,
      BuyerDtls: data.payload.BuyerDtls,
      ItemList: data.payload.ItemList,
      ValDtls: data.payload.ValDtls,
    };

    try {
        console.log('Sending e-Invoice request to Webtel:', JSON.stringify(body));
        console.log('Using Webtel e-Invoice base URL:', `${WEBTEL_EINVOICE_BASE_URL.value()}/GenIRN2`);
      const result = await postWebtel(`${WEBTEL_EINVOICE_BASE_URL.value()}/GenIRN2`, body);
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
