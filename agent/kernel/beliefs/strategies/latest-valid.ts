import type { BeliefComputeFunction } from '../definition.ts';
import { buildBeliefState, summarizeEvidence, weightedDissent } from './shared.ts';

export const LATEST_VALID_VERSION = '1.0.0';

export interface LatestValidOptions {
  /** Values are compared with this predicate when raising conflict. */
  equals?: (left: unknown, right: unknown) => boolean;
}

function defaultEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Takes the most recently observed non-expired value.
 *
 * Trusted sources that disagree with the chosen value still raise conflict; the
 * newest reading wins the value but does not silence the disagreement.
 */
export function latestValidValue(options: LatestValidOptions = {}): BeliefComputeFunction {
  const equals = options.equals ?? defaultEquals;

  return (input) => {
    const summary = summarizeEvidence(input);
    const fresh = summary.contributing.filter((item) => !item.expired);
    const pool = fresh.length > 0 ? fresh : [];

    if (pool.length === 0) {
      return buildBeliefState({
        input,
        value: null,
        summary,
        conflict: 0,
        strategy: 'latest_valid',
        version: LATEST_VALID_VERSION,
        extraAssumptions: summary.contributing.length > 0 ? ['all-evidence-expired'] : [],
      });
    }

    const chosen = pool.reduce((latest, item) =>
      Date.parse(item.observedAt) >= Date.parse(latest.observedAt) ? item : latest,
    );

    const conflict = weightedDissent(
      summary.trusted
        .filter((item) => !item.expired)
        .map((item) => ({ weight: item.weight, agrees: equals(item.value, chosen.value) })),
    );

    return buildBeliefState({
      input,
      value: chosen.value,
      summary,
      conflict,
      strategy: 'latest_valid',
      version: LATEST_VALID_VERSION,
      validFrom: chosen.observedAt,
    });
  };
}
