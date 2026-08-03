import assert from "node:assert/strict";
import test from "node:test";

import {
  assessFreshness,
  BeliefRegistry,
  createAdaptiveCapabilityKernel,
  DependencyIndex,
  deterministicRule,
  explicitUnknown,
  FixedKernelClock,
  InMemoryKernelStore,
  KernelError,
  latestValidValue,
  projectContext,
  weightedCategoricalVote,
  weightedMean,
} from "../agent/kernel/index.ts";
import { BASE_INSTANT, buildSignal, shiftIso } from "./helpers/adaptive-kernel.mjs";

const HOUR = 3_600_000;

const profiles = {
  "freshness:hour": { id: "freshness:hour", mode: "fixed_ttl", ttlMs: HOUR },
  "freshness:permanent": { id: "freshness:permanent", mode: "permanent" },
};

const trustedSources = {
  "sensor.a": { sourceReliability: 0.9 },
  "sensor.b": { sourceReliability: 0.9 },
  "sensor.weak": { sourceReliability: 0.1 },
};

/** Wraps a definition so tests can count how often it was recomputed. */
function counted(definition, counters) {
  counters[definition.key] = 0;
  return {
    ...definition,
    compute: (input) => {
      counters[definition.key] += 1;
      return definition.compute(input);
    },
  };
}

function definitions(counters = {}) {
  return [
    counted(
      {
        key: "belief:soil.moisture",
        version: "1.0.0",
        signalTypes: ["soil.moisture.percent"],
        beliefDependencies: [],
        freshnessProfileId: "freshness:hour",
        compute: weightedMean({ conflictTolerance: 5 }),
      },
      counters,
    ),
    counted(
      {
        key: "belief:irrigation.needed",
        version: "1.0.0",
        signalTypes: [],
        beliefDependencies: ["belief:soil.moisture"],
        freshnessProfileId: "freshness:permanent",
        compute: deterministicRule({
          ruleId: "irrigation-threshold",
          version: "1.0.0",
          evaluate: ({ dependencies }) => {
            const moisture = dependencies["belief:soil.moisture"]?.value;
            return typeof moisture === "number" ? moisture < 25 : undefined;
          },
        }),
      },
      counters,
    ),
    counted(
      {
        key: "belief:gate.position",
        version: "1.0.0",
        signalTypes: ["gate.position"],
        beliefDependencies: [],
        freshnessProfileId: "freshness:hour",
        compute: latestValidValue(),
      },
      counters,
    ),
  ];
}

function createKernel({ counters = {}, sources = trustedSources } = {}) {
  const clock = new FixedKernelClock(BASE_INSTANT);
  const kernel = createAdaptiveCapabilityKernel({
    clock,
    store: new InMemoryKernelStore(),
    beliefs: definitions(counters),
    freshnessProfiles: profiles,
    config: { sources },
  });
  return { clock, counters, kernel };
}

function moistureSignal(id, source, percent, at = BASE_INSTANT) {
  return buildSignal({
    id,
    source,
    type: "soil.moisture.percent",
    observedAt: at,
    receivedAt: at,
    data: percent,
  });
}

test("only the beliefs a signal can reach are recomputed", async () => {
  const { kernel, counters } = createKernel();

  const result = await kernel.ingest(moistureSignal("signal:m1", "sensor.a", 20));

  assert.equal(counters["belief:soil.moisture"], 1);
  assert.equal(counters["belief:irrigation.needed"], 1, "dependents recompute");
  assert.equal(counters["belief:gate.position"], 0, "unrelated beliefs are untouched");

  assert.deepEqual(result.changedBeliefKeys, [
    "belief:irrigation.needed",
    "belief:soil.moisture",
  ]);
  assert.equal(result.contextRevision, 1);

  await kernel.ingest(
    buildSignal({
      id: "signal:g1",
      source: "sensor.a",
      type: "gate.position",
      data: "open",
    }),
  );
  assert.equal(counters["belief:soil.moisture"], 1, "a gate signal must not touch moisture");
  assert.equal(counters["belief:gate.position"], 1);
});

