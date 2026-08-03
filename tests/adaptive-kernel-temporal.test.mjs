import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceWatermark,
  classifyTemporalDisposition,
  createAdaptiveCapabilityKernel,
  FixedKernelClock,
  InMemoryKernelStore,
  WATERMARK_SCHEMA_VERSION,
} from "../agent/kernel/index.ts";
import { BASE_INSTANT, buildSignal, shiftIso } from "./helpers/adaptive-kernel.mjs";

const policy = {
  allowedLatenessMs: 30_000,
  correctionWindowMs: 300_000,
  maximumFutureSkewMs: 30_000,
};

function watermarkAt(iso, allowedLatenessMs = policy.allowedLatenessMs) {
  return {
    schemaVersion: WATERMARK_SCHEMA_VERSION,
    source: "sensor.field-a.moisture",
    scope: "farm:north",
    maximumObservedAt: iso,
    currentWatermark: shiftIso(iso, -allowedLatenessMs),
    allowedLatenessMs,
    updatedAt: iso,
  };
}

function classify(observedAt, watermark = null, processedAt = BASE_INSTANT) {
  return classifyTemporalDisposition({
    observedAt,
    receivedAt: processedAt,
    processedAt,
    watermark,
    policy,
  });
}

test("the first event of a source is on time", () => {
  assert.equal(classify(BASE_INSTANT), "on_time");
  assert.equal(classify(shiftIso(BASE_INSTANT, -3_600_000)), "on_time");
});

test("events at or ahead of the watermark are on time", () => {
  const watermark = watermarkAt(BASE_INSTANT);
  assert.equal(classify(BASE_INSTANT, watermark), "on_time");
  assert.equal(classify(shiftIso(BASE_INSTANT, -30_000), watermark), "on_time");
});

test("late events are correctable inside the correction window", () => {
  const watermark = watermarkAt(BASE_INSTANT);
  assert.equal(classify(shiftIso(BASE_INSTANT, -30_001), watermark), "late_correctable");
  assert.equal(classify(shiftIso(BASE_INSTANT, -330_000), watermark), "late_correctable");
  assert.equal(classify(shiftIso(BASE_INSTANT, -330_001), watermark), "late_historical_only");
});

test("events beyond the future skew are future dated", () => {
  assert.equal(classify(shiftIso(BASE_INSTANT, 30_000)), "on_time");
  assert.equal(classify(shiftIso(BASE_INSTANT, 30_001)), "future_dated");
  assert.equal(
    classify(shiftIso(BASE_INSTANT, 86_400_000), watermarkAt(BASE_INSTANT)),
    "future_dated",
  );
});

test("unusable time inputs classify as invalid rather than guessing", () => {
  assert.equal(classify("not-a-date"), "invalid_time");
  assert.equal(classify("2026-08-03T12:00:00"), "invalid_time");
  assert.equal(
    classifyTemporalDisposition({
      observedAt: BASE_INSTANT,
      receivedAt: BASE_INSTANT,
      processedAt: BASE_INSTANT,
      watermark: null,
      policy: { ...policy, correctionWindowMs: Number.NaN },
    }),
    "invalid_time",
  );
});

test("classification is pure and repeatable", () => {
  const watermark = watermarkAt(BASE_INSTANT);
  const observedAt = shiftIso(BASE_INSTANT, -60_000);
  const runs = new Set(
    Array.from({ length: 5 }, () => classify(observedAt, structuredClone(watermark))),
  );
  assert.deepEqual([...runs], ["late_correctable"]);
});

test("the watermark advances deterministically and never regresses", () => {
  const first = advanceWatermark({
    current: null,
    source: "sensor.field-a.moisture",
    scope: "farm:north",
    observedAt: BASE_INSTANT,
    disposition: "on_time",
    allowedLatenessMs: policy.allowedLatenessMs,
    at: BASE_INSTANT,
  });
  assert.equal(first.maximumObservedAt, BASE_INSTANT);
  assert.equal(first.currentWatermark, shiftIso(BASE_INSTANT, -30_000));
  assert.equal(first.schemaVersion, WATERMARK_SCHEMA_VERSION);

  const afterLate = advanceWatermark({
    current: first,
    source: first.source,
    scope: first.scope,
    observedAt: shiftIso(BASE_INSTANT, -600_000),
    disposition: "late_historical_only",
    allowedLatenessMs: policy.allowedLatenessMs,
    at: shiftIso(BASE_INSTANT, 1_000),
  });
  assert.equal(afterLate.maximumObservedAt, BASE_INSTANT, "the maximum must not regress");
  assert.equal(afterLate.updatedAt, shiftIso(BASE_INSTANT, 1_000));

  const afterForward = advanceWatermark({
    current: afterLate,
    source: first.source,
    scope: first.scope,
    observedAt: shiftIso(BASE_INSTANT, 10_000),
    disposition: "on_time",
    allowedLatenessMs: policy.allowedLatenessMs,
    at: shiftIso(BASE_INSTANT, 10_000),
  });
  assert.equal(afterForward.maximumObservedAt, shiftIso(BASE_INSTANT, 10_000));
  assert.deepEqual(
    advanceWatermark({
      current: afterLate,
      source: first.source,
      scope: first.scope,
      observedAt: shiftIso(BASE_INSTANT, 10_000),
      disposition: "on_time",
      allowedLatenessMs: policy.allowedLatenessMs,
      at: shiftIso(BASE_INSTANT, 10_000),
    }),
    afterForward,
    "identical inputs must produce identical state",
  );
});

