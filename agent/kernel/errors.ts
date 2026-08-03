export const kernelErrorCodes = [
  'POWERFARM_KERNEL_CONFIG_INVALID',
  'POWERFARM_KERNEL_SIGNAL_INVALID',
  'POWERFARM_KERNEL_SIGNAL_TOO_LARGE',
  'POWERFARM_KERNEL_SIGNAL_DUPLICATE_CONFLICT',
  'POWERFARM_KERNEL_SECRET_FIELD_REJECTED',
  'POWERFARM_KERNEL_TIMESTAMP_INVALID',
  'POWERFARM_KERNEL_TEMPORAL_DISPOSITION_INVALID',
  'POWERFARM_KERNEL_SOURCE_NOT_ALLOWED',
  'POWERFARM_KERNEL_SCOPE_INVALID',
  'POWERFARM_KERNEL_BELIEF_DEFINITION_MISSING',
  'POWERFARM_KERNEL_BELIEF_DEPENDENCY_CYCLE',
  'POWERFARM_KERNEL_TREND_INPUT_INVALID',
  'POWERFARM_KERNEL_INDICATOR_DEFINITION_MISSING',
  'POWERFARM_KERNEL_INFERENCE_DISABLED',
  'POWERFARM_KERNEL_INFERENCE_ROUTE_MISSING',
  'POWERFARM_KERNEL_INFERENCE_TIMEOUT',
  'POWERFARM_KERNEL_INFERENCE_RESPONSE_INVALID',
  'POWERFARM_KERNEL_INFERENCE_SCHEMA_INVALID',
  'POWERFARM_KERNEL_INFERENCE_EVIDENCE_INVALID',
  'POWERFARM_KERNEL_INFERENCE_REJECTED',
  'POWERFARM_KERNEL_REPLAY_INFERENCE_MISSING',
  'POWERFARM_KERNEL_CAPABILITY_UNKNOWN',
  'POWERFARM_KERNEL_EPISODE_TRANSITION_INVALID',
  'POWERFARM_KERNEL_REPLAY_VERSION_MISSING',
  'POWERFARM_KERNEL_REPLAY_DIVERGED',
] as const;

export type KernelErrorCode = (typeof kernelErrorCodes)[number];

export type KernelErrorDetailValue = string | number | boolean;
export type KernelErrorDetails = Readonly<Record<string, KernelErrorDetailValue>>;

const redactions: readonly (readonly [RegExp, string])[] = [
  [/postgres(?:ql)?:\/\/\S+/giu, '[redacted-url]'],
  [/[a-z][a-z0-9+.-]*:\/\/\S+/giu, '[redacted-url]'],
  [/[A-Za-z]:\\[^\s]*/gu, '[redacted-path]'],
  [/(?:\/[^\s/\\]+){2,}\/?/gu, '[redacted-path]'],
];

/**
 * Removes host paths and connection URLs from operator-visible text. Error text
 * may carry safe identifiers only.
 */
export function sanitizeErrorText(value: string): string {
  let text = value;
  for (const [pattern, replacement] of redactions) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function sanitizeDetails(details: KernelErrorDetails): KernelErrorDetails {
  const entries = Object.entries(details).map(([key, value]) => [
    key,
    typeof value === 'string' ? sanitizeErrorText(value) : value,
  ]);
  return Object.freeze(Object.fromEntries(entries) as Record<string, KernelErrorDetailValue>);
}

export class KernelError extends Error {
  readonly code: KernelErrorCode;
  readonly details: KernelErrorDetails;

  constructor(code: KernelErrorCode, reason?: string, details: KernelErrorDetails = {}) {
    const safeReason = reason ? sanitizeErrorText(reason) : undefined;
    super(safeReason ? `${code}: ${safeReason}` : code);
    this.name = 'KernelError';
    this.code = code;
    this.details = sanitizeDetails(details);
  }
}

export function kernelError(
  code: KernelErrorCode,
  reason?: string,
  details?: KernelErrorDetails,
): KernelError {
  return new KernelError(code, reason, details);
}

export function isKernelError(value: unknown): value is KernelError {
  return value instanceof KernelError;
}
