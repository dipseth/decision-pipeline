/**
 * Threshold resolution. A gate body never reads `process.env` — the runtime
 * resolves every threshold once, hands the NUMBERS to the body, and records
 * them on the span and the run record. That recording is the whole point:
 * a replay re-tunes a threshold offline with zero model calls.
 */

import type { Threshold } from "./types";

/** Where a named override actually comes from. The host owns both lookups. */
export interface ThresholdSource {
  /** Process env, or whatever stands in for it. */
  env?(name: string): string | undefined;
  /** A Langfuse prompt-config key. Langfuse wins over a literal, as today. */
  promptConfig?(key: string): number | undefined | Promise<number | undefined>;
}

export interface ResolvedThreshold {
  value: number;
  source: "literal" | "env" | "prompt-config" | "default";
  /** The name that was consulted, for `env` / `prompt-config`. */
  ref?: string;
}

const numberOrNull = (raw: unknown): number | null => {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export const resolveThreshold = async (
  threshold: Threshold,
  source: ThresholdSource = {},
): Promise<ResolvedThreshold> => {
  if (typeof threshold === "number") {
    return { value: threshold, source: "literal" };
  }

  if ("env" in threshold) {
    const raw = source.env?.(threshold.env);
    const parsed = numberOrNull(raw);
    return parsed === null
      ? { value: threshold.default, source: "default", ref: threshold.env }
      : { value: parsed, source: "env", ref: threshold.env };
  }

  const raw = await source.promptConfig?.(threshold.promptConfig);
  const parsed = numberOrNull(raw);
  return parsed === null
    ? { value: threshold.default, source: "default", ref: threshold.promptConfig }
    : { value: parsed, source: "prompt-config", ref: threshold.promptConfig };
};

export const resolveThresholds = async (
  thresholds: Record<string, Threshold>,
  source: ThresholdSource = {},
): Promise<Record<string, ResolvedThreshold>> => {
  const out: Record<string, ResolvedThreshold> = {};
  for (const [name, threshold] of Object.entries(thresholds)) {
    out[name] = await resolveThreshold(threshold, source);
  }
  return out;
};

export const thresholdValues = (
  resolved: Record<string, ResolvedThreshold>,
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [name, r] of Object.entries(resolved)) out[name] = r.value;
  return out;
};
