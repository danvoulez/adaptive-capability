import { z } from 'zod';

import {
  identifierSchema,
  isoTimestampSchema,
  kernelLimits,
  labelSchema,
  unitIntervalSchema,
  type IsoTimestamp,
  type UnitInterval,
  type VersionedObject,
} from './common.ts';

export const SIGNAL_SCHEMA_VERSION = 'powerfarm.signal.v1';
export const STORED_SIGNAL_SCHEMA_VERSION = 'powerfarm.stored-signal.v1';
export const WATERMARK_SCHEMA_VERSION = 'powerfarm.watermark.v1';
export const INGESTION_RESULT_SCHEMA_VERSION = 'powerfarm.ingestion-result.v1';
export const BATCH_INGESTION_RESULT_SCHEMA_VERSION = 'powerfarm.batch-ingestion-result.v1';

export type SignalClass =
  | 'observation'
  | 'event'
  | 'assertion'
  | 'missingness'
  | 'feedback'
  | 'derived';

export type SignalAcquisition =
  | 'passive'
  | 'active_probe'
  | 'human_input'
  | 'batch_import'
  | 'derived';

export type SignalCadence = 'realtime' | 'periodic' | 'batch' | 'one_shot' | 'unknown';

export type MissingReason =
  | 'not_observed'
  | 'not_applicable'
  | 'sensor_offline'
  | 'permission_denied'
  | 'timeout'
  | 'source_error'
  | 'redacted'
  | 'unknown';

export type SignalSensitivity = 'public' | 'internal' | 'sensitive' | 'restricted';

export interface MeasurementUncertainty {
  kind: 'absolute' | 'relative' | 'distribution';
  value?: number;
  unit?: string;
  distribution?: unknown;
}

export interface SignalMissingness {
  reason: MissingReason;
  expectedAt?: IsoTimestamp;
  retryable?: boolean;
}

export interface SignalQuality {
  sourceReliability?: UnitInterval;
  authenticity?: UnitInterval;
  completeness?: UnitInterval;
  coverage?: UnitInterval;
  precision?: UnitInterval;
  measurementUncertainty?: MeasurementUncertainty;
  calibrationRef?: string;
}

export interface SignalProvenance {
  adapterId: string;
  adapterVersion: string;
  originalId?: string;
  rawArtifactRef?: string;
  contentHash?: string;
  signature?: string;
  signer?: string;
  derivedFrom?: readonly string[];
  transformationId?: string;
  modelRef?: string;
  promptHash?: string;
  outputSchemaHash?: string;
}

export interface SignalHandling {
  tenantId: string;
  sensitivity: SignalSensitivity;
  retentionClass: string;
  allowedPurposes?: readonly string[];
}

export interface SignalEnvelope<T = unknown> extends VersionedObject {
  schemaVersion: typeof SIGNAL_SCHEMA_VERSION;

  id: string;
  type: string;
  source: string;
  subject: string;
  scope: string;

  class: SignalClass;
  acquisition: SignalAcquisition;
  cadence: SignalCadence;

  observedAt: IsoTimestamp;
  receivedAt: IsoTimestamp;
  validFrom?: IsoTimestamp;
  validUntil?: IsoTimestamp;

  sequence?: number;
  correlationId?: string;
  causationId?: string;

  data?: T;
  dataSchemaRef?: string;

  missing?: SignalMissingness;
  quality: SignalQuality;
  provenance: SignalProvenance;
  handling: SignalHandling;
}

const measurementUncertaintySchema = z.object({
  kind: z.enum(['absolute', 'relative', 'distribution']),
  value: z.number().optional(),
  unit: labelSchema.optional(),
  distribution: z.unknown().optional(),
});

const qualitySchema = z.object({
  sourceReliability: unitIntervalSchema.optional(),
  authenticity: unitIntervalSchema.optional(),
  completeness: unitIntervalSchema.optional(),
  coverage: unitIntervalSchema.optional(),
  precision: unitIntervalSchema.optional(),
  measurementUncertainty: measurementUncertaintySchema.optional(),
  calibrationRef: labelSchema.optional(),
});

