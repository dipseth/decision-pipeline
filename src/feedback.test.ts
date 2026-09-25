import { describe, expect, it } from "vitest";
import { submitFeedback, enqueueForHandRead, categoryValue, UnknownFeedbackEdgeError } from "./feedback";
import { testPorts } from "./testing";
import { buildScalePipeline, SCALE_LINE_LANE } from "./test-fixtures";
import { defineReviewLane, PIPELINE_HAND_READ_QUEUE } from "./review";
import type { FeedbackEdge } from "./types";

const scale = buildScalePipeline();

const withEdges = (edges: FeedbackEdge[]) => ({ ...scale, feedback: edges });

describe("a `score` edge", () => {
  it("writes the Langfuse score on the RUN'S TRACE and returns a label row", async () => {
    const ports = testPorts();
    const result = await submitFeedback(
      scale,
      { runId: "trace-abc", edgeId: "rating", value: 0.5, comment: "okay · ×2 · direct", sourceId: "u-1" },
      ports,
    );

    expect(ports.scoresWritten).toHaveLength(1);
    expect(ports.scoresWritten[0]).toMatchObject({
      runId: "trace-abc",
      name: "scale_feedback",
      value: 0.5,
      dataType: "NUMERIC",
      comment: "okay · ×2 · direct",
    });
    expect(result.scored).toBe(true);
    expect(result.label).toMatchObject({
      run_id: "trace-abc",
      kind: "score",
      value: 0.5,
      score_name: "scale_feedback",
      edge_id: "rating",
      scope: "user",
      rank: "human",
    });
  });

  it("keeps a categorical LABEL beside the number", async () => {
    const edge: FeedbackEdge = {
      id: "read", from: "surface:hand-read", to: "gate", source: "explicit",
      scope: "user", form: "score", latency: "deferred",
      score: {
        name: "pipeline_read", dataType: "CATEGORICAL",
        categories: [{ label: "p5", value: 0 }, { label: "meh", value: 1 }, { label: "ok", value: 2 }],
      },
    };
    const ports = testPorts();
    const result = await submitFeedback(
      withEdges([edge]),
      { runId: "t1", edgeId: "read", label: "meh", sourceId: "reviewer-1" },
      ports,
    );
    // Without the label a three-way config flattens to a number whose meaning
    // lives only in whichever config version was current.
    expect(result.label?.value).toBe(1);
    expect(result.label?.label).toBe("meh");
    expect(ports.scoresWritten[0]?.label).toBe("meh");
  });

  it("warns on a label the config does not have, rather than inventing a value", async () => {
    const edge: FeedbackEdge = {
      id: "read", from: "s", to: "gate", source: "explicit", scope: "user",
      form: "score", latency: "deferred",
      score: { name: "c", dataType: "CATEGORICAL", categories: [{ label: "ok", value: 1 }] },
    };
    const result = await submitFeedback(
      withEdges([edge]),
      { runId: "t1", edgeId: "read", label: "nonsense", sourceId: "s" },
      testPorts(),
    );
    expect(result.warnings.join()).toContain("not a category");
  });

  it("still returns the durable label when Langfuse is down", async () => {
    const ports = { ...testPorts(), scores: () => { throw new Error("langfuse 503"); } };
    const result = await submitFeedback(
      scale, { runId: "t1", edgeId: "rating", value: 1, sourceId: "u" }, ports,
    );
    expect(result.scored).toBe(false);
    expect(result.warnings.join()).toContain("langfuse 503");
    expect(result.label?.value).toBe(1);
  });
});

describe("a `queue` edge", () => {
  it("enqueues the run's trace into the LANE's physical queue", async () => {
    const ports = testPorts();
    const result = await submitFeedback(
      scale,
      { runId: "trace-xyz", edgeId: "flagged-lines", sourceId: "u-1", metadata: { line: 3 } },
      ports,
    );

    expect(ports.queueItems).toHaveLength(1);
    const item = ports.queueItems[0];
    // One shared queue; which pipeline and edge sent it rides on the item.
    expect(item?.queue).toBe("pipeline-review");
    expect(item?.lane).toBe(SCALE_LINE_LANE);
    expect(item?.pipeline).toBe("scale");
    expect(item?.edgeId).toBe("flagged-lines");
    expect(item?.runId).toBe("trace-xyz");
    expect(item?.metadata).toMatchObject({ fact: "scaled_recipe", node: "classify", line: 3 });
    // The lane's own score config is what a reviewer grades with.
    expect(item?.scoreConfig?.name).toBe("scale_line_verdict");
    expect(result.queued).toEqual({ queueId: "q-pipeline-review", itemId: "item-1" });
  });

  it("warns instead of silently enqueueing nowhere when the lane is unknown", async () => {
    const edge: FeedbackEdge = {
      id: "q", from: "s", to: "gate", source: "explicit", scope: "tenant",
      form: "queue", latency: "deferred", promoteVia: "never-registered",
    };
    const result = await submitFeedback(
      withEdges([edge]), { runId: "t1", edgeId: "q", sourceId: "s" }, testPorts(),
    );
    expect(result.queued).toBeNull();
    expect(result.warnings.join()).toContain("not registered");
  });
});

