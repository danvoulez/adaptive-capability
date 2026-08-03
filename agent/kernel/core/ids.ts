import { randomUUID } from 'node:crypto';

import { kernelError } from '../errors.ts';

export interface KernelIdFactory {
  next(prefix: string): string;
}

const prefixPattern = /^[a-z][a-z0-9-]*$/u;

function assertPrefix(prefix: string): void {
  if (!prefixPattern.test(prefix)) {
    throw kernelError('POWERFARM_KERNEL_SIGNAL_INVALID', 'identifier prefix is not well formed', {
      prefix,
    });
  }
}

/** Random identifiers. Only the imperative shell may use it. */
export class SystemKernelIdFactory implements KernelIdFactory {
  next(prefix: string): string {
    assertPrefix(prefix);
    return `${prefix}:${randomUUID()}`;
  }
}

/**
 * Deterministic identifiers for tests and replay. Counters are kept per prefix
 * so that unrelated sequences do not interfere.
 */
export class DeterministicKernelIdFactory implements KernelIdFactory {
  readonly #seed: string;
  readonly #counters = new Map<string, number>();

  constructor(seed = 'test') {
    this.#seed = seed;
  }

  next(prefix: string): string {
    assertPrefix(prefix);
    const nextValue = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, nextValue);
    return `${prefix}:${this.#seed}-${String(nextValue).padStart(6, '0')}`;
  }

  reset(): void {
    this.#counters.clear();
  }
}
