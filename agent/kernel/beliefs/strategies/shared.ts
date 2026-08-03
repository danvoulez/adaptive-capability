import { BELIEF_SCHEMA_VERSION, summarizeUncertainty, type BeliefState } from '../../contracts/belief.ts';
import type { BeliefComputationInput, BeliefEvidenceItem } from '../definition.ts';

export interface FusionSummary {
  contributing: readonly BeliefEvidenceItem[];
  trusted: readonly BeliefEvidenceItem[];
  totalWeight: number;
  missingness: number;
  staleness: number;
  measurement: number;
  model: number;
  assumptions: readonly string[];
}

/**
 * Shared preparation for every strategy: split evidence into contributing and
 * missing, compute the dimensions that do not depend on the fusion algorithm.
 */
export function summarizeEvidence(input: BeliefComputationInput): FusionSummary {
  const withValue = input.evidence.filter((item) => item.value !== undefined);
  const contributing = withValue.filter((item) => item.weight > 0);
  const reporting = input.evidence.filter((item) => item.value !== undefined && !item.expired);
  const missingSignals = input.evidence.filter((item) => item.value === undefined);

  const totalWeight = contributing.reduce((sum, item) => sum + item.weight, 0);
  const trusted = contributing.filter(
    (item) => item.reliability >= input.options.trustedReliabilityFloor,
  );

  const heardSources = new Set(reporting.map((item) => item.source));
  const expected = input.expectedSources;
  const silentExpected = expected.filter((source) => !heardSources.has(source));

  let missingness: number;
  if (expected.length > 0) {
    missingness = (silentExpected.length + missingSignals.length) / (expected.length + missingSignals.length);
  } else if (input.evidence.length === 0) {
    missingness = 1;
  } else {
    const missingWeight = missingSignals.length;
    missingness = missingWeight / input.evidence.length;
  }
  if (contributing.length === 0) missingness = 1;

  const staleness = contributing.length === 0 ? 1 : 1 - Math.max(...contributing.map((i) => i.freshness));

  const measurement =
    contributing.length === 0
      ? 1
      : 1 - Math.max(...contributing.map((item) => item.reliability * item.freshness));

  const model = contributing.some((item) => item.modelDerived)
    ? input.options.neutralModelUncertainty
    : 0;

  const assumptions = new Set<string>();
  for (const item of contributing) for (const note of item.assumptions) assumptions.add(note);
  for (const source of silentExpected) assumptions.add(`expected-source-silent:${source}`);

  return {
    contributing,
    trusted,
    totalWeight,
    missingness: Math.min(1, Math.max(0, missingness)),
    staleness: Math.min(1, Math.max(0, staleness)),
    measurement: Math.min(1, Math.max(0, measurement)),
    model,
    assumptions: [...assumptions].sort(),
  };
}

export interface BeliefStateInput {
  input: BeliefComputationInput;
  value: unknown;
  summary: FusionSummary;
  conflict: number;
  strategy: string;
  version: string;
  extraAssumptions?: readonly string[];
  validFrom?: string;
  validUntil?: string;
}

export function buildBeliefState(build: BeliefStateInput): BeliefState {
  const { input, summary } = build;
  const assumptions = [
    ...new Set([...summary.assumptions, ...(build.extraAssumptions ?? [])]),
  ].sort();

  const uncertainty = summarizeUncertainty({
    measurement: summary.measurement,
    model: summary.model,
    missingness: summary.missingness,
    conflict: build.conflict,
    staleness: summary.staleness,
  });

  const inferenceResultIds = [
    ...new Set(summary.contributing.flatMap((item) => item.inferenceResultIds)),
  ].sort();

  const value = build.value === undefined ? null : build.value;
  const changed =
    input.previous === null ||
    JSON.stringify(input.previous.value ?? null) !== JSON.stringify(value ?? null) ||
    JSON.stringify(input.previous.uncertainty) !== JSON.stringify(uncertainty);

  const state: BeliefState = {
    schemaVersion: BELIEF_SCHEMA_VERSION,
    key: input.key,
    scope: input.scope,
    value,
    uncertainty,
    evidenceSignalIds: [...new Set(summary.contributing.map((item) => item.signalId))].sort(),
    inferenceResultIds,
    assumptions,
    fusionStrategy: build.strategy,
    fusionVersion: build.version,
    revision: (input.previous?.revision ?? 0) + (changed ? 1 : 0),
  };
  if (build.validFrom !== undefined) state.validFrom = build.validFrom;
  if (build.validUntil !== undefined) state.validUntil = build.validUntil;
  return state;
}

export function weightedDissent(
  values: readonly { weight: number; agrees: boolean }[],
): number {
  const total = values.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return 0;
  const dissent = values
    .filter((item) => !item.agrees)
    .reduce((sum, item) => sum + item.weight, 0);
  return Math.min(1, Math.max(0, dissent / total));
}
