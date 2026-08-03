import { kernelError } from '../../errors.ts';
import type { BeliefComputeFunction } from '../definition.ts';
import { buildBeliefState, summarizeEvidence } from './shared.ts';

export const WEIGHTED_MEAN_VERSION = '1.0.0';

export interface WeightedMeanOptions {
  /**
   * Spread, in the unit of the measured value, that counts as full conflict.
   * Required: there is no universal tolerance for a physical quantity.
   */
  conflictTolerance: number;
}

/**
 * Weighted arithmetic mean over numeric evidence.
 *
 * Disagreement is reported rather than averaged away: the weighted mean absolute
 * deviation of trusted sources is scaled against the configured tolerance and
 * surfaced as `uncertainty.conflict`.
 */
export function weightedMean(options: WeightedMeanOptions): BeliefComputeFunction {
  if (!Number.isFinite(options.conflictTolerance) || options.conflictTolerance <= 0) {
    throw kernelError('POWERFARM_KERNEL_CONFIG_INVALID', 'conflictTolerance must be positive', {
      field: 'conflictTolerance',
    });
  }

  return (input) => {
    const summary = summarizeEvidence(input);
    const numeric = summary.contributing.filter(
      (item) => typeof item.value === 'number' && Number.isFinite(item.value),
    );

    if (numeric.length !== summary.contributing.length) {
      throw kernelError('POWERFARM_KERNEL_TREND_INPUT_INVALID', 'weighted mean requires numbers', {
        beliefKey: input.key,
      });
    }
    if (numeric.length === 0 || summary.totalWeight <= 0) {
      return buildBeliefState({
        input,
        value: null,
        summary,
        conflict: 0,
        strategy: 'weighted_mean',
        version: WEIGHTED_MEAN_VERSION,
      });
    }

    const fused =
      numeric.reduce((sum, item) => sum + (item.value as number) * item.weight, 0) /
      summary.totalWeight;

    const trusted = summary.trusted.filter((item) => typeof item.value === 'number');
    const trustedWeight = trusted.reduce((sum, item) => sum + item.weight, 0);
    // Conflict is disagreement among trusted voices about each other, not their
    // distance from a mean that a weak source may have pulled sideways.
    const trustedMean =
      trustedWeight > 0
        ? trusted.reduce((sum, item) => sum + (item.value as number) * item.weight, 0) /
          trustedWeight
        : fused;
    const dispersion =
      trustedWeight > 0
        ? trusted.reduce(
            (sum, item) => sum + item.weight * Math.abs((item.value as number) - trustedMean),
            0,
          ) / trustedWeight
        : 0;

    return buildBeliefState({
      input,
      value: fused,
      summary,
      conflict: Math.min(1, dispersion / options.conflictTolerance),
      strategy: 'weighted_mean',
      version: WEIGHTED_MEAN_VERSION,
      extraAssumptions: [`conflict-tolerance:${options.conflictTolerance}`],
    });
  };
}
