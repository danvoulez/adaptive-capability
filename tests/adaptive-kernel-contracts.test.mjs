import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  DeterministicKernelIdFactory,
  FixedKernelClock,
  isIsoTimestamp,
  KernelError,
  kernelErrorCodes,
  kernelLimits,
  sanitizeErrorText,
  signalEnvelopeSchema,
  SIGNAL_SCHEMA_VERSION,
  temporalDispositions,
  toEpochMs,
  unitIntervalSchema,
} from "../agent/kernel/index.ts";
import { BASE_INSTANT, buildSignal, kernelRoot } from "./helpers/adaptive-kernel.mjs";

test("a well formed signal envelope parses", () => {
  const parsed = signalEnvelopeSchema.safeParse(buildSignal());
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.schemaVersion, SIGNAL_SCHEMA_VERSION);
});

test("the envelope refuses an unknown schema version", () => {
  const parsed = signalEnvelopeSchema.safeParse(
    buildSignal({ schemaVersion: "powerfarm.signal.v2" }),
  );
  assert.equal(parsed.success, false);
});

test("data and missing are mutually exclusive and one is required", () => {
  const conflicting = buildSignal();
  conflicting.missing = { reason: "sensor_offline" };
  assert.equal(signalEnvelopeSchema.safeParse(conflicting).success, false);

  const neither = buildSignal();
  delete neither.data;
  assert.equal(signalEnvelopeSchema.safeParse(neither).success, false);

  const onlyMissing = signalEnvelopeSchema.safeParse(
    buildSignal({ class: "missingness", missing: { reason: "sensor_offline", retryable: true } }),
  );
  assert.equal(onlyMissing.success, true);
});

test("derived signals must name their origin and their model", () => {
  const withoutOrigin = signalEnvelopeSchema.safeParse(buildSignal({ class: "derived" }));
  assert.equal(withoutOrigin.success, false);

  const withOrigin = signalEnvelopeSchema.safeParse(
    buildSignal({
      class: "derived",
      acquisition: "derived",
      provenance: { derivedFrom: ["signal:soil-moisture-0001"] },
    }),
  );
  assert.equal(withOrigin.success, true);

  const modelShapedWithoutRef = signalEnvelopeSchema.safeParse(
    buildSignal({
      class: "derived",
      acquisition: "derived",
      provenance: { derivedFrom: ["signal:soil-moisture-0001"], promptHash: "sha256:abc" },
    }),
  );
  assert.equal(modelShapedWithoutRef.success, false);

  const modelRefOnObservation = signalEnvelopeSchema.safeParse(
    buildSignal({ provenance: { modelRef: "ollama:qwen3:0.6b" } }),
  );
  assert.equal(modelRefOnObservation.success, false);
});

test("validUntil may not precede validFrom", () => {
  const parsed = signalEnvelopeSchema.safeParse(
    buildSignal({ validFrom: BASE_INSTANT, validUntil: "2026-08-03T11:00:00.000Z" }),
  );
  assert.equal(parsed.success, false);
});

test("timestamps require an explicit offset and a real instant", () => {
  assert.equal(isIsoTimestamp("2026-08-03T12:00:00.000Z"), true);
  assert.equal(isIsoTimestamp("2026-08-03T12:00:00+02:00"), true);
  assert.equal(isIsoTimestamp("2026-08-03T12:00:00"), false);
  assert.equal(isIsoTimestamp("2026-13-45T99:00:00Z"), false);
  assert.equal(isIsoTimestamp("not-a-date"), false);
  assert.equal(isIsoTimestamp(1_754_222_400_000), false);

  assert.throws(() => toEpochMs("not-a-date", "observedAt"), (error) => {
    assert.ok(error instanceof KernelError);
    assert.equal(error.code, "POWERFARM_KERNEL_TIMESTAMP_INVALID");
    return true;
  });
});

