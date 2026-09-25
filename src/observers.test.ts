/**
 * The observer contract (#325) — what a watcher is promised, and what it is
 * NOT allowed to do to the run it is watching.
 */

import { describe, expect, it } from "vitest";
import { runPipeline } from "./run";
import { MissingPortError, NodeFailedError } from "./errors";
import { collectingObserver, testPorts, throwingObserver } from "./testing";
import type { RunObserver } from "./observers";
import {
  buildScalePipeline,
  confidentDistributions,
  unsureDistributions,
  type ScaledRecipeT,
  type ScaleInputT,
} from "./test-fixtures";

const input: ScaleInputT = {
  recipeId: "r-1",
  factor: 2,
  notes: "",
  substitutionCount: 0,
  ingredients: ["1 cup flour", "1 tsp salt"],
};

const writerOutput: ScaledRecipeT = {
  scaledIngredients: ["2 cup flour", "2 tsp salt"],
  scalingNotes: ["the writer's prose"],
  factor: 2,
  changes: [],
};

const directPorts = () =>
  testPorts({
    decide: { classify: { distributions: confidentDistributions(2), costUsd: 0.0002 } },
    prompts: { "jev-scale-classify": { version: "12" } },
    scope: { ids: { user: "u-1", tenant: "t-1" } },
  });

const writerPorts = () =>
  testPorts({
    decide: { classify: { distributions: unsureDistributions(2), costUsd: 0.0002 } },
    generate: { writer: { value: writerOutput, costUsd: 0.004 } },
    prompts: {
      "jev-scale-classify": { version: "12" },
      "recipe-scale": { version: "7" },
    },
    scope: { ids: { user: "u-1", tenant: "t-1" } },
  });

describe("the event stream", () => {
  it("brackets the run: one start, one end, and node events in between", async () => {
    const ports = directPorts();
    await runPipeline(buildScalePipeline(), input, ports);

    const stream = ports.observed.map((e) => e.hook);
    expect(stream[0]).toBe("onRunStart");
    expect(stream[stream.length - 1]).toBe("onRunEnd");
    expect(stream.filter((h) => h === "onRunStart")).toHaveLength(1);
    expect(stream.filter((h) => h === "onRunEnd")).toHaveLength(1);
  });

  it("pairs every node the runtime considered — SKIPS included", async () => {
    const ports = directPorts();
    const result = await runPipeline(buildScalePipeline(), input, ports);

    // The direct branch leaves `writer` and `guard` unrun; a watcher that
    // pairs start/end must still see both halves or it cannot tell a skipped
    // node from a node it simply missed.
    expect(Object.keys(result.skipped).sort()).toEqual(["guard", "writer"]);

    for (const id of Object.keys(buildScalePipeline().nodes)) {
      const starts = ports.observed.filter(
        (e) => e.hook === "onNodeStart" && e.event.nodeId === id,
      );
      const ends = ports.observed.filter(
        (e) => e.hook === "onNodeEnd" && e.event.nodeId === id,
      );
      expect([id, starts.length, ends.length]).toEqual([id, 1, 1]);
    }

    const writerEnd = ports.observed.find(
      (e) => e.hook === "onNodeEnd" && e.event.nodeId === "writer",
    );
    expect(writerEnd?.hook === "onNodeEnd" && writerEnd.event.skipped).toContain(
      'gate took "direct"',
    );
  });

  it("names the same run the record will, before a single node has run", async () => {
    const ports = testPorts({
      ...{
        decide: { classify: { distributions: confidentDistributions(2) } },
        prompts: { "jev-scale-classify": { version: "12" } },
      },
      traceId: "trace-abc",
    });
    const result = await runPipeline(buildScalePipeline(), input, ports, {
      runKey: "job-99",
    });

    const start = ports.observed[0];
    expect(start?.hook).toBe("onRunStart");
    if (start?.hook !== "onRunStart") throw new Error("unreachable");
    // The run id used to be knowable only at the end, because `run_key` was
    // resolved beside the record. A cost meter opening a bucket at run start
    // needs it here.
    expect(start.event.runId).toBe("trace-abc");
    expect(start.event.runKey).toBe("job-99");
    expect(start.event.runKey).toBe(result.record.run_key);
    expect(start.event.version).toBe(result.version);
  });

  it("carries each node's cost and the gate's branch", async () => {
    const ports = writerPorts();
    await runPipeline(buildScalePipeline(), input, ports);

    const ends = ports.observed.filter((e) => e.hook === "onNodeEnd");
    const cost = ends.reduce(
      (sum, e) => sum + (e.hook === "onNodeEnd" ? e.event.costUsd : 0),
      0,
    );
    expect(cost).toBeCloseTo(0.0042, 6);

    const gate = ends.find((e) => e.hook === "onNodeEnd" && e.event.nodeId === "gate");
    expect(gate?.hook === "onNodeEnd" && gate.event.branch).toBe("writer");
  });

  it("hands onRunEnd the record, the output and the route", async () => {
    const ports = directPorts();
    const result = await runPipeline(buildScalePipeline(), input, ports);

    const end = ports.observed[ports.observed.length - 1];
    if (end?.hook !== "onRunEnd") throw new Error("expected onRunEnd last");
    expect(end.event.route).toBe("direct");
    expect(end.event.record).toBe(result.record);
    expect(end.event.output).toEqual(result.output);
    expect(end.event.writesFact).toBe(true);
  });
});

