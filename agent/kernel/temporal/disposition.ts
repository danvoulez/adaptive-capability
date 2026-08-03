import { isIsoTimestamp, type IsoTimestamp } from '../contracts/common.ts';
import type { TemporalDisposition, WatermarkState } from '../contracts/signal.ts';

export interface TemporalPolicy {
  allowedLatenessMs: number;
  correctionWindowMs: number;
  maximumFutureSkewMs: number;
}

export interface TemporalClassificationInput {
  observedAt: IsoTimestamp;
  receivedAt: IsoTimestamp;
  /** Kernel processing time, injected. Reducers never read the real clock. */
  processedAt: IsoTimestamp;
  watermark: WatermarkState | null;
  policy: TemporalPolicy;
}

/**
 * Pure classification of an event time against the current watermark.
 *
 * `duplicate` is not produced here; deduplication is a separate stage that runs
 * before classification.
 */
export function classifyTemporalDisposition(
  input: TemporalClassificationInput,
): TemporalDisposition {
  const { observedAt, receivedAt, processedAt, watermark, policy } = input;

  if (!isIsoTimestamp(observedAt) || !isIsoTimestamp(receivedAt) || !isIsoTimestamp(processedAt)) {
    return 'invalid_time';
  }
  if (
    !Number.isFinite(policy.allowedLatenessMs) ||
    !Number.isFinite(policy.correctionWindowMs) ||
    !Number.isFinite(policy.maximumFutureSkewMs)
  ) {
    return 'invalid_time';
  }

  const observed = Date.parse(observedAt);
  const processed = Date.parse(processedAt);

  if (observed - processed > policy.maximumFutureSkewMs) return 'future_dated';

  if (!watermark || !isIsoTimestamp(watermark.currentWatermark)) return 'on_time';

  const lateness = Date.parse(watermark.currentWatermark) - observed;
  if (lateness <= 0) return 'on_time';
  if (lateness <= policy.correctionWindowMs) return 'late_correctable';
  return 'late_historical_only';
}