test("dependencies are evaluated before dependents", async () => {
  const { kernel } = createKernel();
  await kernel.ingest(moistureSignal("signal:m1", "sensor.a", 20));

  const context = await kernel.getContext({ scope: "farm:north" });
  assert.equal(context.beliefs["belief:soil.moisture"].value, 20);
  assert.equal(
    context.beliefs["belief:irrigation.needed"].value,
    true,
    "the rule saw the recomputed dependency, not the previous revision",
  );
  assert.ok(
    context.beliefs["belief:irrigation.needed"].assumptions.includes(
      "depends-on:belief:soil.moisture",
    ),
  );
});

test("conflicting trusted sources raise conflict instead of averaging it away", async () => {
  const { kernel } = createKernel();
  await kernel.ingest(moistureSignal("signal:m1", "sensor.a", 20));
  const result = await kernel.ingest(moistureSignal("signal:m2", "sensor.b", 40));

  const context = await kernel.getContext({ scope: "farm:north" });
  const belief = context.beliefs["belief:soil.moisture"];

  assert.equal(belief.value, 30, "the fused value is still reported");
  assert.equal(belief.uncertainty.conflict, 1, "a ten point spread exceeds the tolerance");
  assert.equal(belief.uncertainty.summary, 1, "the summary surfaces the worst dimension");
  assert.ok(result.changedBeliefKeys.includes("belief:soil.moisture"));
});

test("an untrusted source does not by itself create conflict or certainty", async () => {
  const { kernel } = createKernel();
  await kernel.ingest(moistureSignal("signal:m1", "sensor.a", 20));
  const before = (await kernel.getContext({ scope: "farm:north" })).beliefs[
    "belief:soil.moisture"
  ];

  await kernel.ingest(moistureSignal("signal:m2", "sensor.weak", 90));
  const after = (await kernel.getContext({ scope: "farm:north" })).beliefs[
    "belief:soil.moisture"
  ];

  assert.equal(after.uncertainty.conflict, 0, "a source below the trust floor is not a voice");
  assert.ok(
    after.uncertainty.measurement <= before.uncertainty.measurement + 1e-9,
    "a weak source must not increase certainty",
  );
});

test("a missing source increases missingness", async () => {
  const registry = new BeliefRegistry([
    {
      key: "belief:paired.moisture",
      version: "1.0.0",
      signalTypes: ["soil.moisture.percent"],
      beliefDependencies: [],
      freshnessProfileId: "freshness:hour",
      expectedSources: ["sensor.a", "sensor.b"],
      compute: weightedMean({ conflictTolerance: 5 }),
    },
  ]);
  const index = new DependencyIndex(registry);
  const store = new InMemoryKernelStore();
  const kernel = createAdaptiveCapabilityKernel({
    clock: new FixedKernelClock(BASE_INSTANT),
    store,
    beliefs: registry,
    freshnessProfiles: profiles,
    config: { sources: trustedSources },
  });

  await kernel.ingest(moistureSignal("signal:m1", "sensor.a", 20));
  const oneOfTwo = (await kernel.getContext({ scope: "farm:north" })).beliefs[
    "belief:paired.moisture"
  ];
  assert.equal(oneOfTwo.uncertainty.missingness, 0.5, "one of two expected sources is silent");
  assert.ok(oneOfTwo.assumptions.includes("expected-source-silent:sensor.b"));

  await kernel.ingest(
    buildSignal({
      id: "signal:m2",
      source: "sensor.b",
      type: "soil.moisture.percent",
      class: "missingness",
      missing: { reason: "sensor_offline", retryable: true },
    }),
  );
  const withMissingness = (await kernel.getContext({ scope: "farm:north" })).beliefs[
    "belief:paired.moisture"
  ];
  assert.ok(
    withMissingness.uncertainty.missingness > oneOfTwo.uncertainty.missingness,
    "an explicit missingness report raises missingness further",
  );
  assert.equal(withMissingness.value, 20, "the value that does exist is still reported");
  assert.equal(index.beliefsForSignalType("soil.moisture.percent").length, 1);
});