describe("best-effort, by contract", () => {
  it("a watcher that throws on every hook does not fail the run", async () => {
    const ports = { ...directPorts(), observers: [throwingObserver()] };
    const result = await runPipeline(buildScalePipeline(), input, ports);

    expect(result.route).toBe("direct");
    expect(result.output.scaledIngredients).toHaveLength(2);
  });

  it("one thrower does not rob the watchers behind it", async () => {
    const watcher = collectingObserver("after");
    const ports = {
      ...directPorts(),
      observers: [throwingObserver(), watcher.observer],
    };
    await runPipeline(buildScalePipeline(), input, ports);

    expect(watcher.stream()).toContain("onRunStart");
    expect(watcher.stream()).toContain("onRunEnd");
  });

  it("a record sink that throws no longer fails a run that already answered", async () => {
    const ports = {
      ...directPorts(),
      records: () => {
        throw new Error("training table is down");
      },
    };
    // Used to propagate: the answer was computed, then thrown away on the way
    // to a sink nothing downstream reads.
    const result = await runPipeline(buildScalePipeline(), input, ports);
    expect(result.route).toBe("direct");
  });
});

describe("`records` is the first watcher, not a separate path", () => {
  it("still receives the record, before the observers behind it", async () => {
    const seen: string[] = [];
    const ports = {
      ...directPorts(),
      records: () => {
        seen.push("records");
      },
      observers: [
        { name: "after", onRunEnd: () => void seen.push("observer") } as RunObserver,
      ],
    };
    const result = await runPipeline(buildScalePipeline(), input, ports);

    expect(seen).toEqual(["records", "observer"]);
    expect(result.record.run_id).toBeTruthy();
  });

  it("notifies in registration order", async () => {
    const order: string[] = [];
    const mark = (name: string): RunObserver => ({
      name,
      onRunEnd: () => void order.push(name),
    });
    const ports = { ...directPorts(), observers: [mark("a"), mark("b"), mark("c")] };
    await runPipeline(buildScalePipeline(), input, ports);

    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("a failed run", () => {
  it("ends the node that killed it, then reports the failure as before", async () => {
    const ports = writerPorts();
    const scale = buildScalePipeline();
    // `changes` has no onFailure, so it defaults to "fail" — the run throws.
    const exploding = {
      ...scale,
      nodes: {
        ...scale.nodes,
        changes: {
          ...scale.nodes.changes,
          run: () => {
            throw new Error("changes blew up");
          },
        },
      },
    } as typeof scale;

    await expect(runPipeline(exploding, input, ports)).rejects.toThrow(NodeFailedError);

    const end = ports.observed.find(
      (e) => e.hook === "onNodeEnd" && e.event.nodeId === "changes",
    );
    expect(end?.hook === "onNodeEnd" && end.event.error).toContain("changes blew up");
    // Documented limit: a run with no record has no `onRunEnd` to give.
    expect(ports.observed.some((e) => e.hook === "onRunEnd")).toBe(false);
  });

  it("pairs the node even when a MISSING PORT kills the run", async () => {
    // The one path that rethrows without consulting `onFailure`. It still owes
    // the node an end event, or the pairing guarantee is only mostly true.
    const ports = testPorts({
      prompts: { "jev-scale-classify": { version: "12" } },
    });
    delete (ports as { decide?: unknown }).decide;

    await expect(runPipeline(buildScalePipeline(), input, ports)).rejects.toThrow(
      MissingPortError,
    );

    expect(ports.observed.map((e) => e.hook)).toEqual([
      "onRunStart",
      "onNodeStart",
      "onNodeEnd",
    ]);
    const end = ports.observed[2];
    expect(end?.hook === "onNodeEnd" && end.event.nodeId).toBe("classify");
    expect(end?.hook === "onNodeEnd" && end.event.error).toContain("decide");
  });
});
