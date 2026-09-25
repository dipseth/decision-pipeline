import { afterEach, describe, expect, it } from "vitest";
import {
  defineReviewLane,
  defineReviewQueue,
  hasLane,
  laneNames,
  resolveLane,
  restoreReviewRegistry,
  reviewQueues,
  ReviewBudgetError,
  REVIEW_QUEUE_BUDGET,
  snapshotReviewRegistry,
  PIPELINE_HAND_READ_QUEUE,
  PIPELINE_REVIEW_QUEUE,
} from "./review";

const snapshot = snapshotReviewRegistry();
afterEach(() => restoreReviewRegistry(snapshot));

describe("the queue budget", () => {
  it("ships two shared queues and leaves one for the host", () => {
    expect(reviewQueues().map((q) => q.name)).toEqual([
      PIPELINE_REVIEW_QUEUE,
      PIPELINE_HAND_READ_QUEUE,
    ]);
    expect(REVIEW_QUEUE_BUDGET - reviewQueues().length).toBe(1);
  });

  it("allows the host to spend the third", () => {
    expect(() => defineReviewQueue({ name: "third", description: "the host's" })).not.toThrow();
  });

  it("refuses a fourth, naming what the budget is spent on", () => {
    defineReviewQueue({ name: "third", description: "the host's" });
    // Today this fails at RUNTIME with a console.warn and nothing enqueued, in
    // three separate recipes-core modules. A load error is the point.
    expect(() => defineReviewQueue({ name: "fourth", description: "one too many" })).toThrow(
      ReviewBudgetError,
    );
    try {
      defineReviewQueue({ name: "fourth", description: "one too many" });
    } catch (err) {
      expect((err as Error).message).toContain("pipeline-review");
      expect((err as Error).message).toContain("Add a LANE");
    }
  });

  it("registering the same queue twice is a no-op, not a budget spend", () => {
    defineReviewQueue({ name: PIPELINE_REVIEW_QUEUE, description: "again" });
    expect(reviewQueues()).toHaveLength(2);
  });
});

describe("lanes", () => {
  it("are unlimited — many lanes ride on one queue", () => {
    for (let i = 0; i < 20; i += 1) {
      defineReviewLane({ lane: `lane-${i}`, queue: PIPELINE_REVIEW_QUEUE });
    }
    expect(laneNames()).toHaveLength(20);
    expect(reviewQueues()).toHaveLength(2);
  });

  it("carry their own score config, which Langfuse does NOT cap", () => {
    defineReviewLane({
      lane: "aisle-drag",
      queue: PIPELINE_REVIEW_QUEUE,
      scoreConfig: {
        name: "aisle_verdict",
        dataType: "CATEGORICAL",
        categories: [{ label: "wrong", value: 0 }, { label: "right", value: 1 }],
      },
    });
    expect(resolveLane("aisle-drag")?.scoreConfig?.name).toBe("aisle_verdict");
    expect(resolveLane("aisle-drag")?.queue).toBe(PIPELINE_REVIEW_QUEUE);
  });

  it("refuse an unregistered queue", () => {
    expect(() => defineReviewLane({ lane: "x", queue: "no-such-queue" })).toThrow(
      /unregistered queue/,
    );
  });

  it("refuse to be moved to a different queue once registered", () => {
    defineReviewLane({ lane: "x", queue: PIPELINE_REVIEW_QUEUE });
    expect(() => defineReviewLane({ lane: "x", queue: PIPELINE_HAND_READ_QUEUE })).toThrow(
      /refusing to move it/,
    );
    expect(() => defineReviewLane({ lane: "x", queue: PIPELINE_REVIEW_QUEUE })).not.toThrow();
  });

  it("reports whether a lane exists, which is what the manifest validates", () => {
    expect(hasLane("nope")).toBe(false);
    defineReviewLane({ lane: "nope", queue: PIPELINE_REVIEW_QUEUE });
    expect(hasLane("nope")).toBe(true);
  });
});
