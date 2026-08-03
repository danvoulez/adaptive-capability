import { kernelError } from '../errors.ts';
import type { IsoTimestamp } from '../contracts/common.ts';
import type { BeliefState } from '../contracts/belief.ts';
import type { StoredSignal } from '../contracts/signal.ts';
import { assessFreshness, type FreshnessProfile } from '../temporal/freshness.ts';
import type { DependencyIndex } from '../core/dependency-index.ts';
import type { BeliefRegistry } from './registry.ts';
import {
  defaultBeliefFusionOptions,
  type BeliefDefinition,
  type BeliefEvidenceItem,
  type BeliefFusionOptions,
} from './definition.ts';

const qualityDimensions = ['authenticity', 'completeness', 'coverage'] as const;

/**
 * Turns an admitted signal into weighted evidence.
 *
 * Absent quality dimensions use the configured neutral default and are recorded
 * as assumptions; they are never multiplied as zero. Reliability is taken only
 * from configuration, never from the sender.
 */
export function buildEvidenceItem(
  record: StoredSignal,
  profile: FreshnessProfile,
  asOf: IsoTimestamp,
  options: BeliefFusionOptions,
): BeliefEvidenceItem {
  const { signal } = record;
  const assumptions: string[] = [];

  const configured = record.sourceReliabilityOrigin === 'configured' && record.sourceReliability !== null;
  const reliability = configured
    ? (record.sourceReliability as number)
    : options.neutralSourceReliability;
  if (!configured) assumptions.push(`assumed-reliability:${signal.source}`);

  let qualityWeight = 1;
  for (const dimension of qualityDimensions) {
    const value = signal.quality[dimension];
    if (value === undefined) {
      qualityWeight *= options.neutralQualityDimension;
      assumptions.push(`assumed-${dimension}:${signal.source}`);
    } else {
      qualityWeight *= value;
    }
  }

  const freshness = assessFreshness(profile, signal.observedAt, asOf);
  if (freshness.expired) assumptions.push(`expired-evidence:${signal.id}`);

  const modelDerived = signal.provenance.modelRef !== undefined;

  return {
    signalId: signal.id,
    source: signal.source,
    signalType: signal.type,
    observedAt: signal.observedAt,
    value: signal.missing === undefined ? signal.data : undefined,
    ...(signal.missing === undefined ? {} : { missingReason: signal.missing.reason }),
    reliability,
    reliabilityOrigin: configured ? 'configured' : 'assumed',
    freshness: freshness.weight,
    expired: freshness.expired,
    weight: reliability * qualityWeight * freshness.weight,
    modelDerived,
    inferenceResultIds: [],
    assumptions: [...new Set(assumptions)].sort(),
  };
}

export interface BeliefRecomputationInput {
  registry: BeliefRegistry;
  index: DependencyIndex;
  scope: string;
  asOf: IsoTimestamp;
  /** Only these keys and nothing else are recomputed. */
  affectedKeys: readonly string[];
  current: Readonly<Record<string, BeliefState>>;
  signalsFor(definition: BeliefDefinition): Promise<readonly StoredSignal[]>;
  freshnessProfiles: Readonly<Record<string, FreshnessProfile>>;
  options?: BeliefFusionOptions;
}

export interface BeliefRecomputationResult {
  beliefs: Readonly<Record<string, BeliefState>>;
  /** Keys whose value or uncertainty changed. */
  changedKeys: readonly string[];
  /** Keys actually passed through a compute function. */
  computedKeys: readonly string[];
}

export async function recomputeBeliefs(
  input: BeliefRecomputationInput,
): Promise<BeliefRecomputationResult> {
  const options = input.options ?? defaultBeliefFusionOptions;
  const beliefs: Record<string, BeliefState> = { ...input.current };
  const changedKeys: string[] = [];
  const computedKeys: string[] = [];

  // Evaluation order guarantees dependencies are recomputed before dependents.
  const ordered = input.index.evaluationOrder.filter((key) => input.affectedKeys.includes(key));

  for (const key of ordered) {
    const definition = input.registry.get(key);
    const profile = input.freshnessProfiles[definition.freshnessProfileId];
    if (!profile) {
      throw kernelError('POWERFARM_KERNEL_CONFIG_INVALID', 'freshness profile is not registered', {
        beliefKey: key,
        profileId: definition.freshnessProfileId,
      });
    }

    const signals = await input.signalsFor(definition);
    const evidence = signals
      .map((record) => buildEvidenceItem(record, profile, input.asOf, options))
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));

    const dependencies: Record<string, BeliefState> = {};
    for (const dependency of definition.beliefDependencies) {
      const state = beliefs[dependency];
      if (state) dependencies[dependency] = state;
    }

    const previous = beliefs[key] ?? null;
    const next = definition.compute({
      key,
      scope: input.scope,
      asOf: input.asOf,
      evidence,
      dependencies,
      previous,
      options,
      expectedSources: definition.expectedSources ?? [],
    });

    computedKeys.push(key);
    beliefs[key] = next;
    if (previous === null || previous.revision !== next.revision) changedKeys.push(key);
  }

  return { beliefs, changedKeys, computedKeys };
}
