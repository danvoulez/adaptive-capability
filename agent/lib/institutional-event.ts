import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

export function sha256(input: string): string {
  return 'sha256:' + createHash('sha256').update(input).digest('hex');
}

export function assertNoSecretFields(value: unknown, path = 'value'): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  
  const secretPattern = /(password|secret|token|api_key|apikey|private_key|credential|auth)/i;
  
  for (const key of Object.keys(value as object)) {
    const fullPath = path + '.' + key;
    if (secretPattern.test(key)) {
      throw new Error(`secret-shaped key rejected: ${fullPath}`);
    }
    assertNoSecretFields((value as Record<string, unknown>)[key], fullPath);
  }
}