const provenanceSchema = z.object({
  adapterId: identifierSchema,
  adapterVersion: labelSchema,
  originalId: identifierSchema.optional(),
  rawArtifactRef: labelSchema.optional(),
  contentHash: labelSchema.optional(),
  signature: z.string().min(1).max(kernelLimits.labelMaxLength).optional(),
  signer: labelSchema.optional(),
  derivedFrom: z.array(identifierSchema).max(kernelLimits.derivedFromMax).optional(),
  transformationId: identifierSchema.optional(),
  modelRef: labelSchema.optional(),
  promptHash: labelSchema.optional(),
  outputSchemaHash: labelSchema.optional(),
});

const handlingSchema = z.object({
  tenantId: identifierSchema,
  sensitivity: z.enum(['public', 'internal', 'sensitive', 'restricted']),
  retentionClass: labelSchema,
  allowedPurposes: z.array(labelSchema).max(kernelLimits.allowedPurposesMax).optional(),
});

const missingSchema = z.object({
  reason: z.enum([
    'not_observed',
    'not_applicable',
    'sensor_offline',
    'permission_denied',
    'timeout',
    'source_error',
    'redacted',
    'unknown',
  ]),
  expectedAt: isoTimestampSchema.optional(),
  retryable: z.boolean().optional(),
});

const baseSignalSchema = z.object({
  schemaVersion: z.literal(SIGNAL_SCHEMA_VERSION),
  id: identifierSchema,
  type: labelSchema,
  source: labelSchema,
  subject: labelSchema,
  scope: labelSchema,
  class: z.enum(['observation', 'event', 'assertion', 'missingness', 'feedback', 'derived']),
  acquisition: z.enum(['passive', 'active_probe', 'human_input', 'batch_import', 'derived']),
  cadence: z.enum(['realtime', 'periodic', 'batch', 'one_shot', 'unknown']),
  observedAt: isoTimestampSchema,
  receivedAt: isoTimestampSchema,
  validFrom: isoTimestampSchema.optional(),
  validUntil: isoTimestampSchema.optional(),
  sequence: z.number().int().optional(),
  correlationId: identifierSchema.optional(),
  causationId: identifierSchema.optional(),
  data: z.unknown().optional(),
  dataSchemaRef: labelSchema.optional(),
  missing: missingSchema.optional(),
  quality: qualitySchema,
  provenance: provenanceSchema,
  handling: handlingSchema,
});

/**
 * Structural and invariant validation for a signal envelope.
 *
 * The relation between `validUntil` and `observedAt` is not enforced here
 * because a retrospective interval is only permitted for data schemas that the
 * operator has explicitly configured as retrospective. That check belongs to
 * kernel validation, which can read configuration.
 */
export const signalEnvelopeSchema = baseSignalSchema.superRefine((signal, ctx) => {
  const hasData = Object.prototype.hasOwnProperty.call(signal, 'data') && signal.data !== undefined;
  const hasMissing = signal.missing !== undefined;

  if (hasData && hasMissing) {
    ctx.addIssue({
      code: 'custom',
      path: ['data'],
      message: 'data and missing may not both be present',
    });
  }
  if (!hasData && !hasMissing) {
    ctx.addIssue({
      code: 'custom',
      path: ['data'],
      message: 'either data or missing must be present',
    });
  }
  if (signal.class === 'derived' && (signal.provenance.derivedFrom ?? []).length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['provenance', 'derivedFrom'],
      message: 'derived signals must reference at least one origin signal id',
    });
  }
  const modelShaped =
    signal.provenance.promptHash !== undefined || signal.provenance.outputSchemaHash !== undefined;
  if (modelShaped && signal.provenance.modelRef === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['provenance', 'modelRef'],
      message: 'model-derived signals must declare provenance.modelRef',
    });
  }
  if (signal.provenance.modelRef !== undefined && signal.class !== 'derived') {
    ctx.addIssue({
      code: 'custom',
      path: ['class'],
      message: 'a signal carrying provenance.modelRef must be class derived',
    });
  }
  if (
    signal.validFrom !== undefined &&
    signal.validUntil !== undefined &&
    Date.parse(signal.validUntil) < Date.parse(signal.validFrom)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['validUntil'],
      message: 'validUntil must not precede validFrom',
    });
  }
});

