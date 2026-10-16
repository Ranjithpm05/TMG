// Group stock adjustment (stock audit).
//
// Firestore layout:
//   stockAdjustments/{sessionId}                 — one counting session for one product group (history header)
//   stockAdjustments/{sessionId}/lines/{invId}   — one doc per counted product (created on first scan / zero-confirm)
//   stockAdjustmentLocks/{groupKey}              — at most one active session per product group
//   counters/stockAdjustmentCounter              — SA-0001 numbering, same pattern as counters/dcCounter
//
// Lines live in a subcollection because a single group holds up to ~8k SKUs —
// far past what one 1 MB document can carry.

export type StockAdjustmentStatus = 'Counting' | 'Completing' | 'Completed' | 'Cancelled';

export interface StockAdjustmentSession {
  id?: string;
  adjustmentNo: string;
  adjustmentSeq: number;
  /** Product group = inventory.group (copied from Design Master at GRN time). */
  group: string;
  status: StockAdjustmentStatus;
  /** Products / total stock in the group when counting started (display only). */
  totalProducts: number;
  startStockTotal: number;
  startedBy: string;
  startedAt?: any;
  /** Present only while status === 'Completing'. */
  completionLock?: {
    lockId: string;
    /** Client clock (ms) of the last committed chunk — an idle lock past STALE_LOCK_MS may be taken over. */
    lastProgressMs: number;
    failed?: boolean;
  };
  /** Running totals written in the same transaction as each applied chunk. */
  result?: {
    appliedLines: number;
    changedLines: number;
    increaseQty: number;
    decreaseQty: number;
  };
  completedBy?: string;
  completedAt?: any;
  cancelledBy?: string;
  cancelledAt?: any;
  lastError?: string;
  createdAt?: any;
  updatedAt?: any;
}

export interface StockAdjustmentLine {
  /** = inventory doc id (also this line's doc id). */
  id: string;
  barcode: string;
  styleNo: string;
  color: string;
  size: string;
  sleeveType?: string;
  /** Book stock shown when this product was first counted (display only). */
  startStock: number;
  /** Units scanned so far — only ever changed with increment(), so several scanners can count at once. */
  scannedQty: number;
  /** User explicitly confirmed "none on hand" for a product that has book stock but could not be scanned. */
  zeroConfirmed?: boolean;
  lastScannedBy?: string;
  // ── Audit trail, written atomically with the inventory update on completion ──
  applied?: boolean;
  previousStock?: number;
  countedQty?: number;
  variance?: number;
  appliedAt?: any;
  updatedAt?: any;
}

/** Group product row for the counting grid (inventory + this session's line). */
export type ScanStatus = 'scanned' | 'zero-confirmed' | 'pending' | 'no-stock';
