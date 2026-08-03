import { kernelError, isKernelError } from './errors.ts';
import {
  kernelLimits,
  type IsoTimestamp,
  type UnitInterval,
} from './contracts/common.ts';
import {
  BATCH_INGESTION_RESULT_SCHEMA_VERSION,
  INGESTION_RESULT_SCHEMA_VERSION,
  STORED_SIGNAL_SCHEMA_VERSION,
  ingestionStages,
  type BatchIngestionItem,
  type BatchIngestionResult,
  type IngestionResult,
  type IngestionStage,
  type SignalEnvelope,
  type SignalQuery,
  type SourceReliabilityOrigin,
  type StoredSignal,
  type TemporalDisposition,
  type WatermarkState,
} from './contracts/signal.ts';
import { nowIso, SystemKernelClock, type KernelClock } from './core/clock.ts';
import type { KernelIdFactory } from './core/ids.ts';
import {
  assertNoKernelSecretFields,
  assertSignalPolicy,
  assertSignalSizeBound,
  hashSignalEnvelope,
  parseSignalEnvelope,
} from './core/validation.ts';
import type { ContextQuery, ContextSnapshot } from './contracts/context.ts';
import { BeliefRegistry } from './beliefs/registry.ts';
import {
  defaultBeliefFusionOptions,
  type BeliefDefinition,
  type BeliefFusionOptions,
} from './beliefs/definition.ts';
import { DependencyIndex } from './core/dependency-index.ts';
import { projectContext } from './context/projector.ts';
import { createEmptyContextSnapshot } from './context/snapshot.ts';
import { defaultFreshnessProfiles, type FreshnessProfile } from './temporal/freshness.ts';
import { InMemoryKernelStore } from './storage/memory-store.ts';
import type { KernelStore } from './storage/store.ts';
import { classifyTemporalDisposition, type TemporalPolicy } from './temporal/disposition.ts';
import { advanceWatermark } from './temporal/watermark.ts';

export interface KernelSourcePolicy {
  temporal?: Partial<TemporalPolicy>;
  /** Trusted reliability for this source. Sender-supplied values are not used. */
  sourceReliability?: UnitInterval;
}

export interface KernelConfig {
  configVersion: string;
  temporal: TemporalPolicy;
  sources: Readonly<Record<string, KernelSourcePolicy>>;
  signalTypes: Readonly<Record<string, Partial<TemporalPolicy>>>;
  allowedSources?: readonly string[];
  allowedScopes?: readonly string[];
  maximumSignalBytes: number;
  maximumBatchSize: number;
  retrospectiveIntervalSchemaRefs: readonly string[];
}

export const defaultKernelConfig: KernelConfig = Object.freeze({
  configVersion: '1',
  temporal: Object.freeze({
    allowedLatenessMs: 30_000,
    correctionWindowMs: 300_000,
    maximumFutureSkewMs: 30_000,
  }),
  sources: Object.freeze({}),
  signalTypes: Object.freeze({}),
  maximumSignalBytes: kernelLimits.signalBytesMax,
  maximumBatchSize: kernelLimits.batchSizeMax,
  retrospectiveIntervalSchemaRefs: Object.freeze([]),
}) as KernelConfig;

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw kernelError('POWERFARM_KERNEL_CONFIG_INVALID', 'value must be a non-negative integer', {
      field,
    });
  }
}

function assertUnitInterval(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw kernelError('POWERFARM_KERNEL_CONFIG_INVALID', 'value must be within [0, 1]', { field });
  }
}

