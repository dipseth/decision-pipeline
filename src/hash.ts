/**
 * Hashing for the run record. Two things depend on it being STABLE across
 * processes and orderings: `input_hash` (per-node cache key + offline replay)
 * and the composite `<fact>_version`.
 */

import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted at every depth, so `{a,b}` and `{b,a}` hash the
 * same. Arrays keep their order (an ingredient list is not a set). Values JSON
 * cannot carry are tagged rather than silently dropped, because a node input
 * that hashes the same as a different input is a replay bug, not a nuisance.
 */
export const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();

  const walk = (v: unknown): string => {
    if (v === undefined) return '"__undefined__"';
    if (v === null) return "null";
    const t = typeof v;
    if (t === "number") return Number.isFinite(v as number) ? String(v) : '"__nonfinite__"';
    if (t === "boolean") return String(v);
    if (t === "string") return JSON.stringify(v);
    if (t === "bigint") return JSON.stringify(`__bigint__${String(v)}`);
    if (t === "function") return JSON.stringify(`__fn__${(v as { name?: string }).name || "anonymous"}`);
    if (t === "symbol") return JSON.stringify(`__symbol__${String(v)}`);

    const obj = v as object;
    if (seen.has(obj)) return '"__cycle__"';
    seen.add(obj);
    try {
      if (Array.isArray(obj)) return `[${obj.map(walk).join(",")}]`;
      if (obj instanceof Date) return JSON.stringify(obj.toISOString());
      if (obj instanceof Map) {
        const entries = [...obj.entries()]
          .map(([k, val]) => [String(k), val] as const)
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${walk(val)}`).join(",")}}`;
      }
      if (obj instanceof Set) return `[${[...obj].map(walk).sort().join(",")}]`;

      const keys = Object.keys(obj as Record<string, unknown>).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const val = (obj as Record<string, unknown>)[k];
        if (val === undefined) continue; // absent and explicit-undefined hash alike
        parts.push(`${JSON.stringify(k)}:${walk(val)}`);
      }
      return `{${parts.join(",")}}`;
    } finally {
      seen.delete(obj);
    }
  };

  return walk(value);
};

export const sha256Hex = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

/** 16 hex chars — 64 bits, plenty for a cache key, short enough for a span attribute. */
export const shortHash = (value: unknown): string =>
  sha256Hex(stableStringify(value)).slice(0, 16);

/**
 * Deterministic 0..1 for experiment assignment. Recomputable from the run
 * record, which is what makes an assignment auditable rather than a guess.
 */
export const hashToUnit = (input: string): number => {
  const hex = sha256Hex(input).slice(0, 13); // 52 bits, exact in a double
  return parseInt(hex, 16) / 2 ** 52;
};
