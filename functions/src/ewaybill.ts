import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  WEBTEL_CDKEY,
  WEBTEL_EF_USERNAME,
  WEBTEL_EF_PASSWORD,
  WEBTEL_EWB_USERNAME,
  WEBTEL_EWB_PASSWORD,
  WEBTEL_EWAYBILL_BASE_URL,
  EWAYBILL_SECRETS,
} from './config';
import { postWebtel, isSuccessFlag, WebtelApiError } from './webtelClient';

interface GenerateEwayBillRequest {
  irn: string;
  gstin: string;
  distance: number;
  transMode: '1' | '2' | '3' | '4';
  transporterId?: string;
  transporterName?: string;
  vehicleNo?: string;
  vehicleType?: 'R' | 'O';
  transDocNo?: string;
  transDocDt?: string; // yyyymmdd, per Webtel E-Way Bill sandbox spec
  shipTo?: { addr1?: string; addr2?: string; loc?: string; pin?: number; stcd?: string };
}

// Proxies Webtel's E-Way Bill sandbox "Generate Ewaybill By IRN" API — the
// E-Way Bill is generated from an already-registered e-Invoice's IRN, so
// this must only be called after generateEInvoiceIrn() succeeded.
export const generateEwayBillByIrn = onCall(
  { secrets: EWAYBILL_SECRETS, cors: true },
  async (request) => {
    const data = request.data as GenerateEwayBillRequest;
    if (!data?.irn || !data?.gstin || !data?.transMode || data?.distance === undefined) {
      throw new HttpsError('invalid-argument', 'irn, gstin, distance and transMode are required.');
    }

    const body = {
      Push_Data_List: [
        {
          Irn: data.irn,
          TransMode: data.transMode,
          Transid: data.transporterId || '',
          Transname: data.transporterName || '',
          Distance: data.distance,
          Transdocno: data.transDocNo || '',
          TransdocDt: data.transDocDt || '',
          Vehno: data.vehicleNo || '',
          Vehtype: data.vehicleType || 'R',
          ShipFrom_Addr1: '',
          ShipFrom_Addr2: '',
          ShipFrom_Loc: '',
          ShipFrom_Pin: 0,
          ShipFrom_Stcd: '',
          ShipTo_Addr1: data.shipTo?.addr1 || '',
          ShipTo_Addr2: data.shipTo?.addr2 || '',
          ShipTo_Loc: data.shipTo?.loc || '',
          ShipTo_Pin: data.shipTo?.pin || 0,
          ShipTo_Stcd: data.shipTo?.stcd || '',
          GSTIN: data.gstin,
          CDKey: WEBTEL_CDKEY.value(),
          EWbUserName: WEBTEL_EWB_USERNAME.value(),
          EWbPassword: WEBTEL_EWB_PASSWORD.value(),
          EFUserName: WEBTEL_EF_USERNAME.value(),
          EFPassword: WEBTEL_EF_PASSWORD.value(),
        },
      ],
    };

    try {
      const result = await postWebtel(`${WEBTEL_EWAYBILL_BASE_URL.value()}/GenEWaybyIRN`, body);
      if (!isSuccessFlag(result.IsSuccess)) {
        throw new HttpsError('failed-precondition', result.ErrorMessage || 'E-Way Bill generation failed.', {
          errorCode: result.ErrorCode,
        });
      }
      return {
        ewbNo: String(result.EwbNo ?? ''),
        ewbDate: result.EwbDt as string,
        ewbValidTill: result.EwbValidTill as string,
      };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      const message = err instanceof WebtelApiError ? err.message : 'Failed to reach the E-Way Bill sandbox.';
      throw new HttpsError('unavailable', message);
    }
  }
);

interface CancelEwayBillRequest {
  gstin: string;
  ewbNumber: string;
  cancelReasonCode: string;
  cancelRemark: string;
  year: number;
  month: number;
}

export const cancelEwayBill = onCall(
  { secrets: EWAYBILL_SECRETS, cors: true },
  async (request) => {
    const data = request.data as CancelEwayBillRequest;
    if (!data?.gstin || !data?.ewbNumber || !data?.cancelReasonCode) {
      throw new HttpsError('invalid-argument', 'gstin, ewbNumber and cancelReasonCode are required.');
    }

    const body = {
      Push_Data_List: [
        {
          GSTIN: data.gstin,
          EWBNumber: Number(data.ewbNumber),
          CancelReasonCode: data.cancelReasonCode,
          CancelRemark: data.cancelRemark || 'Cancelled',
          EWBUserName: WEBTEL_EWB_USERNAME.value(),
          EWBPassword: WEBTEL_EWB_PASSWORD.value(),
        },
      ],
      Year: data.year,
      Month: data.month,
      EFUserName: WEBTEL_EF_USERNAME.value(),
      EFPassword: WEBTEL_EF_PASSWORD.value(),
      CDKey: WEBTEL_CDKEY.value(),
    };

    try {
      const result = await postWebtel(`${WEBTEL_EWAYBILL_BASE_URL.value()}/CancelEWB`, body);
      if (!isSuccessFlag(result.IsSuccess)) {
        throw new HttpsError('failed-precondition', result.ErrorMessage || 'E-Way Bill cancellation failed.', {
          errorCode: result.ErrorCode,
        });
      }
      return { cancelDate: result.Date as string };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      const message = err instanceof WebtelApiError ? err.message : 'Failed to reach the E-Way Bill sandbox.';
      throw new HttpsError('unavailable', message);
    }
  }
);