/** Configuration validation fails closed. */
export function resolveKernelConfig(overrides: Partial<KernelConfig> = {}): KernelConfig {
  const temporal: TemporalPolicy = {
    ...defaultKernelConfig.temporal,
    ...(overrides.temporal ?? {}),
  };
  assertNonNegativeInteger(temporal.allowedLatenessMs, 'temporal.allowedLatenessMs');
  assertNonNegativeInteger(temporal.correctionWindowMs, 'temporal.correctionWindowMs');
  assertNonNegativeInteger(temporal.maximumFutureSkewMs, 'temporal.maximumFutureSkewMs');

  const config: KernelConfig = {
    configVersion: overrides.configVersion ?? defaultKernelConfig.configVersion,
    temporal,
    sources: overrides.sources ?? defaultKernelConfig.sources,
    signalTypes: overrides.signalTypes ?? defaultKernelConfig.signalTypes,
    maximumSignalBytes: overrides.maximumSignalBytes ?? defaultKernelConfig.maximumSignalBytes,
    maximumBatchSize: overrides.maximumBatchSize ?? defaultKernelConfig.maximumBatchSize,
    retrospectiveIntervalSchemaRefs:
      overrides.retrospectiveIntervalSchemaRefs ?? defaultKernelConfig.retrospectiveIntervalSchemaRefs,
  };
  if (overrides.allowedSources) config.allowedSources = overrides.allowedSources;
  if (overrides.allowedScopes) config.allowedScopes = overrides.allowedScopes;

  assertNonNegativeInteger(config.maximumSignalBytes, 'maximumSignalBytes');
  assertNonNegativeInteger(config.maximumBatchSize, 'maximumBatchSize');
  if (config.configVersion.length === 0) {
    throw kernelError('POWERFARM_KERNEL_CONFIG_INVALID', 'configVersion must not be empty', {
      field: 'configVersion',
    });
  }

  for (const [source, policy] of Object.entries(config.sources)) {
    if (policy.sourceReliability !== undefined) {
      assertUnitInterval(policy.sourceReliability, `sources.${source}.sourceReliability`);
    }
    for (const [field, value] of Object.entries(policy.temporal ?? {})) {
      assertNonNegativeInteger(value as number, `sources.${source}.temporal.${field}`);
    }
  }
  for (const [type, policy] of Object.entries(config.signalTypes)) {
    for (const [field, value] of Object.entries(policy)) {
      assertNonNegativeInteger(value as number, `signalTypes.${type}.${field}`);
    }
  }

  return Object.freeze(config);
}

export function resolveTemporalPolicy(config: KernelConfig, signal: SignalEnvelope): TemporalPolicy {
  return {
    ...config.temporal,
    ...(config.sources[signal.source]?.temporal ?? {}),
    ...(config.signalTypes[signal.type] ?? {}),
  };
}

function resolveSourceReliability(
  config: KernelConfig,
  signal: SignalEnvelope,
): { value: UnitInterval | null; origin: SourceReliabilityOrigin } {
  const configured = config.sources[signal.source]?.sourceReliability;
  // Sender-supplied reliability is never trusted on its own; unknown stays unknown.
  return configured === undefined
    ? { value: null, origin: 'unknown' }
    : { value: configured, origin: 'configured' };
}

export interface IngestOptions {
  /** Stops the pipeline after the named stage. Used by deterministic tests. */
  stopAfter?: IngestionStage;
}

export interface BatchIngestOptions extends IngestOptions {
  /** All-or-nothing admission. Nothing is written when any item is rejected. */
  atomic?: boolean;
}

export interface AdaptiveCapabilityKernel {
  readonly config: KernelConfig;
  readonly store: KernelStore;
  readonly beliefs: BeliefRegistry;
  readonly dependencyIndex: DependencyIndex;
  ingest(signal: unknown, options?: IngestOptions): Promise<IngestionResult>;
  ingestBatch(signals: readonly unknown[], options?: BatchIngestOptions): Promise<BatchIngestionResult>;
  getWatermark(source: string, scope: string): Promise<WatermarkState | null>;
  listSignals(query?: SignalQuery): Promise<readonly StoredSignal[]>;
  getContext(request: ContextQuery): Promise<ContextSnapshot>;
}

export interface KernelDependencies {
  clock?: KernelClock;
  /** Reserved for kernel-generated identifiers from Milestone 2 onward. */
  ids?: KernelIdFactory;
  store?: KernelStore;
  config?: Partial<KernelConfig>;
  /** Registered belief definitions. An empty registry disables belief stages. */
  beliefs?: BeliefRegistry | readonly BeliefDefinition[];
  freshnessProfiles?: Readonly<Record<string, FreshnessProfile>>;
  fusionOptions?: BeliefFusionOptions;
}

interface PreparedSignal {
  signal: SignalEnvelope;
  contentHash: string;
  duplicateOfAdmitted: boolean;
}

function stageIndex(stage: IngestionStage): number {
  return ingestionStages.indexOf(stage);
}