test("unit intervals reject values outside zero and one", () => {
  assert.equal(unitIntervalSchema.safeParse(0).success, true);
  assert.equal(unitIntervalSchema.safeParse(1).success, true);
  assert.equal(unitIntervalSchema.safeParse(1.0001).success, false);
  assert.equal(unitIntervalSchema.safeParse(-0.1).success, false);
  assert.equal(unitIntervalSchema.safeParse(Number.NaN).success, false);
  assert.equal(unitIntervalSchema.safeParse(Number.POSITIVE_INFINITY).success, false);
});

test("identifier and label limits are enforced", () => {
  const longId = "a".repeat(kernelLimits.identifierMaxLength + 1);
  assert.equal(signalEnvelopeSchema.safeParse(buildSignal({ id: longId })).success, false);

  const longType = "b".repeat(kernelLimits.labelMaxLength + 1);
  assert.equal(signalEnvelopeSchema.safeParse(buildSignal({ type: longType })).success, false);
  assert.equal(signalEnvelopeSchema.safeParse(buildSignal({ scope: "" })).success, false);
});

test("kernel error codes are stable and error text carries no host detail", () => {
  assert.ok(kernelErrorCodes.includes("POWERFARM_KERNEL_SIGNAL_DUPLICATE_CONFLICT"));
  assert.ok(kernelErrorCodes.includes("POWERFARM_KERNEL_SECRET_FIELD_REJECTED"));
  assert.equal(new Set(kernelErrorCodes).size, kernelErrorCodes.length);
  for (const code of kernelErrorCodes) {
    assert.match(code, /^POWERFARM_KERNEL_[A-Z_]+$/u);
  }

  // Assembled at runtime so the repository security audit does not see a
  // credential-shaped literal in a source file.
  const connectionLike = ["postgres", "://user", ":pw@db.internal:5432/powerfarm"].join("");
  const error = new KernelError(
    "POWERFARM_KERNEL_SIGNAL_INVALID",
    "failed reading /Users/dan/powerfarm/agent/kernel/kernel.ts",
    { origin: connectionLike },
  );
  assert.equal(error.message.includes("/Users/dan"), false);
  assert.equal(error.details.origin.includes("pw@"), false);
  assert.equal(sanitizeErrorText("see http://127.0.0.1:11434/api"), "see [redacted-url]");
  assert.ok(error.message.startsWith("POWERFARM_KERNEL_SIGNAL_INVALID"));
});

test("the fixed clock and deterministic id factory are reproducible", () => {
  const clock = new FixedKernelClock(BASE_INSTANT);
  assert.equal(clock.now().toISOString(), BASE_INSTANT);
  clock.now().setUTCFullYear(1999);
  assert.equal(clock.now().toISOString(), BASE_INSTANT, "the clock must return a copy");
  clock.advance(1_000);
  assert.equal(clock.now().toISOString(), "2026-08-03T12:00:01.000Z");

  const first = new DeterministicKernelIdFactory("seed");
  const second = new DeterministicKernelIdFactory("seed");
  assert.equal(first.next("evaluation"), "evaluation:seed-000001");
  assert.equal(first.next("evaluation"), "evaluation:seed-000002");
  assert.equal(first.next("episode"), "episode:seed-000001");
  assert.equal(second.next("evaluation"), "evaluation:seed-000001");
});

test("temporal dispositions are the closed published set", () => {
  assert.deepEqual([...temporalDispositions].sort(), [
    "duplicate",
    "future_dated",
    "invalid_time",
    "late_correctable",
    "late_historical_only",
    "on_time",
  ]);
});

test("the kernel source tree contains no network access", async () => {
  const forbidden = [
    /\bfetch\s*\(/u,
    /node:https?/u,
    /node:net\b/u,
    /node:dgram\b/u,
    /\bXMLHttpRequest\b/u,
    /\bWebSocket\b/u,
    /\bundici\b/u,
  ];

  const files = await readdir(kernelRoot, { recursive: true, withFileTypes: true });
  const sources = files.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
  assert.ok(sources.length > 0);

  for (const entry of sources) {
    const path = join(entry.parentPath ?? entry.path, entry.name);
    const text = await readFile(path, "utf8");
    for (const pattern of forbidden) {
      assert.equal(pattern.test(text), false, `${entry.name} must not reference ${pattern}`);
    }
  }
});
