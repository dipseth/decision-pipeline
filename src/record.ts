/**
 * The run record — the training artifact. One schema for every pipeline, so
 * that three pipelines emitting it makes a shared model a training-script
 * change rather than an architecture change.
 *
 * `distributions` and `input_hash` are MANDATORY on every decide node: they
 * are what lets a threshold be re-tuned by offline replay with zero model
 * calls, and what makes the cheapest kind of experiment free.
 */

import type { ProbeRecord } from "./probes";
import type { NodeKind, Rank, Scope, Trigger } from "./types";

export interface RunRecordNode {
  id: string;
  kind: NodeKind;
  version: string;
  input_hash: string;
  ms: number;
  cost_usd: number;
  /**
   * `decide`/`generate` nodes that RAN: whether the port reported a cost at
   * all. `costUsd` is optional on both results, so "did not report" and
   * "reported zero" are different facts — and `cost_usd: 0` alone collapses
   * them. A regex fallback that genuinely spent nothing is `true, 0`; a port
   * that forgot to return `costUsd` is `false`, which is the one a cost meter
   * must not quietly add to a total (#325).
   *
   * Absent on every other node: a `code` node spending nothing is not a
   * measurement, it is arithmetic.
   */
  cost_reported?: boolean;
  /**
   * Present ONLY when the node's output came from `cache`. It cost nothing
   * because no port was called — which is a different reason for $0 than
   * "the port said $0", and the difference is most of the story when #324
   * starts resuming runs.
   */
  cached?: true;
  /** Present ONLY when the node did not run; the value is the reason. */
  skipped?: string;
  /** Gate nodes: the branch taken. */
  branch?: string;
  /**
   * Gate nodes: WHY that branch, when the body said so. Without it a record
   * says a run took `writer` but not that it was the cook's notes that sent it
   * there, which is the first thing a hand read wants to know.
   */
  branch_reason?: string;
  route?: string;
  /** decide nodes: the raw Jev output. The decide log. */
  distributions?: Record<string, number[]>;
  /**
   * decide nodes: the option keys behind each distribution, in the same order
   * as its numbers.
   *
   * NOT in the draft schema, added here deliberately: a bare `number[]` is
   * only replayable if the option ORDER is recoverable from the question
   * prompt version, and prompt versions move (#318). Recording the keys costs
   * a few bytes and is the difference between a replayable record and one that
   * silently mis-ranks after a prompt edit.
   */
  distribution_options?: Record<string, string[]>;
  /**
   * decide nodes with `probes`: the TEXT of every probe asked, what was
   * dropped and why, and which went unanswered. The probe distributions sit
   * in `distributions` under their slot keys; this is what makes them
   * replayable, since no prompt version recovers a probe's wording.
   */
  probes?: ProbeRecord;
  /** gate nodes: the values actually used, after env / prompt-config override. */
  thresholds?: Record<string, number>;
  /** generate nodes. */
  tools?: {
    offered: string[];
    selected: Record<string, number>;
    called: string[];
    dropped_for_scope: string[];
  };
  /** decide nodes that batch (cuisine sends <=12 recipes per request). */
  batch_trace_id?: string;
  /** Present when the node failed and its onFailure absorbed it. */
  error?: string;
}

export interface RunRecord {
  pipeline: string;
  /** Composite hash: node versions + prompt versions + thresholds + knowledge + ARMS. */
  version: string;
  /**
   * This ATTEMPT's id — the root trace id. A retry or a resume gets a new one,
   * because it is a new trace.
   */
  run_id: string;
  /**
   * The DURABLE identity of the work, stable across every attempt at it, from
   * the host (scale passes `scaleJobId`, already a content hash). Falls back to
   * `run_id` when the host has no stable key, which simply means "this attempt
   * is the only identity there is".
   *
   * The split is LangGraph's `thread_id` vs `checkpoint_id`, and it exists
   * because feedback outlives an attempt: a label written against attempt 1
   * must still resolve after a crash forced attempt 2, or the training join
   * silently drops every run that was ever retried.
   */
  run_key: string;
  /** The Langfuse grouping key. Renamed from `session` so it stops clashing with the `session` SCOPE. */
  group: string;
  tenant: string | null;
  user: string | null;
  trigger: Trigger;
  input_hash: string;
  cost_usd: number;
  ms: number;
  nodes: RunRecordNode[];
  /** Flattened and pipeline-agnostic: gate margins, entropies, item counts, lang, factor... */
  features: Record<string, number>;
  fact: string;
  fact_route: string;
  fact_confidence: number | null;
  /** Provenance both ways: which feature/override rows this run READ. */
  consumed_feedback_ids: string[];