function shouldStop(options: IngestOptions, stage: IngestionStage): boolean {
  return options.stopAfter !== undefined && stageIndex(options.stopAfter) <= stageIndex(stage);
}

export function createAdaptiveCapabilityKernel(
  dependencies: KernelDependencies = {},
): AdaptiveCapabilityKernel {
  const config = resolveKernelConfig(dependencies.config ?? {});
  const clock = dependencies.clock ?? new SystemKernelClock();
  const store = dependencies.store ?? new InMemoryKernelStore();
  const beliefs =
    dependencies.beliefs instanceof BeliefRegistry
      ? dependencies.beliefs
      : new BeliefRegistry(dependencies.beliefs ?? []);
  const dependencyIndex = new DependencyIndex(beliefs);
  const freshnessProfiles = dependencies.freshnessProfiles ?? defaultFreshnessProfiles;
  const fusionOptions = dependencies.fusionOptions ?? defaultBeliefFusionOptions;

  /** Every admitted signal a definition can draw on, in event-time order. */
  async function signalsFor(definition: BeliefDefinition, scope: string) {
    const collected = new Map<string, StoredSignal>();
    for (const signalType of definition.signalTypes) {
      const found = await store.listSignals({ scope: definition.scope ?? scope, type: signalType });
      for (const record of found) collected.set(record.signal.id, record);
    }
    return [...collected.values()].sort(
      (left, right) =>
        Date.parse(left.signal.observedAt) - Date.parse(right.signal.observedAt) ||
        left.admissionSequence - right.admissionSequence,
    );
  }

  /** Stages 8 to 10: index affected beliefs, project context, recompute. */
  async function projectScope(
    scope: string,
    asOf: IsoTimestamp,
    changedSignalTypes: readonly string[],
  ): Promise<ContextSnapshot | null> {
    if (beliefs.size === 0) return null;
    const previous = await store.getContextSnapshot(scope);
    const { snapshot } = await projectContext({
      registry: beliefs,
      index: dependencyIndex,
      scope,
      asOf,
      configVersion: config.configVersion,
      previous,
      changedSignalTypes,
      signalsFor: (definition) => signalsFor(definition, scope),
      freshnessProfiles,
      options: fusionOptions,
    });
    await store.putContextSnapshot(snapshot);
    return snapshot;
  }

  /** Stages 1 to 4: validate, reject secrets, hash, deduplicate. */
  async function prepare(candidate: unknown): Promise<PreparedSignal> {
    assertSignalSizeBound(candidate, config.maximumSignalBytes);
    const signal = parseSignalEnvelope(candidate);
    assertSignalPolicy(signal, {
      allowedSources: config.allowedSources,
      allowedScopes: config.allowedScopes,
      retrospectiveIntervalSchemaRefs: config.retrospectiveIntervalSchemaRefs,
    });
    assertNoKernelSecretFields(signal, 'signal');

    const contentHash = hashSignalEnvelope(signal);
    const existing = await store.getSignal(signal.id);
    if (existing && existing.contentHash !== contentHash) {
      throw kernelError(
        'POWERFARM_KERNEL_SIGNAL_DUPLICATE_CONFLICT',
        'a signal with this id was already admitted with different content',
        { signalId: signal.id },
      );
    }
    return { signal, contentHash, duplicateOfAdmitted: existing !== null };
  }

  /** Stages 5 to 7: classify, persist, update watermark. */
  async function commit(
    prepared: PreparedSignal,
    options: IngestOptions,
    executed: IngestionStage[],
  ): Promise<IngestionResult> {
    const { signal, contentHash } = prepared;
    const processedAt: IsoTimestamp = nowIso(clock);

    if (prepared.duplicateOfAdmitted) {
      executed.push('classify_temporal');
      return {
        schemaVersion: INGESTION_RESULT_SCHEMA_VERSION,
        signalId: signal.id,
        admission: 'duplicate',
        disposition: 'duplicate',
        contentHash,
        processedAt,
        stagesExecuted: [...executed],
        watermark: await store.getWatermark(signal.source, signal.scope),
        contextRevision: (await store.getContextSnapshot(signal.scope))?.revision ?? null,
        changedBeliefKeys: [],
      };
    }

    const policy = resolveTemporalPolicy(config, signal);
    const currentWatermark = await store.getWatermark(signal.source, signal.scope);
    const disposition: TemporalDisposition = classifyTemporalDisposition({
      observedAt: signal.observedAt,
      receivedAt: signal.receivedAt,
      processedAt,
      watermark: currentWatermark,
      policy,
    });
    executed.push('classify_temporal');

    if (disposition === 'invalid_time') {
      throw kernelError('POWERFARM_KERNEL_TIMESTAMP_INVALID', 'event time could not be ordered', {
        signalId: signal.id,
      });
    }

    if (shouldStop(options, 'classify_temporal')) {
      return {
        schemaVersion: INGESTION_RESULT_SCHEMA_VERSION,
        signalId: signal.id,
        admission: 'withheld',
        disposition,
        contentHash,
        processedAt,
        stagesExecuted: [...executed],
        watermark: currentWatermark,
        contextRevision: (await store.getContextSnapshot(signal.scope))?.revision ?? null,
        changedBeliefKeys: [],
      };
    }

    const reliability = resolveSourceReliability(config, signal);
    const record: StoredSignal = {
      schemaVersion: STORED_SIGNAL_SCHEMA_VERSION,
      signal,
      contentHash,
      processedAt,
      disposition,
      admissionSequence: await store.nextAdmissionSequence(),
      sourceReliability: reliability.value,
      sourceReliabilityOrigin: reliability.origin,
    };
    const admission = await store.appendSignal(record);
    executed.push('persist_signal');

    if (shouldStop(options, 'persist_signal')) {
      return {
        schemaVersion: INGESTION_RESULT_SCHEMA_VERSION,
        signalId: signal.id,
        admission,
        disposition,
        contentHash,
        processedAt,
        stagesExecuted: [...executed],
        watermark: currentWatermark,
        contextRevision: (await store.getContextSnapshot(signal.scope))?.revision ?? null,
        changedBeliefKeys: [],
      };
    }

    const nextWatermark = advanceWatermark({
      current: currentWatermark,
      source: signal.source,
      scope: signal.scope,
      observedAt: signal.observedAt,
      disposition,
      allowedLatenessMs: policy.allowedLatenessMs,
      at: processedAt,
    });
    await store.putWatermark(nextWatermark);
    executed.push('update_watermark');

    if (shouldStop(options, 'update_watermark')) {
      return {
        schemaVersion: INGESTION_RESULT_SCHEMA_VERSION,
        signalId: signal.id,
        admission,
        disposition,
        contentHash,
        processedAt,
        stagesExecuted: [...executed],
        watermark: nextWatermark,
        contextRevision: (await store.getContextSnapshot(signal.scope))?.revision ?? null,
        changedBeliefKeys: [],
      };
    }

    executed.push('index_affected_beliefs', 'project_context', 'recompute_beliefs');
    const snapshot = await projectScope(signal.scope, processedAt, [signal.type]);

    return {
      schemaVersion: INGESTION_RESULT_SCHEMA_VERSION,
      signalId: signal.id,
      admission,
      disposition,
      contentHash,
      processedAt,
      stagesExecuted: [...executed],
      watermark: nextWatermark,
      contextRevision: snapshot?.revision ?? null,
      changedBeliefKeys: snapshot?.changedBeliefKeys ?? [],
    };
  }

  async function ingest(candidate: unknown, options: IngestOptions = {}): Promise<IngestionResult> {
    const executed: IngestionStage[] = [];
    const prepared = await prepare(candidate);
    executed.push('validate', 'reject_secrets', 'hash', 'deduplicate');

    if (shouldStop(options, 'deduplicate')) {
      return {
        schemaVersion: INGESTION_RESULT_SCHEMA_VERSION,
        signalId: prepared.signal.id,
        admission: prepared.duplicateOfAdmitted ? 'duplicate' : 'withheld',
        disposition: prepared.duplicateOfAdmitted ? 'duplicate' : 'on_time',
        contentHash: prepared.contentHash,
        processedAt: nowIso(clock),
        stagesExecuted: [...executed],
        watermark: await store.getWatermark(prepared.signal.source, prepared.signal.scope),
        contextRevision: (await store.getContextSnapshot(prepared.signal.scope))?.revision ?? null,
        changedBeliefKeys: [],
      };
    }

    return commit(prepared, options, executed);
  }

  async function ingestBatch(
    candidates: readonly unknown[],
    options: BatchIngestOptions = {},
  ): Promise<BatchIngestionResult> {
    const atomic = options.atomic === true;
    if (candidates.length > config.maximumBatchSize) {
      throw kernelError('POWERFARM_KERNEL_SIGNAL_TOO_LARGE', 'batch exceeds the configured size', {
        size: candidates.length,
        maximumBatchSize: config.maximumBatchSize,
      });
    }

    // Every signal is validated before any store state is mutated.
    const prepared: (PreparedSignal | null)[] = [];
    const rejections = new Map<number, { code: string; message: string }>();
    const seen = new Map<string, string>();

    for (let index = 0; index < candidates.length; index += 1) {
      try {
        const item = await prepare(candidates[index]);
        const previousHash = seen.get(item.signal.id);
        if (previousHash !== undefined && previousHash !== item.contentHash) {
          throw kernelError(
            'POWERFARM_KERNEL_SIGNAL_DUPLICATE_CONFLICT',
            'the batch contains the same signal id with different content',
            { signalId: item.signal.id },
          );
        }
        if (previousHash !== undefined) {
          // The same envelope appeared earlier in this batch; do not process twice.
          prepared.push({ ...item, duplicateOfAdmitted: true });
        } else {
          seen.set(item.signal.id, item.contentHash);
          prepared.push(item);
        }
      } catch (error) {
        prepared.push(null);
        rejections.set(index, {
          code: isKernelError(error) ? error.code : 'POWERFARM_KERNEL_SIGNAL_INVALID',
          message: error instanceof Error ? error.message : 'signal rejected',
        });
      }
    }

    if (atomic && rejections.size > 0) {
      const first = [...rejections.values()][0];
      throw kernelError('POWERFARM_KERNEL_SIGNAL_INVALID', `atomic batch rejected: ${first.message}`, {
        rejected: rejections.size,
      });
    }

    const items: BatchIngestionItem[] = [];
    let admittedCount = 0;
    let duplicateCount = 0;
    let rejectedCount = 0;

    for (let index = 0; index < candidates.length; index += 1) {
      const rejection = rejections.get(index);
      if (rejection) {
        rejectedCount += 1;
        items.push({
          index,
          signalId: null,
          status: 'rejected',
          result: null,
          errorCode: rejection.code,
          errorMessage: rejection.message,
        });
        continue;
      }

      const item = prepared[index];
      if (!item) continue;
      const executed: IngestionStage[] = ['validate', 'reject_secrets', 'hash', 'deduplicate'];
      const result = await commit(item, options, executed);
      const status =
        result.admission === 'admitted'
          ? 'admitted'
          : result.admission === 'duplicate'
            ? 'duplicate'
            : 'withheld';
      if (status === 'admitted') admittedCount += 1;
      if (status === 'duplicate') duplicateCount += 1;
      items.push({
        index,
        signalId: result.signalId,
        status,
        result,
        errorCode: null,
        errorMessage: null,
      });
    }

    return {
      schemaVersion: BATCH_INGESTION_RESULT_SCHEMA_VERSION,
      atomic,
      admittedCount,
      duplicateCount,
      rejectedCount,
      items,
    };
  }

  async function getContext(request: ContextQuery): Promise<ContextSnapshot> {
    const stored = await store.getContextSnapshot(request.scope);
    const snapshot =
      stored ??
      createEmptyContextSnapshot({
        scope: request.scope,
        asOf: nowIso(clock),
        configVersion: config.configVersion,
      });
    if (!request.beliefKeys) return snapshot;

    const selected: Record<string, (typeof snapshot.beliefs)[string]> = {};
    for (const key of request.beliefKeys) {
      const state = snapshot.beliefs[key];
      if (state) selected[key] = state;
    }
    return {
      ...snapshot,
      beliefs: selected,
      unknownBeliefKeys: snapshot.unknownBeliefKeys.filter((key) =>
        request.beliefKeys?.includes(key),
      ),
    };
  }

  return {
    config,
    store,
    beliefs,
    dependencyIndex,
    ingest,
    ingestBatch,
    getWatermark: (source, scope) => store.getWatermark(source, scope),
    listSignals: (query = {}) => store.listSignals(query),
    getContext,
  };
}
