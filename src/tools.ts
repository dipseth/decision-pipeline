/**
 * Tool resolution for a `generate` node: `static u selected`, bounded by
 * `allow`, minus every tool whose MCP scope the run was not granted.
 *
 * The registry itself is NOT here — the host owns it (`agents/tool-registry.ts`
 * is already the global one). This module adds selection and accounting on top,
 * because both belong to the pipeline layer and neither exists today.
 *
 * Rule, same as branching: a `decide` node never attaches a tool. It emits one
 * Noul per candidate; a `code` gate turns those into a subset.
 */

import type { ToolSpec } from "./types";

/** The host's view of the global registry. Only what selection needs. */
export interface ToolRegistry {
  /** Does this name resolve to a real tool? Unknown names are dropped, loudly. */
  has?(name: string): boolean;
  /**
   * The MCP scope a tool needs (`recipes:read` / `list:sync` / `cook:assist`),
   * or null when it needs none. A run can never offer a tool wider than its grant.
   */
  scopeOf?(name: string): string | null | undefined;
}

export interface ResolveToolsInput {
  spec: ToolSpec | undefined;
  /** What `static: "prompt-config"` resolves to — the Langfuse prompt's `config.tools`. */
  promptConfigTools?: readonly string[];
  /** The preceding decide node's distributions, for `selectable`. */
  distributions?: Record<string, number[]>;
  /** Resolved value of `selectable.threshold`. */
  selectThreshold?: number;
  grants?: readonly string[];
  registry?: ToolRegistry;
}

export interface ResolvedTools {
  offered: string[];
  /** Selected candidate -> the Noul that selected it. Lands on the run record. */
  selected: Record<string, number>;
  dropped_for_scope: string[];
  dropped_for_allow: string[];
  dropped_unknown: string[];
}

export const DEFAULT_TOOL_SELECT_THRESHOLD = 0.5;

/**
 * Where a candidate tool's Noul lives in the decide node's distributions.
 * `tool:<name>` is the convention; a bare `<name>` key is accepted so a decide
 * node that already asks about a tool by name needs no rewrite.
 */
export const toolNoul = (
  distributions: Record<string, number[]> | undefined,
  candidate: string,
): number | null => {
  if (!distributions) return null;
  const dist = distributions[`tool:${candidate}`] ?? distributions[candidate];
  if (!dist || dist.length === 0) return null;
  // A Noul is one absolute probability. When a Choice is used instead, the
  // FIRST entry is the "yes" option by convention, matching how the gate on a
  // two-option Choice already reads.
  const p = dist[0];
  return typeof p === "number" && Number.isFinite(p) ? p : null;
};

export const resolveTools = (input: ResolveToolsInput): ResolvedTools => {
  const { spec, registry } = input;
  const selected: Record<string, number> = {};
  const dropped_for_scope: string[] = [];
  const dropped_for_allow: string[] = [];
  const dropped_unknown: string[] = [];

  if (!spec) {
    return { offered: [], selected, dropped_for_scope, dropped_for_allow, dropped_unknown };
  }

  const base =
    spec.static === "prompt-config"
      ? [...(input.promptConfigTools ?? [])]
      : [...(spec.static ?? [])];

  const threshold = input.selectThreshold ?? DEFAULT_TOOL_SELECT_THRESHOLD;
  for (const candidate of spec.selectable?.candidates ?? []) {
    const p = toolNoul(input.distributions, candidate);
    if (p !== null && p >= threshold) selected[candidate] = p;
  }

  const allow = spec.allow ? new Set(spec.allow) : null;
  const grants = new Set(input.grants ?? []);
  const offered: string[] = [];
  const seen = new Set<string>();

  for (const name of [...base, ...Object.keys(selected)]) {
    if (seen.has(name)) continue;
    seen.add(name);

    // `allow` is validated at manifest load for names the manifest itself
    // lists; a prompt-config set resolves at RUN time, so it is checked here
    // too rather than trusted.
    if (allow && !allow.has(name)) {
      dropped_for_allow.push(name);
      delete selected[name];
      continue;
    }
    if (registry?.has && !registry.has(name)) {
      dropped_unknown.push(name);
      delete selected[name];
      continue;
    }
    const needed = registry?.scopeOf?.(name);
    if (needed && !grants.has(needed)) {
      dropped_for_scope.push(name);
      delete selected[name];
      continue;
    }
    offered.push(name);
  }

  return { offered, selected, dropped_for_scope, dropped_for_allow, dropped_unknown };
};
