export {
  KernelError,
  isKernelError,
  kernelError,
  kernelErrorCodes,
  sanitizeErrorText,
  type KernelErrorCode,
  type KernelErrorDetails,
} from './errors.ts';

export {
  evidenceReferenceSchema,
  identifierSchema,
  isIsoTimestamp,
  isoTimestampSchema,
  kernelLimits,
  labelSchema,
  toEpochMs,
  toIsoTimestamp,
  unitIntervalSchema,
  type EvidenceReference,
  type IsoTimestamp,
  type UnitInterval,
  type VersionedObject,
} from './contracts/common.ts';

export {
  BATCH_INGESTION_RESULT_SCHEMA_VERSION,
  INGESTION_RESULT_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  STORED_SIGNAL_SCHEMA_VERSION,
  WATERMARK_SCHEMA_VERSION,
  ingestionStages,
  signalEnvelopeSchema,
  temporalDispositions,
  type BatchIngestionItem,
  type BatchIngestionResult,
  type IngestionAdmission,
  type IngestionResult,
  type IngestionStage,
  type SignalEnvelope,
  type SignalQuery,
  type StoredSignal,
  type TemporalDisposition,
  type WatermarkState,
} from './contracts/signal.ts';

export {
  FixedKernelClock,
  SystemKernelClock,
  nowIso,
  type KernelClock,
} from './core/clock.ts';

export {
  DeterministicKernelIdFactory,
  SystemKernelIdFactory,
  type KernelIdFactory,
} from './core/ids.ts';

export {
  assertNoKernelSecretFields,
  assertSignalPolicy,
  assertSignalSizeBound,
  hashSignalEnvelope,
  parseSignalEnvelope,
} from './core/validation.ts';

export { InMemoryKernelStore } from './storage/memory-store.ts';
export { watermarkKey, type KernelSignalStore } from './storage/store.ts';

export {
  classifyTemporalDisposition,
  type TemporalClassificationInput,
  type TemporalPolicy,
} from './temporal/disposition.ts';
export { advanceWatermark, type WatermarkAdvanceInput } from './temporal/watermark.ts';

export {
  createAdaptiveCapabilityKernel,
  defaultKernelConfig,
  resolveKernelConfig,
  resolveTemporalPolicy,
  type AdaptiveCapabilityKernel,
  type BatchIngestOptions,
  type IngestOptions,
  type KernelConfig,
  type KernelDependencies,
  type KernelSourcePolicy,
} from './kernel.ts';

export {
  BELIEF_SCHEMA_VERSION,
  beliefStateSchema,
  clampUnitInterval,
  summarizeUncertainty,
  uncertaintyDimensions,
  uncertaintyStateSchema,
  unknownUncertainty,
  type BeliefState,
  type UncertaintyDimension,
  type UncertaintyState,
} from './contracts/belief.ts';

export {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  type ContextQuery,
  type ContextSnapshot,
} from './contracts/context.ts';

export { buildEvidenceReference, type EvidenceReferenceInput } from './core/evidence.ts';
export { DependencyIndex } from './core/dependency-index.ts';

export {
  assessFreshness,
  defaultFreshnessProfiles,
  type FreshnessAssessment,
  type FreshnessMode,
  type FreshnessProfile,
} from './temporal/freshness.ts';

export {
  defaultBeliefFusionOptions,
  type BeliefComputationInput,
  type BeliefComputeFunction,
  type BeliefDefinition,
  type BeliefEvidenceItem,
  type BeliefFusionOptions,
} from './beliefs/definition.ts';

export { BeliefRegistry } from './beliefs/registry.ts';
export {
  buildEvidenceItem,
  recomputeBeliefs,
  type BeliefRecomputationInput,
  type BeliefRecomputationResult,
} from './beliefs/engine.ts';

export { latestValidValue, LATEST_VALID_VERSION } from './beliefs/strategies/latest-valid.ts';
export { weightedMean, WEIGHTED_MEAN_VERSION } from './beliefs/strategies/weighted-mean.ts';
export {
  weightedCategoricalVote,
  WEIGHTED_VOTE_VERSION,
} from './beliefs/strategies/weighted-vote.ts';
export {
  deterministicRule,
  type DeterministicRuleOptions,
} from './beliefs/strategies/deterministic-rule.ts';
export { explicitUnknown, EXPLICIT_UNKNOWN_VERSION } from './beliefs/strategies/unknown.ts';

export {
  createEmptyContextSnapshot,
  readBelief,
  unknownBeliefKeys,
} from './context/snapshot.ts';
export {
  projectContext,
  type ContextProjectionInput,
  type ContextProjectionResult,
} from './context/projector.ts';

export type { KernelContextStore, KernelStore } from './storage/store.ts';