test("expired evidence loses current weight but stays queryable as history", async () => {
  const { kernel } = createKernel();
  await kernel.ingest(moistureSignal("signal:m1", "sensor.a", 20));

  const fresh = (await kernel.getContext({ scope: "farm:north" })).beliefs[
    "belief:soil.moisture"
  ];
  assert.equal(fresh.value, 20);
  assert.ok(fresh.uncertainty.staleness < 1);

  const laterInstant = shiftIso(BASE_INSTANT, 2 * HOUR);
  const { snapshot } = await projectContext({
    registry: kernel.beliefs,
    index: kernel.dependencyIndex,
    scope: "farm:north",
    asOf: laterInstant,
    configVersion: kernel.config.configVersion,
    previous: await kernel.store.getContextSnapshot("farm:north"),
    changedSignalTypes: ["soil.moisture.percent"],
    signalsFor: () => kernel.store.listSignals({ scope: "farm:north", type: "soil.moisture.percent" }),
    freshnessProfiles: profiles,
  });

  const stale = snapshot.beliefs["belief:soil.moisture"];
  assert.equal(stale.value, null, "expired evidence carries no current weight");
  assert.equal(stale.uncertainty.staleness, 1);
  assert.ok(snapshot.unknownBeliefKeys.includes("belief:soil.moisture"));

  const history = await kernel.listSignals({ type: "soil.moisture.percent" });
  assert.equal(history.length, 1, "the expired signal remains in the record");
  assert.equal(history[0].signal.data, 20);
});

test("belief evidence and assumptions are complete", async () => {
  const { kernel } = createKernel({ sources: {} });
  await kernel.ingest(moistureSignal("signal:m1", "sensor.a", 20));
  await kernel.ingest(moistureSignal("signal:m2", "sensor.b", 22, shiftIso(BASE_INSTANT, 60_000)));

  const belief = (await kernel.getContext({ scope: "farm:north" })).beliefs[
    "belief:soil.moisture"
  ];

  assert.deepEqual(belief.evidenceSignalIds, ["signal:m1", "signal:m2"]);
  assert.deepEqual(belief.inferenceResultIds, []);
  assert.equal(belief.fusionStrategy, "weighted_mean");
  assert.equal(belief.fusionVersion, "1.0.0");
  assert.ok(belief.revision >= 1);
  assert.ok(belief.assumptions.includes("assumed-reliability:sensor.a"));
  assert.ok(belief.assumptions.includes("assumed-reliability:sensor.b"));
  assert.ok(belief.assumptions.includes("assumed-coverage:sensor.a"));
  assert.ok(belief.assumptions.includes("conflict-tolerance:5"));
});

test("dependency cycles fail closed", () => {
  const registry = new BeliefRegistry([
    {
      key: "belief:a",
      version: "1.0.0",
      signalTypes: [],
      beliefDependencies: ["belief:b"],
      freshnessProfileId: "freshness:permanent",
      compute: explicitUnknown(),
    },
    {
      key: "belief:b",
      version: "1.0.0",
      signalTypes: [],
      beliefDependencies: ["belief:a"],
      freshnessProfileId: "freshness:permanent",
      compute: explicitUnknown(),
    },
  ]);

  assert.throws(
    () => new DependencyIndex(registry),
    (error) => {
      assert.ok(error instanceof KernelError);
      assert.equal(error.code, "POWERFARM_KERNEL_BELIEF_DEPENDENCY_CYCLE");
      return true;
    },
  );
});

