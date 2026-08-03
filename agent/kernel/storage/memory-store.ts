import { kernelError } from '../errors.ts';
import { toEpochMs } from '../contracts/common.ts';
import type { ContextSnapshot } from '../contracts/context.ts';
import type { SignalQuery, StoredSignal, WatermarkState } from '../contracts/signal.ts';
import { watermarkKey, type KernelStore } from './store.ts';

/**
 * Reference store for tests and for the default configuration. It clones on
 * write and on read so that no caller can mutate admitted state.
 */
export class InMemoryKernelStore implements KernelStore {
  readonly #signals = new Map<string, StoredSignal>();
  readonly #order: string[] = [];
  readonly #watermarks = new Map<string, WatermarkState>();
  readonly #contexts = new Map<string, ContextSnapshot>();

  async appendSignal(record: StoredSignal): Promise<'admitted' | 'duplicate'> {
    const existing = this.#signals.get(record.signal.id);
    if (existing) {
      if (existing.contentHash === record.contentHash) return 'duplicate';
      throw kernelError(
        'POWERFARM_KERNEL_SIGNAL_DUPLICATE_CONFLICT',
        'an admitted signal with this id has different content',
        { signalId: record.signal.id },
      );
    }
    this.#signals.set(record.signal.id, structuredClone(record));
    this.#order.push(record.signal.id);
    return 'admitted';
  }

  async getSignal(id: string): Promise<StoredSignal | null> {
    const found = this.#signals.get(id);
    return found ? structuredClone(found) : null;
  }

  async listSignals(query: SignalQuery): Promise<readonly StoredSignal[]> {
    const from = query.observedFrom === undefined ? null : toEpochMs(query.observedFrom, 'observedFrom');
    const until =
      query.observedUntil === undefined ? null : toEpochMs(query.observedUntil, 'observedUntil');

    const matched: StoredSignal[] = [];
    for (const id of this.#order) {
      const record = this.#signals.get(id);
      if (!record) continue;
      const { signal } = record;
      if (query.source !== undefined && signal.source !== query.source) continue;
      if (query.scope !== undefined && signal.scope !== query.scope) continue;
      if (query.subject !== undefined && signal.subject !== query.subject) continue;
      if (query.type !== undefined && signal.type !== query.type) continue;
      const observed = toEpochMs(signal.observedAt, 'observedAt');
      if (from !== null && observed < from) continue;
      if (until !== null && observed > until) continue;
      matched.push(record);
    }

    matched.sort((left, right) => {
      const delta =
        toEpochMs(left.signal.observedAt, 'observedAt') -
        toEpochMs(right.signal.observedAt, 'observedAt');
      return delta !== 0 ? delta : left.admissionSequence - right.admissionSequence;
    });

    const limited = query.limit === undefined ? matched : matched.slice(0, Math.max(0, query.limit));
    return limited.map((record) => structuredClone(record));
  }

  async putWatermark(state: WatermarkState): Promise<void> {
    this.#watermarks.set(watermarkKey(state.source, state.scope), structuredClone(state));
  }

  async getWatermark(source: string, scope: string): Promise<WatermarkState | null> {
    const found = this.#watermarks.get(watermarkKey(source, scope));
    return found ? structuredClone(found) : null;
  }

  async putContextSnapshot(snapshot: ContextSnapshot): Promise<void> {
    this.#contexts.set(snapshot.scope, structuredClone(snapshot));
  }

  async getContextSnapshot(scope: string): Promise<ContextSnapshot | null> {
    const found = this.#contexts.get(scope);
    return found ? structuredClone(found) : null;
  }

  async nextAdmissionSequence(): Promise<number> {
    return this.#order.length + 1;
  }

  get size(): number {
    return this.#order.length;
  }
}
