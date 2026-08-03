import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const kernelRoot = join(projectRoot, "agent", "kernel");

export const BASE_INSTANT = "2026-08-03T12:00:00.000Z";

/**
 * Builds a valid signal envelope. Overrides are shallow at the top level and
 * merged one level deep for the nested policy objects.
 */
export function buildSignal(overrides = {}) {
  const {
    quality = {},
    provenance = {},
    handling = {},
    missing,
    ...rest
  } = overrides;

  const signal = {
    schemaVersion: "powerfarm.signal.v1",
    id: "signal:soil-moisture-0001",
    type: "soil.moisture.percent",
    source: "sensor.field-a.moisture",
    subject: "plot:field-a",
    scope: "farm:north",
    class: "observation",
    acquisition: "passive",
    cadence: "periodic",
    observedAt: BASE_INSTANT,
    receivedAt: BASE_INSTANT,
    data: { percent: 31.4 },
    quality: { authenticity: 1, completeness: 1, ...quality },
    provenance: { adapterId: "adapter:moisture", adapterVersion: "1.0.0", ...provenance },
    handling: {
      tenantId: "tenant:powerfarm",
      sensitivity: "internal",
      retentionClass: "operational-90d",
      ...handling,
    },
    ...rest,
  };

  if (missing !== undefined) {
    delete signal.data;
    signal.missing = missing;
  }

  return signal;
}

export function shiftIso(iso, milliseconds) {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}
