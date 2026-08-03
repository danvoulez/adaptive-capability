import type { IsoTimestamp } from '../contracts/common.ts';
import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  type ContextSnapshot,
} from '../contracts/context.ts';
import type { StoredSignal } from '../contracts/signal.ts';
import type { BeliefDefinition, BeliefFusionOptions } from '../beliefs/definition.ts';
import { recomputeBeliefs } from '../beliefs/engine.ts';
import type { BeliefRegistry } from '../beliefs/registry.ts';
import type { DependencyIndex } from '../core/dependency-index.ts';
import type { FreshnessProfile } from '../temporal/freshness.ts';
import { createEmptyContextSnapshot, unknownBeliefKeys } from './snapshot.ts';

export interface ContextProjectionInput {
  registry: BeliefRegistry;
  index: DependencyIndex;
  scope: string;
  asOf: IsoTimestamp;
  configVersion: string;
  previous: ContextSnapshot | null;
  /** Signal types that arrived and triggered this projection. */
  changedSignalTypes?: readonly string[];
  /** Belief keys to recompute regardless of signal types. */
  changedBeliefKeys?: readonly string[];
  signalsFor(definition: BeliefDefinition): Promise<readonly StoredSignal[]>;
  freshnessProfiles: Readonly<Record<string, FreshnessProfile>>;
  options?: BeliefFusionOptions;
}

export interface ContextProjectionResult {
  snapshot: ContextSnapshot;
  computedBeliefKeys: readonly string[];
}

/**
 * Projects a new context revision.
 *
 * Only beliefs reachable from the changed signal types are recomputed. The
 * previous snapshot is never mutated: a new revision is returned, so a late
 * correction adds history rather than rewriting it.
 */
export async function projectContext(
  input: ContextProjectionInput,
): Promise<ContextProjectionResult> {
  const previous =
    input.previous ??
    createEmptyContextSnapshot({
      scope: input.scope,
      asOf: input.asOf,
      configVersion: input.configVersion,
    });

  const affectedKeys = input.index.affected({
    signalTypes: input.changedSignalTypes ?? [],
    beliefKeys: input.changedBeliefKeys ?? [],
  });

  const recomputation = await recomputeBeliefs({
    registry: input.registry,
    index: input.index,
    scope: input.scope,
    asOf: input.asOf,
    affectedKeys,
    current: previous.beliefs,
    signalsFor: input.signalsFor,
    freshnessProfiles: input.freshnessProfiles,
    ...(input.options ? { options: input.options } : {}),
  });

  const snapshot: ContextSnapshot = {
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    scope: input.scope,
    asOf: input.asOf,
    revision: previous.revision + (recomputation.changedKeys.length > 0 ? 1 : 0),
    configVersion: input.configVersion,
    beliefs: recomputation.beliefs,
    changedBeliefKeys: [...recomputation.changedKeys].sort(),
    unknownBeliefKeys: unknownBeliefKeys(recomputation.beliefs),
  };

  return { snapshot, computedBeliefKeys: recomputation.computedKeys };
}
