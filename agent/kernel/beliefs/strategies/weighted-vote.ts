import type { BeliefComputeFunction } from '../definition.ts';
import { buildBeliefState, summarizeEvidence, weightedDissent } from './shared.ts';

export const WEIGHTED_VOTE_VERSION = '1.0.0';

export interface WeightedVoteOptions {
  /** Categories the belief may take. Anything else fails closed as unknown. */
  categories?: readonly string[];
  /** Minimum share of total weight the winner needs. Below it, unknown. */
  minimumShare?: number;
}

function categoryOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Weighted categorical vote. A tie or a winner below the configured share stays
 * unknown rather than picking arbitrarily.
 */
export function weightedCategoricalVote(
  options: WeightedVoteOptions = {},
): BeliefComputeFunction {
  const minimumShare = options.minimumShare ?? 0.5;

  return (input) => {
    const summary = summarizeEvidence(input);
    const tally = new Map<string, number>();
    const unknownCategories: string[] = [];

    for (const item of summary.contributing) {
      const category = categoryOf(item.value);
      if (category === null) continue;
      if (options.categories && !options.categories.includes(category)) {
        unknownCategories.push(category);
        continue;
      }
      tally.set(category, (tally.get(category) ?? 0) + item.weight);
    }

    const totalWeight = [...tally.values()].reduce((sum, weight) => sum + weight, 0);
    const ranked = [...tally.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    );
    const leader = ranked[0];
    const tied = ranked.length > 1 && ranked[1][1] === leader?.[1];
    const share = leader && totalWeight > 0 ? leader[1] / totalWeight : 0;

    const extraAssumptions = unknownCategories.length
      ? [`unrecognized-categories:${[...new Set(unknownCategories)].sort().join('|')}`]
      : [];

    if (!leader || tied || share < minimumShare) {
      return buildBeliefState({
        input,
        value: null,
        summary,
        conflict: leader ? weightedDissent(
          summary.trusted.map((item) => ({
            weight: item.weight,
            agrees: categoryOf(item.value) === leader[0],
          })),
        ) : 0,
        strategy: 'weighted_vote',
        version: WEIGHTED_VOTE_VERSION,
        extraAssumptions: [
          ...extraAssumptions,
          ...(tied ? ['tied-vote'] : []),
          ...(leader && !tied && share < minimumShare ? [`below-minimum-share:${minimumShare}`] : []),
        ],
      });
    }

    const conflict = weightedDissent(
      summary.trusted.map((item) => ({
        weight: item.weight,
        agrees: categoryOf(item.value) === leader[0],
      })),
    );

    return buildBeliefState({
      input,
      value: leader[0],
      summary,
      conflict,
      strategy: 'weighted_vote',
      version: WEIGHTED_VOTE_VERSION,
      extraAssumptions,
    });
  };
}
