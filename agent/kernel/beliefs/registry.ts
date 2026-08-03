import { kernelError } from '../errors.ts';
import type { BeliefDefinition } from './definition.ts';

/**
 * Registered belief definitions. Registration is explicit: an unregistered key
 * is an error rather than an implicit unknown, so a typo cannot quietly become
 * a permanently unknown belief.
 */
export class BeliefRegistry {
  readonly #definitions = new Map<string, BeliefDefinition>();

  constructor(definitions: readonly BeliefDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: BeliefDefinition): this {
    if (definition.key.length === 0) {
      throw kernelError('POWERFARM_KERNEL_CONFIG_INVALID', 'belief key must not be empty');
    }
    if (this.#definitions.has(definition.key)) {
      throw kernelError('POWERFARM_KERNEL_CONFIG_INVALID', 'belief key is already registered', {
        beliefKey: definition.key,
      });
    }
    this.#definitions.set(definition.key, definition);
    return this;
  }

  has(key: string): boolean {
    return this.#definitions.has(key);
  }

  get(key: string): BeliefDefinition {
    const found = this.#definitions.get(key);
    if (!found) {
      throw kernelError('POWERFARM_KERNEL_BELIEF_DEFINITION_MISSING', 'belief is not registered', {
        beliefKey: key,
      });
    }
    return found;
  }

  keys(): readonly string[] {
    return [...this.#definitions.keys()].sort();
  }

  all(): readonly BeliefDefinition[] {
    return this.keys().map((key) => this.#definitions.get(key) as BeliefDefinition);
  }

  get size(): number {
    return this.#definitions.size;
  }
}
