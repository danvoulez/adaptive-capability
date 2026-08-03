import { BELIEF_SCHEMA_VERSION, unknownUncertainty } from '../../contracts/belief.ts';
import type { BeliefComputeFunction } from '../definition.ts';

export const EXPLICIT_UNKNOWN_VERSION = '1.0.0';

/**
 * Explicit unknown.
 *
 * Used when a belief is registered but cannot yet be concluded. The kernel must
 * be able to say "I do not know" as a first-class answer rather than emitting a
 * default that later reads as a measurement.
 */
export function explicitUnknown(reason = 'not-yet-determined'): BeliefComputeFunction {
  return (input) => ({
    schemaVersion: BELIEF_SCHEMA_VERSION,
    key: input.key,
    scope: input.scope,
    value: null,
    uncertainty: unknownUncertainty,
    evidenceSignalIds: [],
    inferenceResultIds: [],
    assumptions: [`explicit-unknown:${reason}`],
    fusionStrategy: 'explicit_unknown',
    fusionVersion: EXPLICIT_UNKNOWN_VERSION,
    revision: (input.previous?.revision ?? 0) + (input.previous === null ? 1 : 0),
  });
}
