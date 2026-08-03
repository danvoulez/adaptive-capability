import {
  type IsoTimestamp,
  type VersionedObject,
} from './common.ts';
import type { BeliefState } from './belief.ts';

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = 'powerfarm.context-snapshot.v1';

/**
 * The current governed understanding of one scope. Snapshots are immutable
 * values: every projection produces a new revision rather than mutating the
 * previous one.
 */
export interface ContextSnapshot extends VersionedObject {
  schemaVersion: typeof CONTEXT_SNAPSHOT_SCHEMA_VERSION;
  scope: string;
  /** Evaluation time this projection was computed for. */
  asOf: IsoTimestamp;
  revision: number;
  /** Configuration version the projection was computed under. */
  configVersion: string;
  beliefs: Readonly<Record<string, BeliefState>>;
  /** Belief keys recomputed in this revision. */
  changedBeliefKeys: readonly string[];
  /** Belief keys whose current value is unknown. */
  unknownBeliefKeys: readonly string[];
}

export interface ContextQuery {
  scope: string;
  beliefKeys?: readonly string[];
}
