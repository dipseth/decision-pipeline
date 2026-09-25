/**
 * Submitting a human signal — the producer `RunLabel` was missing.
 *
 * Before this, a manifest could declare `form: "score"` and `promoteVia` and
 * nothing in the package could land either, so the contract's promise ("every
 * human signal has a declared landing spot") was only half true: the
 * declaration existed, the landing did not.
 *
 * One entry point, `submitFeedback`, so every surface — a 👍/👎, a rating, an
 * aisle drag, a review promotion — goes through the same rules:
 *
 *   - a `score` edge writes a Langfuse score on the RUN'S TRACE and a label row;
 *   - a `queue` / `derived` edge puts the run's trace in the lane's physical
 *     queue, and writes a score too when the edge declares one — a score is
 *     not state, so the two are never alternatives;
 *   - an `override` / `feature` edge returns the ROW for the host to persist
 *     (the core never owns a database), and an override that disagrees with
 *     the pipeline's own answer emits the disagreement label that makes the
 *     disagreement set a training set.
 *
 * Langfuse is reached only through ports, and every port call is best-effort:
 * Langfuse being down must never lose the durable row.
 */

import type { DecisionPipeline } from "./define";
import type { PipelinePorts, QueueResult } from "./ports";
import type { RunLabel } from "./record";
import { resolveLane } from "./review";
import {
  DIRECT_FORM_MAX_SCOPE,
  scopeAtMost,
  type FeatureRow,
  type FeedbackEdge,
  type OverrideRow,
  type Rank,
  type ScoreConfigSpec,
} from "./types";

export interface FeedbackSubmission {
  /** The run's trace id — what the score and the queue item attach to. */
  runId: string;
  /**
   * The run's DURABLE key (`RunRecord.run_key`), when the caller has it. The
   * score still lands on the trace, because that is the only thing Langfuse can
   * score; this is what makes the durable label row survive a retry.
   */
  runKey?: string;
  /** Which declared feedback edge fired. */
  edgeId: string;
  /** Numeric value. Optional when `label` names a category of the edge's config. */
  value?: number;
  /** CATEGORICAL label; resolves to a value through the edge's score config. */
  label?: string;
  /** What a hand read sees next to the number. */
  comment?: string;
  /** A property of the WRITER. Default `human` — a person is submitting this. */
  rank?: Rank;
  /** The surface, row or person this came from. */
  sourceId: string;
  userId?: string | null;
  /** `override` / `feature` forms: what to bind, and to what key. */
  key?: string;
  /** `override` / `feature` forms: the value to persist. */
  payload?: unknown;
  /** `override` form: the pipeline's OWN answer, so a disagreement can be labelled. */
  modelValue?: unknown;
  /** Target node for a `feature` row. Defaults to the edge's `to`. */
  nodeId?: string;
  /** Extra metadata for a queue item. */
  metadata?: Record<string, unknown>;
  /** The arm this was written under — belt and braces on the assignment-unit rule. */
  arm?: string | null;
}

export interface FeedbackResult {
  edge: FeedbackEdge;
  /** The label row to persist and later join to the run record. */
  label: RunLabel | null;
  /** The durable row the HOST persists. The core never owns a database. */
  row: FeatureRow | OverrideRow | null;
  queued: QueueResult | null;
  scored: boolean;
  /** Anything refused or degraded — never thrown, so a row is never lost. */
  warnings: string[];
}

export class UnknownFeedbackEdgeError extends Error {
  constructor(pipeline: string, edgeId: string, known: string[]) {
    super(
      `Pipeline "${pipeline}" has no feedback edge "${edgeId}" (has: ${known.join(", ") || "none"}).`,
    );
    this.name = "UnknownFeedbackEdgeError";
  }
}

/** A category's number, or null when the label is not one of them. */
export const categoryValue = (
  config: ScoreConfigSpec | undefined,
  label: string | undefined,
): number | null => {
  if (!config?.categories || label === undefined) return null;
  const hit = config.categories.find((c) => c.label === label);
  return hit ? hit.value : null;
};

const nowIso = (clock?: () => number): string =>
  new Date(clock ? clock() : Date.now()).toISOString();

