import { Injectable, signal } from '@angular/core';

// Lets one screen ask the shell (AppComponent) to switch to another and hand
// it an intent — e.g. Bulk Picking → "Start Bulk Packing" opens the Packing
// List screen directly in Bulk Packing for the list it just generated. The
// target screen consume()s the request on init, so it fires once.
export interface ScreenNavRequest {
  view: string;
  intent?: 'bulk-pack';
  packingListId?: string;
}

@Injectable({ providedIn: 'root' })
export class ScreenNavigationService {
  readonly request = signal<ScreenNavRequest | null>(null);

  go(request: ScreenNavRequest): void {
    this.request.set(request);
  }

  /** Returns and clears the pending request if it targets `view`. */
  consume(view: string): ScreenNavRequest | null {
    const pending = this.request();
    if (!pending || pending.view !== view) return null;
    this.request.set(null);
    return pending;
  }
}
