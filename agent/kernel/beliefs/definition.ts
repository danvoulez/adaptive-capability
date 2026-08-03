import type { IsoTimestamp, UnitInterval } from '../contracts/common.ts';
import type { BeliefState } from '../contracts/belief.ts';
import type { MissingReason, StoredSignal } from '../contracts/signal.ts';

/**
 * Neutral defaults used when a quality dimension is absent.
 *
 * Absent dimensions are never multiplied as zero. Reliability is deliberately
 * not neutral at 1: an unvetted source must not become fully trusted merely by
 * omitting the field.
 */
export interface BeliefFusionOptions {
  neutralSourceReliability: UnitInterval;
  neutralQualityDimension: UnitInterval;
  /** Evidence at or above this reliability counts as a trusted voice. */
  trustedReliabilityFloor: UnitInterval;
  /** Neutral model uncertainty applied to model-derived evidence. */
  neutralModelUncertainty: UnitInterval;
}

export const defaultBeliefFusionOptions: BeliefFusionOptions = Object.freeze({
  neutralSourceReliability: 0.5,
  neutralQualityDimension: 1,
  trustedReliabilityFloor: 0.5,
  neutralModelUncertainty: 0.5,
});

export interface BeliefEvidenceItem {
  signalId: string;
  source: string;
  signalType: string;
  observedAt: IsoTimestamp;
  /** `undefined` when the signal reported missingness. */
  value: unknown;
  missingReason?: MissingReason;
  reliability: UnitInterval;
  reliabilityOrigin: 'configured' | 'assumed';
  freshness: UnitInterval;
  expired: boolean;
  /** reliability x authenticity x completeness x coverage x freshness */
  weight: UnitInterval;
  modelDerived: boolean;
  inferenceResultIds: readonly string[];
  assumptions: readonly string[];
}

export interface BeliefComputationInput<T = unknown> {
  key: string;
  scope: string;
  asOf: IsoTimestamp;
  /** Evidence in ascending event-time order. */
  evidence: readonly BeliefEvidenceItem[];
  /** Current state of the beliefs this definition depends on. */
  dependencies: Readonly<Record<string, BeliefState>>;
  previous: BeliefState<T> | null;
  options: BeliefFusionOptions;
  /** Sources the definition expects to hear from, for missingness. */
  expectedSources: readonly string[];
}

export type BeliefComputeFunction<T = unknown> = (
  input: BeliefComputationInput<T>,
) => BeliefState<T>;

export interface BeliefDefinition<T = unknown> {
  key: string;
  version: string;
  signalTypes: readonly string[];
  beliefDependencies: readonly string[];
  freshnessProfileId: string;
  scope?: string;
  expectedSources?: readonly string[];
  compute: BeliefComputeFunction<T>;
}

export interface EvidenceSelection {
  definition: BeliefDefinition;
  signals: readonly StoredSignal[];
}
