import type { BeliefState } from '../../contracts/belief.ts';
import type { BeliefComputationInput, BeliefComputeFunction } from '../definition.ts';
import { buildBeliefState, summarizeEvidence } from './shared.ts';

export interface DeterministicRuleOptions<T = unknown> {
  /** Stable identifier of the rule, recorded on every belief it produces. */
  ruleId: string;
  version: string;
  /**
   * Pure rule over dependency beliefs and evidence. Returning `undefined` means
   * the rule declines to conclude, which becomes unknown rather than false.
   */
  evaluate(input: DeterministicRuleInput): T | undefined;
  /** Extra uncertainty the rule itself introduces, beyond its inputs. */
  ruleUncertainty?: number;
}

export interface DeterministicRuleInput {
  key: string;
  scope: string;
  asOf: string;
  dependencies: Readonly<Record<string, BeliefState>>;
  evidence: BeliefComputationInput['evidence'];
}

/**
 * A rule over other beliefs. Inherited uncertainty is the worst dimension of any
 * dependency, so a conclusion is never more certain than what it rests on.
 */
export function deterministicRule<T = unknown>(
  options: DeterministicRuleOptions<T>,
): BeliefComputeFunction<T> {
  return (input) => {
    const summary = summarizeEvidence(input as BeliefComputationInput);
    const dependencyStates = Object.values(input.dependencies);

    const value = options.evaluate({
      key: input.key,
      scope: input.scope,
      asOf: input.asOf,
      dependencies: input.dependencies,
      evidence: input.evidence,
    });

    const inheritedMissingness = dependencyStates.length
      ? Math.max(...dependencyStates.map((state) => state.uncertainty.missingness))
      : summary.missingness;
    const inheritedConflict = dependencyStates.length
      ? Math.max(...dependencyStates.map((state) => state.uncertainty.conflict))
      : 0;
    const inheritedStaleness = dependencyStates.length
      ? Math.max(...dependencyStates.map((state) => state.uncertainty.staleness))
      : summary.staleness;
    const inheritedMeasurement = dependencyStates.length
      ? Math.max(...dependencyStates.map((state) => state.uncertainty.measurement))
      : summary.measurement;
    const inheritedModel = dependencyStates.length
      ? Math.max(...dependencyStates.map((state) => state.uncertainty.model))
      : summary.model;

    const undecided = value === undefined;

    const state = buildBeliefState({
      input: input as BeliefComputationInput,
      value: undecided ? null : value,
      summary: {
        ...summary,
        missingness: undecided ? Math.max(inheritedMissingness, 1) : inheritedMissingness,
        staleness: inheritedStaleness,
        measurement: Math.max(inheritedMeasurement, options.ruleUncertainty ?? 0),
        model: inheritedModel,
        assumptions: [...summary.assumptions, `rule:${options.ruleId}@${options.version}`],
      },
      conflict: inheritedConflict,
      strategy: `deterministic_rule:${options.ruleId}`,
      version: options.version,
      extraAssumptions: Object.keys(input.dependencies)
        .sort()
        .map((key) => `depends-on:${key}`),
    });

    return state as BeliefState<T>;
  };
}