test("a future dated event does not drag the watermark forward", () => {
  const base = advanceWatermark({
    current: null,
    source: "sensor.field-a.moisture",
    scope: "farm:north",
    observedAt: BASE_INSTANT,
    disposition: "on_time",
    allowedLatenessMs: policy.allowedLatenessMs,
    at: BASE_INSTANT,
  });

  const skewed = advanceWatermark({
    current: base,
    source: base.source,
    scope: base.scope,
    observedAt: shiftIso(BASE_INSTANT, 86_400_000),
    disposition: "future_dated",
    allowedLatenessMs: policy.allowedLatenessMs,
    at: BASE_INSTANT,
  });
  assert.equal(skewed.maximumObservedAt, BASE_INSTANT);

  const firstEverSkewed = advanceWatermark({
    current: null,
    source: base.source,
    scope: base.scope,
    observedAt: shiftIso(BASE_INSTANT, 86_400_000),
    disposition: "future_dated",
    allowedLatenessMs: policy.allowedLatenessMs,
    at: BASE_INSTANT,
  });
  assert.equal(firstEverSkewed.maximumObservedAt, BASE_INSTANT);
});

test("watermarks are tracked per source and scope", async () => {
  const clock = new FixedKernelClock(BASE_INSTANT);
  const kernel = createAdaptiveCapabilityKernel({ clock, store: new InMemoryKernelStore() });

  await kernel.ingest(buildSignal({ id: "signal:a" }));
  await kernel.ingest(
    buildSignal({
      id: "signal:b",
      source: "sensor.field-b.moisture",
      observedAt: shiftIso(BASE_INSTANT, -3_600_000),
      receivedAt: BASE_INSTANT,
    }),
  );

  const fieldA = await kernel.getWatermark("sensor.field-a.moisture", "farm:north");
  const fieldB = await kernel.getWatermark("sensor.field-b.moisture", "farm:north");
  assert.equal(fieldA.maximumObservedAt, BASE_INSTANT);
  assert.equal(fieldB.maximumObservedAt, shiftIso(BASE_INSTANT, -3_600_000));
  assert.equal(await kernel.getWatermark("sensor.field-a.moisture", "farm:south"), null);
});

test("late arrival creates a new record and leaves earlier history intact", async () => {
  const clock = new FixedKernelClock(BASE_INSTANT);
  const kernel = createAdaptiveCapabilityKernel({ clock, store: new InMemoryKernelStore() });

  await kernel.ingest(buildSignal({ id: "signal:a" }));
  clock.advance(1_000);
  const late = await kernel.ingest(
    buildSignal({
      id: "signal:late",
      observedAt: shiftIso(BASE_INSTANT, -60_000),
      receivedAt: shiftIso(BASE_INSTANT, 1_000),
      data: { percent: 12.5 },
    }),
  );

  assert.equal(late.disposition, "late_correctable");
  assert.equal(late.admission, "admitted");

  const stored = await kernel.listSignals({});
  assert.deepEqual(
    stored.map((record) => record.signal.id),
    ["signal:late", "signal:a"],
    "listing is ordered by event time, not by arrival",
  );
  assert.deepEqual(
    stored.map((record) => record.admissionSequence),
    [2, 1],
  );
  assert.equal(stored[1].disposition, "on_time", "the earlier record keeps its disposition");
});

test("per source and per type temporal policy overrides are applied", async () => {
  const clock = new FixedKernelClock(BASE_INSTANT);
  const kernel = createAdaptiveCapabilityKernel({
    clock,
    store: new InMemoryKernelStore(),
    config: {
      sources: { "sensor.field-a.moisture": { temporal: { correctionWindowMs: 1_000 } } },
      signalTypes: { "soil.moisture.percent": { maximumFutureSkewMs: 600_000 } },
    },
  });

  await kernel.ingest(buildSignal({ id: "signal:a" }));

  const stillOnTime = await kernel.ingest(
    buildSignal({
      id: "signal:future",
      observedAt: shiftIso(BASE_INSTANT, 120_000),
      receivedAt: BASE_INSTANT,
    }),
  );
  assert.equal(stillOnTime.disposition, "on_time", "the type override widens the future skew");

  const late = await kernel.ingest(
    buildSignal({
      id: "signal:late",
      observedAt: shiftIso(BASE_INSTANT, -120_000),
      receivedAt: BASE_INSTANT,
    }),
  );
  assert.equal(late.disposition, "late_historical_only", "the narrow correction window applies");
});
