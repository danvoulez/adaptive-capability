import type { ContextSnapshot } from '../contracts/context.ts';
import type {
  SignalQuery,
  StoredSignal,
  WatermarkState,
} from '../contracts/signal.ts';

/**
 * Storage surface required by this milestone. Later milestones extend the
 * kernel store with context snapshots, evaluations, inference results, and
 * episodes; the signal surface stays stable.
 *
 * Implementations must return clones, never internal references.
 */
export interface KernelSignalStore {
  /** Monotonic admission order, owned by the store so that replay is stable. */
  nextAdmissionSequence(): Promise<number>;
  appendSignal(record: StoredSignal): Promise<'admitted' | 'duplicate'>;
  getSignal(id: string): Promise<StoredSignal | null>;
  listSignals(query: SignalQuery): Promise<readonly StoredSignal[]>;
  putWatermark(state: WatermarkState): Promise<void>;
  getWatermark(source: string, scope: string): Promise<WatermarkState | null>;
}

/**
 * Context surface added in Milestone 2. Kept separate from the signal surface so
 * that each milestone widens the store by an explicit, named contract.
 */
export interface KernelContextStore {
  putContextSnapshot(snapshot: ContextSnapshot): Promise<void>;
  getContextSnapshot(scope: string): Promise<ContextSnapshot | null>;
}

export type KernelStore = KernelSignalStore & KernelContextStore;

export function watermarkKey(source: string, scope: string): string {
  return `${JSON.stringify(source)}::${JSON.stringify(scope)}`;
}