describe("an `override` edge", () => {
  const edge: FeedbackEdge = {
    id: "drag", from: "surface:list", to: "classify", source: "implicit",
    scope: "device", form: "override", latency: "immediate",
  };

  it("returns the row for the HOST to persist — the core owns no database", async () => {
    const result = await submitFeedback(
      withEdges([edge]),
      { runId: "t1", edgeId: "drag", key: "cilantro", payload: "produce", sourceId: "dev-9", arm: "b" },
      testPorts(),
    );
    expect(result.row).toMatchObject({
      key: "cilantro", scope: "device", rank: "human", value: "produce", arm: "b",
    });
  });

  it("labels the disagreement only when the human actually differed", async () => {
    const disagreed = await submitFeedback(
      withEdges([edge]),
      { runId: "t1", edgeId: "drag", key: "c", payload: "produce", modelValue: "spices", sourceId: "d" },
      testPorts(),
    );
    expect(disagreed.label).toMatchObject({ kind: "override_disagreement", value: 1 });

    const agreed = await submitFeedback(
      withEdges([edge]),
      { runId: "t1", edgeId: "drag", key: "c", payload: "produce", modelValue: "produce", sourceId: "d" },
      testPorts(),
    );
    expect(agreed.label?.value).toBe(0);
  });

  it("refuses a row at a scope the form x scope rule forbids", async () => {
    const wide: FeedbackEdge = { ...edge, scope: "tenant" };
    const result = await submitFeedback(
      withEdges([wide]),
      { runId: "t1", edgeId: "drag", key: "c", payload: "produce", sourceId: "d" },
      testPorts(),
    );
    expect(result.row).toBeNull();
    expect(result.warnings.join()).toContain("not allowed at scope");
  });

  it("needs a key", async () => {
    const result = await submitFeedback(
      withEdges([edge]), { runId: "t1", edgeId: "drag", payload: "x", sourceId: "d" }, testPorts(),
    );
    expect(result.row).toBeNull();
    expect(result.warnings.join()).toContain("needs a `key`");
  });
});

describe("a `feature` edge", () => {
  it("returns a row addressed to the node the edge lands on", async () => {
    const edge: FeedbackEdge = {
      id: "habit", from: "surface:list", to: "classify", source: "implicit",
      scope: "user", form: "feature", latency: "next-run",
    };
    const result = await submitFeedback(
      withEdges([edge]),
      { runId: "t1", edgeId: "habit", payload: "always halves salt", sourceId: "u-1" },
      testPorts(),
    );
    expect(result.row).toMatchObject({ nodeId: "classify", scope: "user", value: "always halves salt" });
  });
});

describe("misc", () => {
  it("throws on an edge the manifest never declared", async () => {
    await expect(
      submitFeedback(scale, { runId: "t1", edgeId: "ghost", sourceId: "s" }, testPorts()),
    ).rejects.toBeInstanceOf(UnknownFeedbackEdgeError);
  });

  it("warns when no scores port is wired rather than pretending it landed", async () => {
    const result = await submitFeedback(
      scale, { runId: "t1", edgeId: "rating", value: 1, sourceId: "u" }, {},
    );
    expect(result.scored).toBe(false);
    expect(result.warnings.join()).toContain("no `scores` port");
  });

  it("categoryValue resolves a label through its config", () => {
    const config = { name: "c", dataType: "CATEGORICAL" as const, categories: [{ label: "ok", value: 2 }] };
    expect(categoryValue(config, "ok")).toBe(2);
    expect(categoryValue(config, "nope")).toBeNull();
    expect(categoryValue(undefined, "ok")).toBeNull();
  });
});

describe("enqueueForHandRead", () => {
  it("uses the second shared queue, and is not a user promotion", async () => {
    const lane = defineReviewLane({ lane: "scale-hand-read", queue: PIPELINE_HAND_READ_QUEUE });
    const ports = testPorts();
    const queued = await enqueueForHandRead(
      scale, { runId: "t1", reason: "gate margin 0.02", lane }, ports,
    );
    expect(queued?.queueId).toBe("q-pipeline-hand-read");
    expect(ports.queueItems[0]?.edgeId).toBe("hand-read");
    expect(ports.queueItems[0]?.metadata).toMatchObject({ reason: "gate margin 0.02" });
  });

  it("is a no-op without a queue port or a registered lane", async () => {
    expect(await enqueueForHandRead(scale, { runId: "t1", reason: "r", lane: "ghost" }, testPorts())).toBeNull();
    expect(await enqueueForHandRead(scale, { runId: "t1", reason: "r", lane: "scale-hand-read" }, {})).toBeNull();
  });
});