  // --- experiments. Unbackfillable, so they land in the first migration step.
  /** experiment id -> arm. A MAP, so cross-pipeline interaction stays detectable. */
  arms: Record<string, string>;
  /** An arm rides down into sub-pipelines; this is the edge that attributes an outer label to an inner arm. */
  parent_run_id: string | null;
  /** The scope an arm was assigned at, and the hash of the id it was assigned from. */
  assignment_unit: Scope | null;
  assignment_hash: string | null;

  created_at: string;
}

export interface RunLabel {
  /** The attempt the signal was collected against — where the score lives. */
  run_id: string;
  /**
   * The durable run identity, when the host had one. THIS is what a training
   * join should key on; `run_id` only says which attempt the human was looking
   * at.
   */
  run_key?: string;
  kind: "score" | "override_disagreement" | "verify" | "implicit";
  value: number;
  /**
   * The CATEGORICAL label behind `value`, when there is one. Without it a
   * three-way config (`ok` / `meh` / `p5`) flattens to a number whose meaning
   * lives only in whichever version of the score config was current.
   */
  label?: string;
  /** The Langfuse score name, so a label row joins back to the score. */
  score_name?: string;
  /** The feedback edge that produced this label. */
  edge_id?: string;
  scope: Scope;
  rank: Rank;
  source_id: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Gate metrics — named extractors, not ad-hoc queries
// ---------------------------------------------------------------------------

/**
 * `eval.gateMetric` names one of these. The point of a registry rather than a
 * query string: the offline eval and an online split then compute the SAME
 * number, so a disagreement is the change under test and not the metric.
 *
 * Returns null when the run cannot contribute to the metric (no label yet,
 * gate skipped) — a null is dropped from the aggregate, never counted as 0.
 */
export type GateMetric = (
  record: RunRecord,
  labels: readonly RunLabel[],
) => number | null;

const METRICS = new Map<string, GateMetric>();

export const defineGateMetric = (name: string, fn: GateMetric): string => {
  const existing = METRICS.get(name);
  if (existing && existing !== fn) {
    throw new Error(`Gate metric "${name}" is already defined with a different body.`);
  }
  METRICS.set(name, fn);
  return name;
};

export const getGateMetric = (name: string): GateMetric | undefined =>
  METRICS.get(name);

export const hasGateMetric = (name: string): boolean => METRICS.has(name);

export const gateMetricNames = (): string[] => [...METRICS.keys()].sort();

/** Test seam — the registry is process-global, so a suite has to be able to reset it. */
export const clearGateMetrics = (): void => METRICS.clear();

export const aggregateGateMetric = (
  name: string,
  rows: readonly { record: RunRecord; labels: readonly RunLabel[] }[],
): { name: string; n: number; mean: number | null } => {
  const fn = METRICS.get(name);
  if (!fn) throw new Error(`Unknown gate metric "${name}".`);
  const values: number[] = [];
  for (const row of rows) {
    const v = fn(row.record, row.labels);
    if (v !== null && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return { name, n: 0, mean: null };
  return { name, n: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length };
};

// ---------------------------------------------------------------------------
// Two metrics every pipeline can use, so `eval.gateMetric` is never a stub
// ---------------------------------------------------------------------------

/** Share of runs whose explicit score label was positive. */
export const GATE_METRIC_SCORE_POSITIVE = defineGateMetric(
  "score_positive",
  (_record, labels) => {
    const scores = labels.filter((l) => l.kind === "score");
    if (scores.length === 0) return null;
    // Strongest rank wins; admin over human over llm, as everywhere else.
    return scores.some((l) => l.value > 0) ? 1 : 0;
  },
);

/** Share of runs a human did NOT have to correct. */
export const GATE_METRIC_NO_DISAGREEMENT = defineGateMetric(
  "no_override_disagreement",
  (_record, labels) => {
    const seen = labels.filter((l) => l.kind === "override_disagreement");
    if (seen.length === 0) return null;
    return seen.some((l) => l.value !== 0) ? 0 : 1;
  },
);
