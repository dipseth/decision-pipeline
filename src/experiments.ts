/**
 * Experiments — a variant is a PATCH over the declarative half of a manifest.
 *
 * That falls straight out of "manifest, not interpreter": if a variant needs a
 * new `run:` function it is a new NODE VERSION, not a variant. Structural A/B
 * and config A/B collapse into one mechanism, and the patch diff is the arm
 * diff, for free.
 *
 * Arms resolve in the runtime alongside `ScopeContext`, before node 0 — the
 * same position, for the same reason. An arm decidable mid-run from mid-run
 * state could never be replayed offline, and replay is the whole point.
 */

import { hashToUnit } from "./hash";
import { scopeIndex, type Scope, type ToolSpec } from "./types";

/** Only the declarative half. There is deliberately no way to patch a node body. */
export interface ManifestPatch {
  /** nodeId -> threshold name -> literal value. */
  thresholds?: Record<string, Record<string, number>>;
  /** nodeId -> Langfuse prompt ref (generate nodes). */
  prompts?: Record<string, string>;
  /** nodeId -> Jev question prompt name (decide nodes). */
  questions?: Record<string, string>;
  /** nodeId -> model route (generate nodes). */
  routes?: Record<string, string>;
  /** nodeId -> ToolSpec (generate nodes). */
  tools?: Record<string, ToolSpec>;
  /** Edge guard patch. `when: null` removes a guard; a missing edge is a validation error. */
  guards?: Array<{
    from: string;
    to: string;
    when: { gate: string; branch: string } | null;
  }>;
}

export type ExperimentMode =
  /** Free: re-derive from the recorded distributions. No model calls, no exposure. */
  | "replay"
  /** Model calls only: re-run the decide node against the recorded input. */
  | "replay-redecide"
  /** ~2x cost: both arms run, ONE ships. The challenger must not write the fact. */
  | "shadow"
  /** 1x cost, real exposure, waits for labels. The last resort, never the default. */
  | "split";

export interface ExperimentSpec {
  id: string;
  /**
   * Assign at the WIDEST scope any feedback edge writes to (usually `user`).
   * Then feedback contamination between arms is impossible by construction: a
   * row written under arm B can only ever be read by arm-B runs.
   */
  unit: Scope;
  mode: ExperimentMode;
  /** The arm that ships when nothing is assigned. Must be a key of `arms`. */
  champion: string;
  /** Arm name -> patch. The champion's patch is normally `{}`. */
  arms: Record<string, ManifestPatch>;
  /** `split` only. Defaults to equal weight across arms. */
  weights?: Record<string, number>;
  /** Declared is not running. Default false. */
  enabled?: boolean;
}

export interface ArmAssignment {
  experiment: string;
  arm: string;
  unit: Scope | null;
  /** Hash of the assigning id, so an assignment is auditable and recomputable. */
  hash: string | null;
  /** True when the arm ships; false for a shadow challenger, which must not write the fact. */
  ships: boolean;
  reason: "disabled" | "no-unit-id" | "champion" | "assigned" | "shadow-challenger";
}

const armNames = (spec: ExperimentSpec): string[] => Object.keys(spec.arms).sort();

/**
 * Deterministic, recomputable, and independent per experiment — so two
 * concurrent experiments stay orthogonal for measurement even though their
 * user-visible COMBINATION may still be bad. Recording `arms` as a map is what
 * keeps that detectable.
 */
export const assignArm = (
  spec: ExperimentSpec,
  unitId: string | undefined,
): ArmAssignment => {
  const champion: ArmAssignment = {
    experiment: spec.id,
    arm: spec.champion,
    unit: spec.unit,
    hash: null,
    ships: true,
    reason: "champion",
  };

  if (spec.enabled !== true) return { ...champion, reason: "disabled" };
  if (spec.mode === "replay" || spec.mode === "replay-redecide") {
    // Offline modes never touch a live run.
    return { ...champion, reason: "champion" };
  }
  if (!unitId) return { ...champion, reason: "no-unit-id" };

  const hash = `${spec.id}:${spec.unit}:${unitId}`;

  if (spec.mode === "shadow") {
    // Both arms run; the champion is what ships. The challenger is resolved by
    // the caller running the pipeline a second time with `forceArm`.
    return { ...champion, hash, reason: "champion" };
  }

  const names = armNames(spec);
  const weights = names.map((n) => Math.max(0, spec.weights?.[n] ?? 1));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return { ...champion, hash, reason: "champion" };

  let cursor = hashToUnit(hash) * total;
  for (let i = 0; i < names.length; i += 1) {
    cursor -= weights[i] ?? 0;
    if (cursor < 0) {
      const arm = names[i] ?? spec.champion;
      return {
        experiment: spec.id,
        arm,
        unit: spec.unit,
        hash,
        ships: true,
        reason: "assigned",
      };
    }
  }
  return { ...champion, hash, reason: "champion" };
};

/** The shadow challenger's assignment — it runs, it is recorded, it must NOT write the fact. */
export const shadowChallenger = (
  spec: ExperimentSpec,
  arm: string,
  unitId: string | undefined,
): ArmAssignment => ({
  experiment: spec.id,
  arm,
  unit: spec.unit,
  hash: unitId ? `${spec.id}:${spec.unit}:${unitId}` : null,
  ships: false,
  reason: "shadow-challenger",
});

/** The widest scope any `override`/`feature` feedback edge writes to. */
export const widestDirectFeedbackScope = (
  feedback: readonly { form: string; scope: Scope }[],
): Scope | null => {
  let widest: Scope | null = null;
  for (const edge of feedback) {
    if (edge.form !== "override" && edge.form !== "feature") continue;
    if (widest === null || scopeIndex(edge.scope) > scopeIndex(widest)) {
      widest = edge.scope;
    }
  }
  return widest;
};

/** Merge patches left to right. Later wins per key; `guards` concatenate. */
export const mergePatches = (
  patches: readonly ManifestPatch[],
): ManifestPatch => {
  const out: ManifestPatch = {};
  for (const p of patches) {
    if (p.thresholds) {
      out.thresholds = { ...out.thresholds };
      for (const [nodeId, values] of Object.entries(p.thresholds)) {
        out.thresholds[nodeId] = { ...out.thresholds[nodeId], ...values };
      }
    }
    if (p.prompts) out.prompts = { ...out.prompts, ...p.prompts };
    if (p.questions) out.questions = { ...out.questions, ...p.questions };
    if (p.routes) out.routes = { ...out.routes, ...p.routes };
    if (p.tools) out.tools = { ...out.tools, ...p.tools };
    if (p.guards) out.guards = [...(out.guards ?? []), ...p.guards];
  }
  return out;
};
