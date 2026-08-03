import { kernelError } from '../errors.ts';
import { toEpochMs, type IsoTimestamp, type UnitInterval } from '../contracts/common.ts';

export type FreshnessMode =
  | 'fixed_ttl'
  | 'exponential_decay'
  | 'linear_decay'
  | 'until_replaced'
  | 'permanent';

export interface FreshnessProfile {
  id: string;
  mode: FreshnessMode;
  ttlMs?: number;
  halfLifeMs?: number;
  minimumWeight?: number;
}

export interface FreshnessAssessment {
  profileId: string;
  ageMs: number;
  weight: UnitInterval;
  expired: boolean;
}

function requirePositive(value: number | undefined, field: string, profileId: string): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    throw kernelError('POWERFARM_KERNEL_CONFIG_INVALID', 'freshness profile is incomplete', {
      field,
      profileId,
    });
  }
  return value;
}

function floorWeight(profile: FreshnessProfile): number {
  const minimum = profile.minimumWeight ?? 0;
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1) {
    throw kernelError('POWERFARM_KERNEL_CONFIG_INVALID', 'minimumWeight must be within [0, 1]', {
      profileId: profile.id,
    });
  }
  return minimum;
}

/**
 * Deterministic freshness from event time and evaluation time only.
 *
 * Expiry lowers the current weight of evidence. It never removes the evidence:
 * expired signals stay queryable as history.
 */
export function assessFreshness(
  profile: FreshnessProfile,
  eventTime: IsoTimestamp,
  evaluationTime: IsoTimestamp,
): FreshnessAssessment {
  const minimum = floorWeight(profile);
  const ageMs = Math.max(0, toEpochMs(evaluationTime, 'asOf') - toEpochMs(eventTime, 'observedAt'));
  const hardTtl = profile.ttlMs;

  let weight: number;
  let expired: boolean;

  switch (profile.mode) {
    case 'permanent':
    case 'until_replaced': {
      weight = 1;
      expired = false;
      break;
    }
    case 'fixed_ttl': {
      const ttl = requirePositive(profile.ttlMs, 'ttlMs', profile.id);
      expired = ageMs > ttl;
      weight = expired ? minimum : 1;
      break;
    }
    case 'linear_decay': {
      const ttl = requirePositive(profile.ttlMs, 'ttlMs', profile.id);
      const raw = 1 - ageMs / ttl;
      expired = ageMs >= ttl;
      weight = Math.max(minimum, raw);
      break;
    }
    case 'exponential_decay': {
      const halfLife = requirePositive(profile.halfLifeMs, 'halfLifeMs', profile.id);
      const raw = 2 ** (-ageMs / halfLife);
      expired = hardTtl !== undefined ? ageMs > hardTtl : raw <= minimum && ageMs > 0;
      weight = Math.max(minimum, expired && hardTtl !== undefined ? minimum : raw);
      break;
    }
    default: {
      throw kernelError('POWERFARM_KERNEL_CONFIG_INVALID', 'unknown freshness mode', {
        profileId: profile.id,
      });
    }
  }

  return {
    profileId: profile.id,
    ageMs,
    weight: Math.min(1, Math.max(0, weight)),
    expired,
  };
}

export const defaultFreshnessProfiles: Readonly<Record<string, FreshnessProfile>> = Object.freeze({
  'freshness:permanent': { id: 'freshness:permanent', mode: 'permanent' },
  'freshness:until-replaced': { id: 'freshness:until-replaced', mode: 'until_replaced' },
  'freshness:hour': { id: 'freshness:hour', mode: 'fixed_ttl', ttlMs: 3_600_000 },
});
