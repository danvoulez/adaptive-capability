import { kernelError } from '../errors.ts';
import { toIsoTimestamp, type IsoTimestamp } from '../contracts/common.ts';

export interface KernelClock {
  now(): Date;
}

/** Wall-clock time. Only the imperative shell may use it. */
export class SystemKernelClock implements KernelClock {
  now(): Date {
    return new Date();
  }
}

/** Deterministic clock for tests and replay. */
export class FixedKernelClock implements KernelClock {
  #current: number;

  constructor(at: Date | IsoTimestamp | number) {
    this.#current = FixedKernelClock.#toEpoch(at);
  }

  now(): Date {
    return new Date(this.#current);
  }

  set(at: Date | IsoTimestamp | number): void {
    this.#current = FixedKernelClock.#toEpoch(at);
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds)) {
      throw kernelError('POWERFARM_KERNEL_TIMESTAMP_INVALID', 'advance requires finite ms');
    }
    this.#current += milliseconds;
  }

  static #toEpoch(at: Date | IsoTimestamp | number): number {
    const epoch = typeof at === 'string' ? Date.parse(at) : at instanceof Date ? at.valueOf() : at;
    if (!Number.isFinite(epoch)) {
      throw kernelError('POWERFARM_KERNEL_TIMESTAMP_INVALID', 'clock requires a valid instant');
    }
    return epoch;
  }
}

export function nowIso(clock: KernelClock): IsoTimestamp {
  return toIsoTimestamp(clock.now(), 'processedAt');
}
