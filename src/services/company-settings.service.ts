import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  doc,
  docData,
  getDoc,
  setDoc,
  serverTimestamp,
} from '@angular/fire/firestore';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { CompanySettings } from '../models/einvoice.model';

@Injectable({ providedIn: 'root' })
export class CompanySettingsService {
  private firestore = inject(Firestore);
  private settingsRef = doc(this.firestore, 'settings/company');

  getCompanySettings(): Observable<CompanySettings | null> {
    return (docData(this.settingsRef, { idField: 'id' }) as Observable<any>).pipe(
      map((data) => (data ? this.normalize(data) : null)),
      catchError(() => of(null))
    );
  }

  async getCompanySettingsOnce(): Promise<CompanySettings | null> {
    const snap = await getDoc(this.settingsRef);
    if (!snap.exists()) return null;
    return this.normalize({ id: snap.id, ...snap.data() });
  }

  async saveCompanySettings(settings: Omit<CompanySettings, 'id' | 'updatedAt'>): Promise<void> {
    await setDoc(this.settingsRef, { ...settings, updatedAt: serverTimestamp() });
  }

  private normalize(raw: any): CompanySettings {
    return {
      id: raw?.id,
      legalName: String(raw?.legalName ?? ''),
      tradeName: raw?.tradeName ? String(raw.tradeName) : undefined,
      gstin: String(raw?.gstin ?? ''),
      address1: String(raw?.address1 ?? ''),
      address2: raw?.address2 ? String(raw.address2) : undefined,
      place: String(raw?.place ?? ''),
      pinCode: String(raw?.pinCode ?? ''),
      stateCode: String(raw?.stateCode ?? '33'),
      phone: raw?.phone ? String(raw.phone) : undefined,
      email: raw?.email ? String(raw.email) : undefined,
      bankAccountName: raw?.bankAccountName ? String(raw.bankAccountName) : undefined,
      bankAccountNo: raw?.bankAccountNo ? String(raw.bankAccountNo) : undefined,
      bankIfscCode: raw?.bankIfscCode ? String(raw.bankIfscCode) : undefined,
      bankName: raw?.bankName ? String(raw.bankName) : undefined,
      updatedAt: raw?.updatedAt,
    };
  }
}