export const submitFeedback = async <I, O>(
  pipeline: DecisionPipeline<I, O>,
  submission: FeedbackSubmission,
  ports: PipelinePorts = {},
): Promise<FeedbackResult> => {
  const edge = pipeline.feedback.find((f) => f.id === submission.edgeId);
  if (!edge) {
    throw new UnknownFeedbackEdgeError(
      pipeline.id,
      submission.edgeId,
      pipeline.feedback.map((f) => f.id),
    );
  }

  const warnings: string[] = [];
  const rank: Rank = submission.rank ?? "human";
  const created_at = nowIso(ports.clock);

  // --- resolve the number, from a category label when that is what came in
  const fromLabel = categoryValue(edge.score, submission.label);
  if (submission.label !== undefined && fromLabel === null && edge.score?.categories) {
    warnings.push(
      `label "${submission.label}" is not a category of score config "${edge.score.name}"`,
    );
  }
  const value = submission.value ?? fromLabel ?? 0;

  const result: FeedbackResult = {
    edge,
    label: null,
    row: null,
    queued: null,
    scored: false,
    warnings,
  };

  // --- the Langfuse score. Any form may carry one; `score` form must.
  const writeScore = async (kind: RunLabel["kind"]): Promise<void> => {
    if (!edge.score) return;
    if (!ports.scores) {
      warnings.push("no `scores` port supplied — the Langfuse score was not written");
    } else {
      try {
        await ports.scores({
          runId: submission.runId,
          name: edge.score.name,
          value,
          label: submission.label,
          dataType: edge.score.dataType,
          comment: submission.comment,
          config: edge.score,
          userId: submission.userId,
        });
        result.scored = true;
      } catch (err) {
        warnings.push(
          `score write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    result.label = {
      run_id: submission.runId,
      ...(submission.runKey ? { run_key: submission.runKey } : {}),
      kind,
      value,
      label: submission.label,
      score_name: edge.score.name,
      edge_id: edge.id,
      scope: edge.scope,
      rank,
      source_id: submission.sourceId,
      created_at,
    };
  };

  switch (edge.form) {
    case "score": {
      if (!edge.score) {
        // definePipeline refuses this, so it means a hand-built manifest.
        warnings.push(`edge "${edge.id}" is form "score" but declares no score config`);
        break;
      }
      await writeScore("score");
      break;
    }

    case "queue":
    case "derived": {
      const lane = edge.promoteVia ? resolveLane(edge.promoteVia) : undefined;
      if (!lane) {
        warnings.push(
          `lane "${edge.promoteVia ?? "(none)"}" is not registered — nothing was enqueued`,
        );
      } else if (!ports.queue) {
        warnings.push("no `queue` port supplied — nothing was enqueued");
      } else {
        try {
          result.queued =
            (await ports.queue({
              runId: submission.runId,
              queue: lane.queue,
              lane: lane.lane,
              pipeline: pipeline.id,
              edgeId: edge.id,
              form: edge.form,
              scoreConfig: lane.scoreConfig ?? edge.score,
              metadata: {
                fact: pipeline.fact,
                node: edge.to,
                source: edge.source,
                scope: edge.scope,
                arm: submission.arm ?? null,
                ...submission.metadata,
              },
            })) ?? null;
        } catch (err) {
          warnings.push(
            `enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // A score is not state: an edge that also carries one writes it too.
      await writeScore("implicit");
      break;
    }

    case "override":
    case "feature": {
      // The form x scope rule, enforced on WRITE as well as on read.
      if (!scopeAtMost(edge.scope, DIRECT_FORM_MAX_SCOPE)) {
        warnings.push(
          `form "${edge.form}" is not allowed at scope "${edge.scope}" — no row was produced`,
        );
        break;
      }
      const id = `${pipeline.id}:${edge.id}:${submission.sourceId}`;
      if (edge.form === "override") {
        if (submission.key === undefined) {
          warnings.push("an override row needs a `key` — no row was produced");
          break;
        }
        result.row = {
          id,
          key: submission.key,
          scope: edge.scope,
          rank,
          value: submission.payload,
          arm: submission.arm ?? null,
          createdAt: created_at,
        } satisfies OverrideRow;
        // The override IS the disagreement, and the disagreement set is the
        // labeled training set — but only when the human actually differed.
        if (submission.modelValue !== undefined) {
          const disagreed = submission.payload !== submission.modelValue;
          result.label = {
            run_id: submission.runId,
            ...(submission.runKey ? { run_key: submission.runKey } : {}),
            kind: "override_disagreement",
            value: disagreed ? 1 : 0,
            edge_id: edge.id,
            scope: edge.scope,
            rank,
            source_id: submission.sourceId,
            created_at,
          };
        }
      } else {
        result.row = {
          id,
          nodeId: submission.nodeId ?? edge.to,
          scope: edge.scope,
          rank,
          value: submission.payload,
          arm: submission.arm ?? null,
          createdAt: created_at,
        } satisfies FeatureRow;
      }
      if (edge.score) await writeScore(edge.source === "implicit" ? "implicit" : "score");
      break;
    }
  }

  return result;
};

/**
 * Pull a run into the hand-read queue — the other half of the two shared
 * queues. Not a user promotion: this is sampling, or a gate student flagging a
 * run whose branch it does not believe.
 */
export const enqueueForHandRead = async <I, O>(
  pipeline: DecisionPipeline<I, O>,
  args: {
    runId: string;
    reason: string;
    lane: string;
    metadata?: Record<string, unknown>;
  },
  ports: PipelinePorts = {},
): Promise<QueueResult | null> => {
  const lane = resolveLane(args.lane);
  if (!lane || !ports.queue) return null;
  return (
    (await ports.queue({
      runId: args.runId,
      queue: lane.queue,
      lane: lane.lane,
      pipeline: pipeline.id,
      edgeId: "hand-read",
      form: "queue",
      scoreConfig: lane.scoreConfig,
      metadata: { fact: pipeline.fact, reason: args.reason, ...args.metadata },
    })) ?? null
  );
};
