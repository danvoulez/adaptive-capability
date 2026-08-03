import { canonicalJson, sha256 } from '../../lib/institutional-event.ts';
import type { EvidenceReference } from '../contracts/common.ts';

export interface EvidenceReferenceInput {
  signalIds?: readonly string[];
  inferenceResultIds?: readonly string[];
  beliefKeys?: readonly string[];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

/**
 * Builds a stable evidence reference. Identifiers are deduplicated and sorted so
 * that the same evidence set always yields the same hash, whatever order the
 * pipeline happened to visit it in.
 */
export function buildEvidenceReference(input: EvidenceReferenceInput): EvidenceReference {
  const signalIds = unique(input.signalIds ?? []);
  const inferenceResultIds = unique(input.inferenceResultIds ?? []);
  const beliefKeys = unique(input.beliefKeys ?? []);
  return {
    signalIds,
    inferenceResultIds,
    beliefKeys,
    evidenceHash: sha256(canonicalJson({ beliefKeys, inferenceResultIds, signalIds })),
  };
}
