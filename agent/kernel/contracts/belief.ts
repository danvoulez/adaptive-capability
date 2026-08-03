import { z } from 'zod';

import {
  identifierSchema,
  isoTimestampSchema,
  labelSchema,
  unitIntervalSchema,
  type IsoTimestamp,
  type UnitInterval,
  type VersionedObject,
} from './common.ts';

export const BELIEF_SCHEMA_VERSION = 'powerfarm.belief.v1';

/**
 * Separate uncertainty dimensions. `summary` is a display and routing aid only;
 * material policy input must read the dimensions themselves.
 */
export interface UncertaintyState {
  measurement: UnitInterval;
  model: UnitInterval;
  missingness: UnitInterval;
  conflict: UnitInterval;
  staleness: UnitInterval;
  summary: UnitInterval;
}

export interface BeliefState<T = unknown> extends VersionedObject {
  schemaVersion: typeof BELIEF_SCHEMA_VERSION;
  key: string;
  scope: string;
  /** `null` means unknown. It never means false, zero, or empty. */
  value: T | null;
  uncertainty: UncertaintyState;
  validFrom?: IsoTimestamp;
  validUntil?: IsoTimestamp;
  evidenceSignalIds: readonly string[];
  inferenceResultIds: readonly string[];
  assumptions: readonly string[];
  fusionStrategy: string;
  fusionVersion: string;
  revision: number;
}

export const uncertaintyDimensions = [
  'measurement',
  'model',
  'missingness',
  'conflict',
  'staleness',
] as const;

export type UncertaintyDimension = (typeof uncertaintyDimensions)[number];

export function clampUnitInterval(value: number): UnitInterval {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * The summary is the most alarming dimension rather than an average, so that a
 * single strong conflict is never diluted by four calm dimensions.
 */
export function summarizeUncertainty(
  partial: Partial<Record<UncertaintyDimension, number>>,
): UncertaintyState {
  const resolved = {
    measurement: clampUnitInterval(partial.measurement ?? 0),
    model: clampUnitInterval(partial.model ?? 0),
    missingness: clampUnitInterval(partial.missingness ?? 0),
    conflict: clampUnitInterval(partial.conflict ?? 0),
    staleness: clampUnitInterval(partial.staleness ?? 0),
  };
  return {
    ...resolved,
    summary: Math.max(...uncertaintyDimensions.map((dimension) => resolved[dimension])),
  };
}

/** Uncertainty of a belief that has no usable evidence at all. */
export const unknownUncertainty: UncertaintyState = Object.freeze(
  summarizeUncertainty({ measurement: 1, missingness: 1, staleness: 1 }),
);

export const uncertaintyStateSchema = z.object({
  measurement: unitIntervalSchema,
  model: unitIntervalSchema,
  missingness: unitIntervalSchema,
  conflict: unitIntervalSchema,
  staleness: unitIntervalSchema,
  summary: unitIntervalSchema,
});

export const beliefStateSchema = z.object({
  schemaVersion: z.literal(BELIEF_SCHEMA_VERSION),
  key: labelSchema,
  scope: labelSchema,
  value: z.unknown(),
  uncertainty: uncertaintyStateSchema,
  validFrom: isoTimestampSchema.optional(),
  validUntil: isoTimestampSchema.optional(),
  evidenceSignalIds: z.array(identifierSchema),
  inferenceResultIds: z.array(identifierSchema),
  assumptions: z.array(labelSchema),
  fusionStrategy: labelSchema,
  fusionVersion: labelSchema,
  revision: z.number().int().min(0),
});
