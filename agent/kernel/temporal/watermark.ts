import { toEpochMs, toIsoTimestamp, type IsoTimestamp } from '../contracts/common.ts';
import { kernelError } from '../errors.ts';
import {
  WATERMARK_SCHEMA_VERSION,
  type TemporalDisposition,
  type WatermarkState,
} from '../contracts/signal.ts';

export interface WatermarkAdvanceInput {
  current: WatermarkState | null;
  source: string;
  scope: string;
  observedAt: IsoTimestamp;
  disposition: TemporalDisposition;
  allowedLatenessMs: number;
  /** Injected processing time. */
  at: IsoTimestamp;
}

/**
 * Pure watermark reducer.
 *
 * The maximum observed event time never regresses, and a future-dated event
 * never advances it: otherwise a single skewed sender could mark every later
 * honest event as historical.
 */
export function advanceWatermark(input: WatermarkAdvanceInput): WatermarkState {
  const { current, source, scope, observedAt, disposition, allowedLatenessMs, at } = input;

  if (!Number.isFinite(allowedLatenessMs) || allowedLatenessMs < 0) {
    throw kernelError(
      'POWERFARM_KERNEL_TEMPORAL_DISPOSITION_INVALID',
      'allowedLatenessMs must be a non-negative finite number',
      { source, scope },
    );
  }

  const processed = toEpochMs(at, 'processedAt');
  const observed = toEpochMs(observedAt, 'observedAt');
  const previousMaximum =
    current === null ? null : toEpochMs(current.maximumObservedAt, 'maximumObservedAt');

  let maximum: number;
  if (disposition === 'future_dated') {
    maximum = previousMaximum ?? processed;
  } else {
    maximum = previousMaximum === null ? observed : Math.max(previousMaximum, observed);
  }

  return {
    schemaVersion: WATERMARK_SCHEMA_VERSION,
    source,
    scope,
    maximumObservedAt: toIsoTimestamp(maximum, 'maximumObservedAt'),
    currentWatermark: toIsoTimestamp(maximum - allowedLatenessMs, 'currentWatermark'),
    allowedLatenessMs,
    updatedAt: at,
  };
}
