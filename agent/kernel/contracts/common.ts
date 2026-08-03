import { z } from 'zod';

import { kernelError } from '../errors.ts';

export type IsoTimestamp = string;
export type UnitInterval = number;

export interface VersionedObject {
  schemaVersion: string;
}

export interface EvidenceReference {
  signalIds: readonly string[];
  inferenceResultIds: readonly string[];
  beliefKeys: readonly string[];
  evidenceHash: string;
}

export const kernelLimits = {
  identifierMaxLength: 256,
  labelMaxLength: 512,
  timestampMaxLength: 64,
  signalBytesMax: 256 * 1024,
  batchSizeMax: 1_000,
  derivedFromMax: 128,
  allowedPurposesMax: 32,
} as const;

const isoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:\d{2})$/u;

/**
 * A timestamp is valid only when it carries an explicit offset and resolves to a
 * finite instant. Offset-less local times are ambiguous and are rejected.
 */
export function isIsoTimestamp(value: unknown): value is IsoTimestamp {
  if (typeof value !== 'string') return false;
  if (value.length > kernelLimits.timestampMaxLength) return false;
  if (!isoTimestampPattern.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

export function toEpochMs(value: IsoTimestamp, field = 'timestamp'): number {
  if (!isIsoTimestamp(value)) {
    throw kernelError('POWERFARM_KERNEL_TIMESTAMP_INVALID', `field ${field} is not ISO 8601`, {
      field,
    });
  }
  return Date.parse(value);
}

export function toIsoTimestamp(value: Date | number, field = 'timestamp'): IsoTimestamp {
  const date = typeof value === 'number' ? new Date(value) : value;
  const epoch = date.valueOf();
  if (!Number.isFinite(epoch)) {
    throw kernelError('POWERFARM_KERNEL_TIMESTAMP_INVALID', `field ${field} is not a valid date`, {
      field,
    });
  }
  return date.toISOString();
}

export const isoTimestampSchema = z
  .string()
  .max(kernelLimits.timestampMaxLength)
  .refine(isIsoTimestamp, { message: 'expected an ISO 8601 timestamp with explicit offset' });

export const identifierSchema = z.string().min(1).max(kernelLimits.identifierMaxLength);

export const labelSchema = z.string().min(1).max(kernelLimits.labelMaxLength);

export const unitIntervalSchema = z.number().min(0).max(1);

export const evidenceReferenceSchema = z.object({
  signalIds: z.array(identifierSchema),
  inferenceResultIds: z.array(identifierSchema),
  beliefKeys: z.array(labelSchema),
  evidenceHash: z.string().min(1).max(kernelLimits.identifierMaxLength),
});