test("an unregistered belief fails closed", () => {
  const registry = new BeliefRegistry();
  assert.throws(
    () => registry.get("belief:absent"),
    (error) => {
      assert.equal(error.code, "POWERFARM_KERNEL_BELIEF_DEFINITION_MISSING");
      return true;
    },
  );
  assert.throws(
    () =>
      new DependencyIndex(
        new BeliefRegistry([
          {
            key: "belief:a",
            version: "1.0.0",
            signalTypes: [],
            beliefDependencies: ["belief:absent"],
            freshnessProfileId: "freshness:permanent",
            compute: explicitUnknown(),
          },
        ]),
      ),
    (error) => {
      assert.equal(error.code, "POWERFARM_KERNEL_BELIEF_DEFINITION_MISSING");
      return true;
    },
  );
});

test("unknown is a first class value, never false or zero", async () => {
  const registry = new BeliefRegistry([
    {
      key: "belief:pest.pressure",
      version: "1.0.0",
      signalTypes: ["pest.count"],
      beliefDependencies: [],
      freshnessProfileId: "freshness:permanent",
      compute: explicitUnknown("no-model-yet"),
    },
  ]);
  const kernel = createAdaptiveCapabilityKernel({
    clock: new FixedKernelClock(BASE_INSTANT),
    store: new InMemoryKernelStore(),
    beliefs: registry,
    freshnessProfiles: profiles,
  });

  await kernel.ingest(
    buildSignal({ id: "signal:p1", type: "pest.count", source: "sensor.a", data: 0 }),
  );

  const belief = (await kernel.getContext({ scope: "farm:north" })).beliefs[
    "belief:pest.pressure"
  ];
  assert.equal(belief.value, null);
  assert.notEqual(belief.value, false);
  assert.notEqual(belief.value, 0);
  assert.equal(belief.uncertainty.missingness, 1);
  assert.equal(belief.uncertainty.summary, 1);
  assert.ok(belief.assumptions.includes("explicit-unknown:no-model-yet"));
});

test("the latest valid strategy takes the newest reading and still reports dissent", async () => {
  const { kernel } = createKernel();
  await kernel.ingest(
    buildSignal({ id: "signal:g1", source: "sensor.a", type: "gate.position", data: "open" }),
  );
  await kernel.ingest(
    buildSignal({
      id: "signal:g2",
      source: "sensor.b",
      type: "gate.position",
      data: "closed",
      observedAt: shiftIso(BASE_INSTANT, 60_000),
      receivedAt: shiftIso(BASE_INSTANT, 60_000),
    }),
  );

  const belief = (await kernel.getContext({ scope: "farm:north" })).beliefs[
    "belief:gate.position"
  ];
  assert.equal(belief.value, "closed");
  assert.equal(belief.validFrom, shiftIso(BASE_INSTANT, 60_000));
  assert.ok(belief.uncertainty.conflict > 0, "the older trusted source still disagrees");
});

test("the categorical vote refuses to break a tie", () => {
  const evidence = (source, value) => ({
    signalId: `signal:${source}`,
    source,
    signalType: "irrigation.state",
    observedAt: BASE_INSTANT,
    value,
    reliability: 0.9,
    reliabilityOrigin: "configured",
    freshness: 1,
    expired: false,
    weight: 0.9,
    modelDerived: false,
    inferenceResultIds: [],
    assumptions: [],
  });

  const input = (items) => ({
    key: "belief:irrigation.state",
    scope: "farm:north",
    asOf: BASE_INSTANT,
    evidence: items,
    dependencies: {},
    previous: null,
    options: {
      neutralSourceReliability: 0.5,
      neutralQualityDimension: 1,
      trustedReliabilityFloor: 0.5,
      neutralModelUncertainty: 0.5,
    },
    expectedSources: [],
  });

  const vote = weightedCategoricalVote({ categories: ["irrigating", "idle"] });

  const majority = vote(
    input([
      evidence("sensor.a", "irrigating"),
      evidence("sensor.b", "irrigating"),
      evidence("sensor.c", "idle"),
    ]),
  );
  assert.equal(majority.value, "irrigating");
  assert.ok(Math.abs(majority.uncertainty.conflict - 1 / 3) < 1e-9);

  const tied = vote(input([evidence("sensor.a", "irrigating"), evidence("sensor.b", "idle")]));
  assert.equal(tied.value, null, "a tie is unknown, not an arbitrary winner");
  assert.ok(tied.assumptions.includes("tied-vote"));

  const unrecognized = vote(input([evidence("sensor.a", "flooded")]));
  assert.equal(unrecognized.value, null);
  assert.ok(
    unrecognized.assumptions.some((note) => note.startsWith("unrecognized-categories:")),
  );
});

