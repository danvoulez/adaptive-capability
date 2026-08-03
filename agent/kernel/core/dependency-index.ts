import { kernelError } from '../errors.ts';
import type { BeliefRegistry } from '../beliefs/registry.ts';

/**
 * Static index from signal types and belief keys to the beliefs they affect.
 *
 * Built once per registry so that ingestion recomputes only what a signal can
 * actually reach, instead of the whole belief set.
 */
export class DependencyIndex {
  readonly #bySignalType = new Map<string, Set<string>>();
  readonly #dependents = new Map<string, Set<string>>();
  readonly #order: readonly string[];

  constructor(registry: BeliefRegistry) {
    for (const definition of registry.all()) {
      for (const signalType of definition.signalTypes) {
        const bucket = this.#bySignalType.get(signalType) ?? new Set<string>();
        bucket.add(definition.key);
        this.#bySignalType.set(signalType, bucket);
      }
      for (const dependency of definition.beliefDependencies) {
        if (!registry.has(dependency)) {
          throw kernelError(
            'POWERFARM_KERNEL_BELIEF_DEFINITION_MISSING',
            'a belief depends on an unregistered belief',
            { beliefKey: definition.key, dependency },
          );
        }
        const bucket = this.#dependents.get(dependency) ?? new Set<string>();
        bucket.add(definition.key);
        this.#dependents.set(dependency, bucket);
      }
    }
    this.#order = DependencyIndex.#topologicalOrder(registry);
  }

  /** Deterministic evaluation order: dependencies before dependents. */
  get evaluationOrder(): readonly string[] {
    return this.#order;
  }

  beliefsForSignalType(signalType: string): readonly string[] {
    return [...(this.#bySignalType.get(signalType) ?? [])].sort();
  }

  directDependents(beliefKey: string): readonly string[] {
    return [...(this.#dependents.get(beliefKey) ?? [])].sort();
  }

  /**
   * Transitive closure of the beliefs reachable from the given signal types and
   * seed keys, returned in evaluation order.
   */
  affected(input: { signalTypes?: readonly string[]; beliefKeys?: readonly string[] }): readonly string[] {
    const pending: string[] = [];
    for (const signalType of input.signalTypes ?? []) {
      pending.push(...this.beliefsForSignalType(signalType));
    }
    pending.push(...(input.beliefKeys ?? []));

    const reached = new Set<string>();
    while (pending.length > 0) {
      const key = pending.pop() as string;
      if (reached.has(key)) continue;
      reached.add(key);
      pending.push(...this.directDependents(key));
    }

    return this.#order.filter((key) => reached.has(key));
  }

  static #topologicalOrder(registry: BeliefRegistry): readonly string[] {
    const permanent = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    const visit = (key: string, path: readonly string[]): void => {
      if (permanent.has(key)) return;
      if (visiting.has(key)) {
        throw kernelError('POWERFARM_KERNEL_BELIEF_DEPENDENCY_CYCLE', 'belief dependencies cycle', {
          cycle: [...path, key].join(' -> '),
        });
      }
      visiting.add(key);
      for (const dependency of [...registry.get(key).beliefDependencies].sort()) {
        visit(dependency, [...path, key]);
      }
      visiting.delete(key);
      permanent.add(key);
      order.push(key);
    };

    for (const key of registry.keys()) visit(key, []);
    return order;
  }
}
