/**
 * Annotation queues and score configs — the scarce half of the Langfuse model.
 *
 * A Langfuse **annotation queue is capped per project** (3 on the Core plan,
 * both projects). Five bespoke queue names are already declared across
 * recipes-core, and three of those modules carry a `catch` that logs "no
 * annotation queue (plan cap or API error)" and proceeds WITHOUT one — which
 * is the worst outcome available: the contract promises the signal a landing
 * spot and it silently has none.
 *
 * So a feedback edge's `promoteVia` names a **lane**, not a queue. Lanes are
 * unlimited; they resolve to one of a small number of registered physical
 * queues, and carry their own **score config** (configs are NOT capped, so
 * per-lane categories cost nothing). Exceeding the physical budget is a
 * manifest-load error here, not a runtime warning in production.
 *
 * Nothing in this file talks to Langfuse. It is the registry the manifest
 * validates against; `QueuePort` is what actually writes.
 */

/** Langfuse Core plan, per project. Raising this is a billing decision, not a code one. */
export const REVIEW_QUEUE_BUDGET = 3;

import type { ScoreConfigSpec } from "./types";

export type { ScoreConfigSpec };

export interface ReviewQueueSpec {
  /** The Langfuse queue name. One of at most REVIEW_QUEUE_BUDGET per project. */
  name: string;
  description: string;
}

export interface ReviewLaneSpec {
  /** What a manifest's `promoteVia` names. */
  lane: string;
  /** The physical queue it lands in. Must be registered. */
  queue: string;
  /** The score config a reviewer grades the item with. */
  scoreConfig?: ScoreConfigSpec;
  description?: string;
}

const QUEUES = new Map<string, ReviewQueueSpec>();
const LANES = new Map<string, ReviewLaneSpec>();

export class ReviewBudgetError extends Error {
  constructor(name: string, budget: number, existing: string[]) {
    super(
      `Cannot register annotation queue "${name}": the budget of ${budget} per Langfuse project is already spent on [${existing.join(", ")}]. Add a LANE on an existing queue instead — lanes are free, queues are not.`,
    );
    this.name = "ReviewBudgetError";
  }
}

export const defineReviewQueue = (spec: ReviewQueueSpec): string => {
  const existing = QUEUES.get(spec.name);
  if (existing) return spec.name;
  if (QUEUES.size >= REVIEW_QUEUE_BUDGET) {
    throw new ReviewBudgetError(spec.name, REVIEW_QUEUE_BUDGET, [...QUEUES.keys()]);
  }
  QUEUES.set(spec.name, spec);
  return spec.name;
};

export const defineReviewLane = (spec: ReviewLaneSpec): string => {
  if (!QUEUES.has(spec.queue)) {
    throw new Error(
      `Lane "${spec.lane}" points at unregistered queue "${spec.queue}" (registered: ${[...QUEUES.keys()].join(", ") || "none"}).`,
    );
  }
  const existing = LANES.get(spec.lane);
  if (existing && existing.queue !== spec.queue) {
    throw new Error(
      `Lane "${spec.lane}" is already registered on queue "${existing.queue}"; refusing to move it to "${spec.queue}".`,
    );
  }
  LANES.set(spec.lane, spec);
  return spec.lane;
};

export const resolveLane = (lane: string): ReviewLaneSpec | undefined => LANES.get(lane);
export const hasLane = (lane: string): boolean => LANES.has(lane);
export const laneNames = (): string[] => [...LANES.keys()].sort();
export const reviewQueues = (): ReviewQueueSpec[] => [...QUEUES.values()];

/** Test seam — both registries are process-global. */
export const clearReviewRegistry = (): void => {
  QUEUES.clear();
  LANES.clear();
};

export interface ReviewRegistrySnapshot {
  queues: ReviewQueueSpec[];
  lanes: ReviewLaneSpec[];
}

/**
 * Save/restore rather than clear: the package registers the two shared queues
 * at import, so a test that clears would break every later test in the file.
 */
export const snapshotReviewRegistry = (): ReviewRegistrySnapshot => ({
  queues: [...QUEUES.values()],
  lanes: [...LANES.values()],
});

export const restoreReviewRegistry = (snapshot: ReviewRegistrySnapshot): void => {
  QUEUES.clear();
  LANES.clear();
  for (const q of snapshot.queues) QUEUES.set(q.name, q);
  for (const l of snapshot.lanes) LANES.set(l.lane, l);
};

// ---------------------------------------------------------------------------
// The two queues every pipeline shares
// ---------------------------------------------------------------------------

/**
 * Every `queue`- and `derived`-form promotion across every pipeline. The item
 * is the run's TRACE, and which pipeline and which feedback edge sent it ride
 * in the item's metadata — that is what a lane buys over a queue per pipeline.
 */
export const PIPELINE_REVIEW_QUEUE = defineReviewQueue({
  name: "pipeline-review",
  description:
    "Decision-pipeline promotions (#321). One item = one pipeline run's trace. The item's metadata names the pipeline, the feedback edge and the lane; grade it with the lane's score config. A `derived` lane is proposing a CHANGE TO THE PIPELINE (a new Jev question, a taxonomy slug, a threshold) — promoting it edits structure, so read the proposal, not just the run.",
});

/**
 * Runs pulled for a hand read rather than promoted by a user — the gate
 * student's flagging surface (#276-style) and the #293 read.
 */
export const PIPELINE_HAND_READ_QUEUE = defineReviewQueue({
  name: "pipeline-hand-read",
  description:
    "Decision-pipeline hand reads (#321). Sampled or gate-student-flagged runs, not user promotions. One item = one run's trace: read the node spans top to bottom, then grade whether the BRANCH the gate took was right — the pipeline's own answer is persisted separately from any human override, so a corrected run is still scorable.",
});

/** The third queue is deliberately left for the host to spend. */
