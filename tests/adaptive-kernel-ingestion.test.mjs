import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdaptiveCapabilityKernel,
  FixedKernelClock,
  InMemoryKernelStore,
  KernelError,
} from "../agent/kernel/index.ts";
import { BASE_INSTANT, buildSignal, shiftIso } from "./helpers/adaptive-kernel.mjs";

function createKernel(config = {}) {
  const clock = new FixedKernelClock(BASE_INSTANT);
  const store = new InMemoryKernelStore();
  const kernel = createAdaptiveCapabilityKernel({ clock, store, config });
  return { clock, kernel, store };
}

async function expectKernelError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof KernelError, `expected a KernelError, received ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("a valid signal is admitted and recorded once", async () => {
  const { kernel, store } = createKernel();
  const result = await kernel.ingest(buildSignal());

  assert.equal(result.admission, "admitted");
  assert.equal(result.disposition, "on_time");
  assert.equal(result.signalId, "signal:soil-moisture-0001");
  assert.match(result.contentHash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.processedAt, BASE_INSTANT);
  assert.deepEqual(result.stagesExecuted, [
    "validate",
    "reject_secrets",
    "hash",
    "deduplicate",
    "classify_temporal",
    "persist_signal",
    "update_watermark",
    "index_affected_beliefs",
    "project_context",
    "recompute_beliefs",
  ]);
  assert.equal(result.contextRevision, null, "no beliefs are registered by default");
  assert.deepEqual(result.changedBeliefKeys, []);
  assert.equal(store.size, 1);

  const stored = await kernel.listSignals({});
  assert.equal(stored.length, 1);
  assert.equal(stored[0].signal.data.percent, 31.4);
  assert.equal(stored[0].admissionSequence, 1);
});

test("an identical duplicate is idempotent", async () => {
  const { kernel, store } = createKernel();
  const signal = buildSignal();

  const first = await kernel.ingest(signal);
  const second = await kernel.ingest(structuredClone(signal));

  assert.equal(first.admission, "admitted");
  assert.equal(second.admission, "duplicate");
  assert.equal(second.disposition, "duplicate");
  assert.equal(second.contentHash, first.contentHash);
  assert.equal(store.size, 1);
});

test("a conflicting duplicate fails closed", async () => {
  const { kernel, store } = createKernel();
  await kernel.ingest(buildSignal());

  await expectKernelError(
    kernel.ingest(buildSignal({ data: { percent: 88.8 } })),
    "POWERFARM_KERNEL_SIGNAL_DUPLICATE_CONFLICT",
  );
  assert.equal(store.size, 1);

  const stored = await kernel.listSignals({});
  assert.equal(stored[0].signal.data.percent, 31.4, "history must not be rewritten");
});

test("an invalid timestamp is rejected", async () => {
  const { kernel } = createKernel();

  await expectKernelError(
    kernel.ingest(buildSignal({ observedAt: "not-a-date" })),
    "POWERFARM_KERNEL_TIMESTAMP_INVALID",
  );
  await expectKernelError(
    kernel.ingest(buildSignal({ id: "signal:b", observedAt: "2026-13-45T99:00:00Z" })),
    "POWERFARM_KERNEL_TIMESTAMP_INVALID",
  );
  await expectKernelError(
    kernel.ingest(buildSignal({ id: "signal:c", receivedAt: "2026-08-03T12:00:00" })),
    "POWERFARM_KERNEL_TIMESTAMP_INVALID",
  );
});

test("missingness is preserved and never becomes an empty value", async () => {
  const { kernel } = createKernel();
  await kernel.ingest(
    buildSignal({
      id: "signal:missing-0001",
      class: "missingness",
      missing: { reason: "sensor_offline", retryable: true, expectedAt: BASE_INSTANT },
    }),
  );

  const [stored] = await kernel.listSignals({});
  assert.equal(Object.prototype.hasOwnProperty.call(stored.signal, "data"), false);
  assert.deepEqual(stored.signal.missing, {
    reason: "sensor_offline",
    retryable: true,
    expectedAt: BASE_INSTANT,
  });
});

test("secret shaped keys are rejected before persistence", async () => {
  const { kernel, store } = createKernel();

  await expectKernelError(
    kernel.ingest(buildSignal({ data: { access_token: "abc" } })),
    "POWERFARM_KERNEL_SECRET_FIELD_REJECTED",
  );
  await expectKernelError(
    kernel.ingest(buildSignal({ id: "signal:b", data: { nested: { database_url: "x" } } })),
    "POWERFARM_KERNEL_SECRET_FIELD_REJECTED",
  );
  assert.equal(store.size, 0);
});

test("oversized envelopes and unconfigured sources or scopes fail closed", async () => {
  const { kernel } = createKernel({ maximumSignalBytes: 512 });
  await expectKernelError(
    kernel.ingest(buildSignal({ data: { note: "x".repeat(1_024) } })),
    "POWERFARM_KERNEL_SIGNAL_TOO_LARGE",
  );

  const restricted = createKernel({
    allowedSources: ["sensor.field-a.moisture"],
    allowedScopes: ["farm:north"],
  }).kernel;

  await expectKernelError(
    restricted.ingest(buildSignal({ source: "sensor.unknown" })),
    "POWERFARM_KERNEL_SOURCE_NOT_ALLOWED",
  );
  await expectKernelError(
    restricted.ingest(buildSignal({ scope: "farm:elsewhere" })),
    "POWERFARM_KERNEL_SCOPE_INVALID",
  );
});

test("the store returns clones rather than internal references", async () => {
  const { kernel, store } = createKernel();
  await kernel.ingest(buildSignal());

  const first = await store.getSignal("signal:soil-moisture-0001");
  first.signal.data.percent = 0;
  first.disposition = "late_historical_only";

  const second = await store.getSignal("signal:soil-moisture-0001");
  assert.equal(second.signal.data.percent, 31.4);
  assert.equal(second.disposition, "on_time");

  const listed = await kernel.listSignals({});
  listed[0].contentHash = "sha256:tampered";
  const listedAgain = await kernel.listSignals({});
  assert.equal(listedAgain[0].contentHash, second.contentHash);

  const watermark = await kernel.getWatermark("sensor.field-a.moisture", "farm:north");
  watermark.currentWatermark = "1999-01-01T00:00:00.000Z";
  const watermarkAgain = await kernel.getWatermark("sensor.field-a.moisture", "farm:north");
  assert.notEqual(watermarkAgain.currentWatermark, "1999-01-01T00:00:00.000Z");
});

test("source reliability comes from configuration, not from the sender", async () => {
  const untrusted = createKernel().kernel;
  await untrusted.ingest(buildSignal({ quality: { sourceReliability: 1 } }));
  const [claimed] = await untrusted.listSignals({});
  assert.equal(claimed.sourceReliability, null, "unknown must stay unknown");
  assert.equal(claimed.sourceReliabilityOrigin, "unknown");
  assert.equal(claimed.signal.quality.sourceReliability, 1, "the raw claim is preserved as claimed");

  const configured = createKernel({
    sources: { "sensor.field-a.moisture": { sourceReliability: 0.4 } },
  }).kernel;
  await configured.ingest(buildSignal({ quality: { sourceReliability: 1 } }));
  const [trusted] = await configured.listSignals({});
  assert.equal(trusted.sourceReliability, 0.4);
  assert.equal(trusted.sourceReliabilityOrigin, "configured");
});

test("the pipeline can stop after a named stage without persisting", async () => {
  const { kernel, store } = createKernel();
  const result = await kernel.ingest(buildSignal(), { stopAfter: "classify_temporal" });

  assert.equal(result.admission, "withheld");
  assert.equal(result.disposition, "on_time");
  assert.equal(store.size, 0);
  assert.equal(result.stagesExecuted.at(-1), "classify_temporal");
});

test("a batch reports per item disposition and preserves input order", async () => {
  const { kernel } = createKernel();
  const signals = [
    buildSignal({ id: "signal:a", observedAt: BASE_INSTANT, receivedAt: BASE_INSTANT }),
    buildSignal({
      id: "signal:b",
      observedAt: shiftIso(BASE_INSTANT, -600_000),
      receivedAt: BASE_INSTANT,
    }),
    buildSignal({
      id: "signal:c",
      observedAt: shiftIso(BASE_INSTANT, 600_000),
      receivedAt: BASE_INSTANT,
    }),
  ];

  const batch = await kernel.ingestBatch(signals);
  assert.equal(batch.admittedCount, 3);
  assert.equal(batch.rejectedCount, 0);
  assert.deepEqual(
    batch.items.map((item) => item.signalId),
    ["signal:a", "signal:b", "signal:c"],
  );
  assert.deepEqual(
    batch.items.map((item) => item.result.disposition),
    ["on_time", "late_historical_only", "future_dated"],
  );
});

test("a batch validates every item before writing and does not process duplicates twice", async () => {
  const { kernel, store } = createKernel();
  const duplicated = buildSignal({ id: "signal:a" });

  const batch = await kernel.ingestBatch([
    duplicated,
    structuredClone(duplicated),
    buildSignal({ id: "signal:b", observedAt: "not-a-date" }),
  ]);

  assert.equal(batch.admittedCount, 1);
  assert.equal(batch.duplicateCount, 1);
  assert.equal(batch.rejectedCount, 1);
  assert.equal(batch.items[1].status, "duplicate");
  assert.equal(batch.items[2].status, "rejected");
  assert.equal(batch.items[2].errorCode, "POWERFARM_KERNEL_TIMESTAMP_INVALID");
  assert.equal(store.size, 1);
});

test("an atomic batch writes nothing when any item is rejected", async () => {
  const { kernel, store } = createKernel();

  await expectKernelError(
    kernel.ingestBatch(
      [buildSignal({ id: "signal:a" }), buildSignal({ id: "signal:b", scope: "" })],
      { atomic: true },
    ),
    "POWERFARM_KERNEL_SIGNAL_INVALID",
  );
  assert.equal(store.size, 0);
});

test("a batch refuses the same id with conflicting content", async () => {
  const { kernel, store } = createKernel();
  const batch = await kernel.ingestBatch([
    buildSignal({ id: "signal:a", data: { percent: 1 } }),
    buildSignal({ id: "signal:a", data: { percent: 2 } }),
  ]);

  assert.equal(batch.items[1].status, "rejected");
  assert.equal(batch.items[1].errorCode, "POWERFARM_KERNEL_SIGNAL_DUPLICATE_CONFLICT");
  assert.equal(store.size, 1);
});

test("configuration validation fails closed", () => {
  assert.throws(
    () => createAdaptiveCapabilityKernel({ config: { temporal: { allowedLatenessMs: -1 } } }),
    (error) => {
      assert.equal(error.code, "POWERFARM_KERNEL_CONFIG_INVALID");
      return true;
    },
  );
  assert.throws(
    () => createAdaptiveCapabilityKernel({ config: { maximumSignalBytes: Number.NaN } }),
    (error) => {
      assert.equal(error.code, "POWERFARM_KERNEL_CONFIG_INVALID");
      return true;
    },
  );
});