export type TemporalDisposition =
  | 'on_time'
  | 'late_correctable'
  | 'late_historical_only'
  | 'future_dated'
  | 'duplicate'
  | 'invalid_time';

export const temporalDispositions: readonly TemporalDisposition[] = [
  'on_time',
  'late_correctable',
  'late_historical_only',
  'future_dated',
  'duplicate',
  'invalid_time',
];

export interface WatermarkState extends VersionedObject {
  schemaVersion: typeof WATERMARK_SCHEMA_VERSION;
  source: string;
  scope: string;
  maximumObservedAt: IsoTimestamp;
  currentWatermark: IsoTimestamp;
  allowedLatenessMs: number;
  updatedAt: IsoTimestamp;
}

/** Origin of the reliability the kernel is willing to use for a source. */
export type SourceReliabilityOrigin = 'configured' | 'unknown';

export interface StoredSignal extends VersionedObject {
  schemaVersion: typeof STORED_SIGNAL_SCHEMA_VERSION;
  /** The admitted envelope, immutable after admission. */
  signal: SignalEnvelope;
  contentHash: string;
  processedAt: IsoTimestamp;
  disposition: TemporalDisposition;
  /** Deterministic admission order, assigned by the store. */
  admissionSequence: number;
  /**
   * Reliability the kernel trusts for this source. `null` means unknown; it is
   * never silently coerced to zero.
   */
  sourceReliability: UnitInterval | null;
  sourceReliabilityOrigin: SourceReliabilityOrigin;
}

export interface SignalQuery {
  source?: string;
  scope?: string;
  subject?: string;
  type?: string;
  observedFrom?: IsoTimestamp;
  observedUntil?: IsoTimestamp;
  limit?: number;
}

/** `withheld` means the pipeline was stopped before the persistence stage. */
export type IngestionAdmission = 'admitted' | 'duplicate' | 'withheld';

/** Stages of the ingestion pipeline implemented in this milestone. */
export type IngestionStage =
  | 'validate'
  | 'reject_secrets'
  | 'hash'
  | 'deduplicate'
  | 'classify_temporal'
  | 'persist_signal'
  | 'update_watermark'
  | 'index_affected_beliefs'
  | 'project_context'
  | 'recompute_beliefs';

export const ingestionStages: readonly IngestionStage[] = [
  'validate',
  'reject_secrets',
  'hash',
  'deduplicate',
  'classify_temporal',
  'persist_signal',
  'update_watermark',
  'index_affected_beliefs',
  'project_context',
  'recompute_beliefs',
];

export interface IngestionResult extends VersionedObject {
  schemaVersion: typeof INGESTION_RESULT_SCHEMA_VERSION;
  signalId: string;
  admission: IngestionAdmission;
  disposition: TemporalDisposition;
  contentHash: string;
  processedAt: IsoTimestamp;
  stagesExecuted: readonly IngestionStage[];
  watermark: WatermarkState | null;
  /** Context revision produced by this ingestion, when beliefs are registered. */
  contextRevision: number | null;
  /** Belief keys whose value or uncertainty changed because of this signal. */
  changedBeliefKeys: readonly string[];
}

export type BatchItemStatus = 'admitted' | 'duplicate' | 'withheld' | 'rejected';

export interface BatchIngestionItem {
  index: number;
  signalId: string | null;
  status: BatchItemStatus;
  result: IngestionResult | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface BatchIngestionResult extends VersionedObject {
  schemaVersion: typeof BATCH_INGESTION_RESULT_SCHEMA_VERSION;
  atomic: boolean;
  admittedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  items: readonly BatchIngestionItem[];
}
