import { assertNoSecretFields, canonicalJson, sha256 } from '../../lib/institutional-event.ts';
import { kernelError } from '../errors.ts';
import { kernelLimits, toEpochMs } from '../contracts/common.ts';
import { signalEnvelopeSchema, type SignalEnvelope } from '../contracts/signal.ts';

export interface SignalValidationOptions {
  maximumSignalBytes?: number;
  allowedSources?: readonly string[];
  allowedScopes?: readonly string[];
  retrospectiveIntervalSchemaRefs?: readonly string[];
}

/**
 * Bounds the serialized size of an untrusted envelope before any parsing work is
 * done. Size is measured in UTF-8 bytes.
 */
export function assertSignalSizeBound(value: unknown, maximumBytes: number): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    throw kernelError('POWERFARM_KERNEL_SIGNAL_INVALID', 'envelope is not JSON serializable');
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maximumBytes) {
    throw kernelError('POWERFARM_KERNEL_SIGNAL_TOO_LARGE', 'envelope exceeds the configured size', {
      bytes,
      maximumBytes,
    });
  }
  return bytes;
}

/** Rejects secret-shaped keys anywhere in content that would be persisted. */
export function assertNoKernelSecretFields(value: unknown, path = 'signal'): void {
  try {
    assertNoSecretFields(value, path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const field = message.split(':')[1] ?? path;
    throw kernelError('POWERFARM_KERNEL_SECRET_FIELD_REJECTED', 'secret-shaped key rejected', {
      field,
    });
  }
}

const timestampFields = new Set(['observedAt', 'receivedAt', 'validFrom', 'validUntil', 'expectedAt']);

export function parseSignalEnvelope(value: unknown): SignalEnvelope {
  const parsed = signalEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first ? first.path.map(String) : [];
    const field = path.join('.') || 'envelope';
    const code = path.some((segment) => timestampFields.has(segment))
      ? 'POWERFARM_KERNEL_TIMESTAMP_INVALID'
      : 'POWERFARM_KERNEL_SIGNAL_INVALID';
    throw kernelError(code, first?.message ?? 'envelope is invalid', {
      field,
      issues: parsed.error.issues.length,
    });
  }
  return parsed.data as SignalEnvelope;
}

/**
 * Checks the invariants that need configuration, after structural validation.
 */
export function assertSignalPolicy(
  signal: SignalEnvelope,
  options: SignalValidationOptions = {},
): void {
  if (options.allowedSources && !options.allowedSources.includes(signal.source)) {
    throw kernelError('POWERFARM_KERNEL_SOURCE_NOT_ALLOWED', 'source is not configured', {
      source: signal.source,
    });
  }
  if (options.allowedScopes && !options.allowedScopes.includes(signal.scope)) {
    throw kernelError('POWERFARM_KERNEL_SCOPE_INVALID', 'scope is not configured', {
      scope: signal.scope,
    });
  }

  if (signal.validUntil === undefined) return;

  const validUntil = toEpochMs(signal.validUntil, 'validUntil');
  const lowerBound = Math.max(
    toEpochMs(signal.observedAt, 'observedAt'),
    signal.validFrom === undefined ? Number.NEGATIVE_INFINITY : toEpochMs(signal.validFrom, 'validFrom'),
  );
  if (validUntil >= lowerBound) return;

  const retrospectiveAllowed =
    signal.dataSchemaRef !== undefined &&
    (options.retrospectiveIntervalSchemaRefs ?? []).includes(signal.dataSchemaRef);

  if (!retrospectiveAllowed) {
    throw kernelError(
      'POWERFARM_KERNEL_SIGNAL_INVALID',
      'validUntil precedes the observation without a configured retrospective schema',
      { field: 'validUntil', signalId: signal.id },
    );
  }
}

/** Canonical content hash of an envelope, using the existing Powerfarm hashing. */
export function hashSignalEnvelope(signal: SignalEnvelope): string {
  return sha256(canonicalJson(signal));
}

export const validationLimits = kernelLimits;