test("freshness weight is deterministic across every mode", () => {
  const at = shiftIso(BASE_INSTANT, HOUR);

  const permanent = assessFreshness(
    { id: "p", mode: "permanent" },
    BASE_INSTANT,
    shiftIso(BASE_INSTANT, 365 * 24 * HOUR),
  );
  assert.equal(permanent.weight, 1);
  assert.equal(permanent.expired, false);

  const ttl = assessFreshness({ id: "t", mode: "fixed_ttl", ttlMs: HOUR }, BASE_INSTANT, at);
  assert.equal(ttl.weight, 1);
  assert.equal(ttl.expired, false);
  const expired = assessFreshness(
    { id: "t", mode: "fixed_ttl", ttlMs: HOUR },
    BASE_INSTANT,
    shiftIso(BASE_INSTANT, HOUR + 1),
  );
  assert.equal(expired.weight, 0);
  assert.equal(expired.expired, true);

  const linear = assessFreshness(
    { id: "l", mode: "linear_decay", ttlMs: 2 * HOUR },
    BASE_INSTANT,
    at,
  );
  assert.equal(linear.weight, 0.5);

  const exponential = assessFreshness(
    { id: "e", mode: "exponential_decay", halfLifeMs: HOUR },
    BASE_INSTANT,
    shiftIso(BASE_INSTANT, 2 * HOUR),
  );
  assert.equal(exponential.weight, 0.25);

  const future = assessFreshness(
    { id: "l", mode: "linear_decay", ttlMs: HOUR },
    shiftIso(BASE_INSTANT, HOUR),
    BASE_INSTANT,
  );
  assert.equal(future.weight, 1, "a future observation has zero age, not negative age");

  assert.throws(
    () => assessFreshness({ id: "bad", mode: "fixed_ttl" }, BASE_INSTANT, at),
    (error) => {
      assert.equal(error.code, "POWERFARM_KERNEL_CONFIG_INVALID");
      return true;
    },
  );
});

test("a repeated identical projection does not bump the context revision", async () => {
  const { kernel } = createKernel();
  await kernel.ingest(moistureSignal("signal:m1", "sensor.a", 20));
  const first = await kernel.getContext({ scope: "farm:north" });

  await kernel.ingest(moistureSignal("signal:m1", "sensor.a", 20));
  const second = await kernel.getContext({ scope: "farm:north" });

  assert.equal(second.revision, first.revision, "an idempotent duplicate changes nothing");
});

test("context reads return clones and can be narrowed to selected keys", async () => {
  const { kernel } = createKernel();
  await kernel.ingest(moistureSignal("signal:m1", "sensor.a", 20));

  const context = await kernel.getContext({ scope: "farm:north" });
  context.beliefs["belief:soil.moisture"].value = 999;
  const again = await kernel.getContext({ scope: "farm:north" });
  assert.equal(again.beliefs["belief:soil.moisture"].value, 20);

  const narrowed = await kernel.getContext({
    scope: "farm:north",
    beliefKeys: ["belief:soil.moisture"],
  });
  assert.deepEqual(Object.keys(narrowed.beliefs), ["belief:soil.moisture"]);

  const emptyScope = await kernel.getContext({ scope: "farm:south" });
  assert.deepEqual(emptyScope.beliefs, {});
  assert.equal(emptyScope.revision, 0);
});
