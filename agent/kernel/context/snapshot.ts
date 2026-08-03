import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  type ContextSnapshot,
} from '../contracts/context.ts';
import type { BeliefState } from '../contracts/belief.ts';
import type { IsoTimestamp } from '../contracts/common.ts';

export interface EmptySnapshotInput {
  scope: string;
  asOf: IsoTimestamp;
  configVersion: string;
}

export function createEmptyContextSnapshot(input: EmptySnapshotInput): ContextSnapshot {
  return {
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    scope: input.scope,
    asOf: input.asOf,
    revision: 0,
    configVersion: input.configVersion,
    beliefs: {},
    changedBeliefKeys: [],
    unknownBeliefKeys: [],
  };
}

export function unknownBeliefKeys(
  beliefs: Readonly<Record<string, BeliefState>>,
): readonly string[] {
  return Object.keys(beliefs)
    .filter((key) => beliefs[key]?.value === null)
    .sort();
}

/** Reads a belief without exposing the snapshot's internal reference. */
export function readBelief(
  snapshot: ContextSnapshot,
  key: string,
): BeliefState | null {
  const found = snapshot.beliefs[key];
  return found ? structuredClone(found) : null;
}
