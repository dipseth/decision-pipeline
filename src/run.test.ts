import { describe, expect, it } from "vitest";
import { runPipeline, applyOverride } from "./run";
import { MissingPortError, NodeFailedError } from "./errors";
import { buildScopeContext } from "./scope";
import { testPorts } from "./testing";
import {
  buildScalePipeline,
  confidentDistributions,
  unsureDistributions,
  type ScaledRecipeT,
  type ScaleInputT,
} from "./test-fixtures";
import type { ExperimentSpec } from "./experiments";

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

const directPortsInput = {
  decide: { classify: { distributions: confidentDistributions(2), costUsd: 0.0002 } },
  prompts: { "jev-scale-classify": { version: "12" } },
  scope: { ids: { user: "u-1", tenant: "t-1" }, grants: ["recipes:read"] },
};

const directPorts = () => testPorts(directPortsInput);

const writerPorts = (over: Parameters<typeof testPorts>[0] = {}) =>
  testPorts({
    decide: {
      classify: {
        distributions: {
          ...unsureDistributions(2),
          "tool:lookup_pan_conversion": [0.81],
          "tool:lookup_cooking_adjustment": [0.12],
        },
        costUsd: 0.0002,
      },
    },
    generate: { writer: { value: writerOutput, costUsd: 0.004, toolsCalled: ["lookup_pan_conversion"] } },
    prompts: {
      "jev-scale-classify": { version: "12" },
      "recipe-scale": { version: "7", tools: ["lookup_scaling_rule"] },
    },
    registry: {
      lookup_pan_conversion: "recipes:read",
      lookup_cooking_adjustment: "cook:assist",
      lookup_scaling_rule: null,
    },
    scope: { ids: { user: "u-1", tenant: "t-1" }, grants: ["recipes:read"] },
    ...over,
  });

describe("the direct branch", () => {
  it("routes past the writer and never calls it", async () => {
    const scale = buildScalePipeline();
    const ports = directPorts();
    const result = await runPipeline(scale, input, ports);

    expect(result.route).toBe("direct");
    expect(ports.generateCalls).toHaveLength(0);
    expect(result.output.scaledIngredients).toEqual(["2x 1 cup flour", "2x 1 tsp salt"]);
    expect(result.output.changes).toHaveLength(2);
  });

  it("records the skipped nodes WITH a reason — never missing", async () => {
    const result = await runPipeline(buildScalePipeline(), input, directPorts());

    expect(Object.keys(result.skipped).sort()).toEqual(["guard", "writer"]);
    expect(result.skipped.writer).toContain('gate took "direct", needed "writer"');
    expect(result.skipped.guard).toContain("writer skipped");

    const ids = result.record.nodes.map((n) => n.id);
    expect(ids).toContain("writer");
    expect(result.record.nodes.find((n) => n.id === "writer")?.skipped).toBeTruthy();
  });
});

describe("the writer branch", () => {
  it("runs writer -> guard -> changes when the gate is not confident", async () => {
    const ports = writerPorts();
    const result = await runPipeline(buildScalePipeline(), input, ports);

    expect(result.route).toBe("writer");
    expect(ports.generateCalls).toHaveLength(1);
    expect(result.skipped).toEqual({ direct: expect.stringContaining("needed \"direct\"") });
    expect(result.output.scalingNotes).toEqual(["the writer's prose"]);
  });

  it("offers static UNION Jev-selected tools, and drops what the grant does not cover", async () => {
    const ports = writerPorts();
    await runPipeline(buildScalePipeline(), input, ports);

    const offered = ports.generateCalls[0]?.tools;
    // static comes from the prompt config; lookup_pan_conversion was selected at 0.81.
    expect(offered?.offered).toEqual(["lookup_scaling_rule", "lookup_pan_conversion"]);
    expect(offered?.selected).toEqual({ lookup_pan_conversion: 0.81 });
    // lookup_cooking_adjustment lost on its Noul (0.12), not on scope.
    expect(offered?.dropped_for_scope).toEqual([]);
  });

  it("drops a selected tool the run's MCP grant does not cover, and records it", async () => {
    const ports = writerPorts({
      decide: {
        classify: {
          distributions: {
            ...unsureDistributions(2),
            "tool:lookup_pan_conversion": [0.81],
            "tool:lookup_cooking_adjustment": [0.93],
          },
        },
      },
    });
    const result = await runPipeline(buildScalePipeline(), input, ports);

    expect(ports.generateCalls[0]?.tools.dropped_for_scope).toEqual(["lookup_cooking_adjustment"]);
    const writerNode = result.record.nodes.find((n) => n.id === "writer");
    expect(writerNode?.tools?.dropped_for_scope).toEqual(["lookup_cooking_adjustment"]);
    expect(writerNode?.tools?.called).toEqual(["lookup_pan_conversion"]);
  });
});

describe("one run = one trace", () => {
  it("opens exactly one root and one child span per node that ran", async () => {
    const ports = directPorts();
    await runPipeline(buildScalePipeline(), input, ports);

    expect(ports.tracer.roots).toHaveLength(1);
    expect(ports.tracer.roots[0]?.name).toBe("pipeline:scale");

    const children = ports.tracer.spans.filter((s) => s.depth > 0).map((s) => s.name);
    expect(children).toEqual(["classify", "table", "gate", "direct", "changes", "persist"]);
  });

  it("puts the branch, the thresholds and the node version on the spans", async () => {
    const ports = directPorts();
    await runPipeline(buildScalePipeline(), input, ports);

    const gate = ports.tracer.span_("gate");
    expect(gate?.metadata.branch).toBe("direct");
    expect(gate?.metadata.thresholds).toEqual({ category: 0.7, tools: 0.5 });
    expect(ports.tracer.span_("classify")?.metadata.node_version).toBe("3");
  });

  it("tags the trace with the pipeline, the fact and the route it took", async () => {
    const ports = directPorts();
    await runPipeline(buildScalePipeline(), input, ports);
    // Each route SEGMENT is its own tag as well as the whole route, so the
    // plain branch names stay filterable the way they were back when each
    // branch was a trace of its own.
    expect(ports.tracer.roots[0]?.tags).toEqual([
      "pipeline:scale",
      "fact:scaled_recipe",
      "direct",
      "route:direct",
    ]);
  });

  it("takes host tags from the caller, for what the manifest cannot know", async () => {
    const ports = directPorts();
    await runPipeline(buildScalePipeline(), input, ports, { tags: ["prod", "scale"] });
    expect(ports.tracer.roots[0]?.tags).toEqual(
      expect.arrayContaining(["prod", "scale", "direct"]),
    );
  });

  it("keeps one durable run key across attempts, with a new trace id each time", async () => {
    // LangGraph's thread_id / checkpoint_id split. A retry is a new TRACE but
    // the same piece of work, and a label written against attempt 1 has to
    // still resolve after attempt 2 — otherwise the training join silently
    // drops every run that was ever retried.
    const first = await runPipeline(buildScalePipeline(), input, testPorts({
      ...directPortsInput,
      traceId: "trace-attempt-1",
    }), { runKey: "scale:abc123" });
    const second = await runPipeline(buildScalePipeline(), input, testPorts({
      ...directPortsInput,
      traceId: "trace-attempt-2",
    }), { runKey: "scale:abc123" });

    expect(first.runId).toBe("trace-attempt-1");
    expect(second.runId).toBe("trace-attempt-2");
    expect(first.runKey).toBe("scale:abc123");
    expect(second.runKey).toBe("scale:abc123");
    expect(first.record.run_key).toBe(second.record.run_key);
    expect(first.record.run_id).not.toBe(second.record.run_id);
  });

  it("falls back to the attempt id when the host has no stable key", async () => {
    // Never null: a training join keyed on an optional column drops rows.
    const run = await runPipeline(buildScalePipeline(), input, directPorts());
    expect(run.runKey).toBe(run.record.run_id);
    expect(run.record.run_key).toBe(run.record.run_id);
  });

  it("puts the run key on the trace, so a hand read can find the retries", async () => {
    const ports = directPorts();
    await runPipeline(buildScalePipeline(), input, ports, { runKey: "scale:abc123" });
    expect(ports.tracer.roots[0]?.metadata.run_key).toBe("scale:abc123");
  });

  it("attributes the trace to the user the scope context resolved", async () => {
    const ports = directPorts();
    await runPipeline(buildScalePipeline(), input, ports);
    expect(ports.tracer.roots[0]?.userId).toBe("u-1");
  });

  it("tags the arms, so an arm is filterable and comparable in the Langfuse UI", async () => {
    const armed = {
      id: "gate-tune", unit: "user" as const, mode: "shadow" as const,
      champion: "control", enabled: true,
      arms: { control: {}, tight: { thresholds: { gate: { category: 0.99 } } } },
    };
    const scale = buildScalePipeline({ experiments: [armed] });
    const ports = writerPorts({ decide: { classify: { distributions: confidentDistributions(2) } } });

    await runPipeline(scale, input, ports, { forceArm: { "gate-tune": "tight" } });
    const tags = ports.tracer.roots[0]?.tags ?? [];
    expect(tags).toContain("arm:gate-tune=tight");
    // A shadow challenger is tagged as one, so its traces never pollute a
    // champion's numbers by accident.
    expect(tags).toContain("shadow");

    await runPipeline(scale, input, ports, { forceArm: { "gate-tune": "control" } });
    expect(ports.tracer.roots[1]?.tags).not.toContain("shadow");
  });

  it("stamps the persistence contract onto the root", async () => {
    const ports = directPorts();
    const result = await runPipeline(buildScalePipeline(), input, ports);
    const root = ports.tracer.roots[0];

    expect(root?.metadata.scaled_recipe_route).toBe("direct");
    expect(root?.metadata.scaled_recipe_version).toBe(result.version);
    expect(root?.metadata.scaled_recipe_run_id).toBe(result.record.run_id);
    expect(root?.metadata.decided_by).toBe("llm");
  });
});

describe("the persistence contract", () => {
  it("hands the store node the fact, its route, version, run id and rank", async () => {
    const ports = directPorts();
    const result = await runPipeline(buildScalePipeline(), input, ports);

    expect(ports.storeWrites).toHaveLength(1);
    const write = ports.storeWrites[0];
    expect(write?.fact).toBe("scaled_recipe");
    expect(write?.route).toBe("direct");
    expect(write?.version).toBe(result.version);
    expect(write?.runId).toBe(result.runId);
    expect(write?.decidedBy).toBe("llm");
    expect(write?.confidence).toBeCloseTo(0.92, 10);
    expect(write?.scope).toBe("tenant");
    expect(write?.writesFact).toBe(true);
  });
});

describe("the run record", () => {
  it("carries distributions and an input hash on every decide node", async () => {
    const result = await runPipeline(buildScalePipeline(), input, directPorts());
    const classify = result.record.nodes.find((n) => n.id === "classify");

    // Mandatory, not optional: offline replay is impossible without both.
    expect(classify?.distributions).toEqual(confidentDistributions(2));
    expect(classify?.input_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("carries the thresholds actually used on the gate node", async () => {
    const result = await runPipeline(buildScalePipeline(), input, directPorts());
    expect(result.record.nodes.find((n) => n.id === "gate")?.thresholds).toEqual({
      category: 0.7,
      tools: 0.5,
    });
  });

  it("totals the cost and fills the identity fields", async () => {
    const ports = directPorts();
    const result = await runPipeline(buildScalePipeline(), input, ports, {
      parentRunId: "outer-run-9",
    });
    const record = ports.recorded[0];

    expect(record?.pipeline).toBe("scale");
    expect(record?.group).toBe("cook-r-1");
    expect(record?.tenant).toBe("t-1");
    expect(record?.user).toBe("u-1");
    expect(record?.trigger).toBe("on-demand");
    expect(record?.cost_usd).toBeCloseTo(0.0002, 10);
    expect(record?.fact_route).toBe("direct");
    // An arm has to be able to ride down into a sub-pipeline.
    expect(record?.parent_run_id).toBe("outer-run-9");
    expect(result.record).toEqual(record);
  });

  it("extracts pipeline-agnostic features from the distributions", async () => {
    const result = await runPipeline(buildScalePipeline(), input, directPorts());
    expect(result.record.features["classify.line:0.margin"]).toBeCloseTo(0.84, 10);
    expect(result.record.features.nodes_ran).toBe(6);
    expect(result.record.features.nodes_skipped).toBe(2);
  });

  it("names the feedback rows the run actually read", async () => {
    const ports = testPorts({
      decide: { classify: { distributions: confidentDistributions(2) } },
      scope: {
        ids: { user: "u-1" },
        features: [
          { id: "f-1", nodeId: "classify", scope: "user", rank: "human", value: "no salt" },
          { id: "f-2", nodeId: "table", scope: "user", rank: "human", value: "unread" },
        ],
      },
    });
    const result = await runPipeline(buildScalePipeline(), input, ports);

    expect(ports.decideCalls[0]?.features.map((f) => f.id)).toEqual(["f-1"]);
    expect(result.record.consumed_feedback_ids).toEqual(["f-1"]);
  });
});

describe("thresholds move the branch and the version", () => {
  it("an env override flips direct to writer", async () => {
    const ports = writerPorts({
      decide: { classify: { distributions: confidentDistributions(2) } },
      env: { RECIPES_SCALE_CATEGORY_GATE: "0.95" },
    });
    const result = await runPipeline(buildScalePipeline(), input, ports);
    expect(result.route).toBe("writer");
  });

  it("and changes the composite version, so two configurations never share one", async () => {
    const plain = await runPipeline(buildScalePipeline(), input, directPorts());
    const tuned = await runPipeline(
      buildScalePipeline(),
      input,
      testPorts({
        decide: { classify: { distributions: confidentDistributions(2) } },
        env: { RECIPES_SCALE_CATEGORY_GATE: "0.6" },
      }),
    );
    expect(tuned.version).not.toBe(plain.version);
  });

  it("a prompt version bump changes it too", async () => {
    const a = await runPipeline(
      buildScalePipeline(),
      input,
      testPorts({
        decide: { classify: { distributions: confidentDistributions(2) } },
        prompts: { "jev-scale-classify": { version: "12" } },
      }),
    );
    const b = await runPipeline(
      buildScalePipeline(),
      input,
      testPorts({
        decide: { classify: { distributions: confidentDistributions(2) } },
        prompts: { "jev-scale-classify": { version: "13" } },
      }),
    );
    expect(a.version).not.toBe(b.version);
  });
});

describe("onFailure", () => {
  it("`revert` discards the node's work and passes the inbound payload through", async () => {
    // The guard throws when the writer drops a line; the run survives on the
    // writer's own output rather than aborting.
    const ports = writerPorts({
      generate: { writer: { value: { ...writerOutput, scaledIngredients: ["only one"] } } },
    });
    const result = await runPipeline(buildScalePipeline(), input, ports);

    expect(result.output.scaledIngredients).toEqual(["only one"]);
    expect(result.record.nodes.find((n) => n.id === "guard")?.error).toContain("dropped a line");
  });

  it("`fail` is the default and aborts the run", async () => {
    const ports = testPorts({
      decide: {
        classify: () => {
          throw new Error("Jev timed out");
        },
      },
    });
    await expect(runPipeline(buildScalePipeline(), input, ports)).rejects.toBeInstanceOf(
      NodeFailedError,
    );
  });

  it("names the missing port rather than failing obscurely", async () => {
    const scale = buildScalePipeline();
    await expect(runPipeline(scale, input, { scope: () => ({}) })).rejects.toThrow(
      MissingPortError,
    );
  });
});

describe("caching", () => {
  it("keys per node version + input hash, and skips the port on a hit", async () => {
    const scale = buildScalePipeline();
    const cached = {
      ...scale,
      nodes: { ...scale.nodes, classify: { ...scale.nodes.classify!, cache: "per-key-forever" as const } },
    };
    const ports = directPorts();

    await runPipeline(cached, input, ports);
    expect(ports.decideCalls).toHaveLength(1);

    await runPipeline(cached, input, { ...ports, decide: ports.decide });
    // Same node version, same input hash: the decide port is not called again.
    expect(ports.decideCalls).toHaveLength(1);

    const bumped = {
      ...cached,
      nodes: { ...cached.nodes, classify: { ...cached.nodes.classify!, version: "4" } },
    };
    await runPipeline(bumped, input, ports);
    expect(ports.decideCalls).toHaveLength(2);
  });

  it("marks a cache hit on the record, so $0 has a reason", async () => {
    const scale = buildScalePipeline();
    const cached = {
      ...scale,
      nodes: { ...scale.nodes, classify: { ...scale.nodes.classify!, cache: "per-key-forever" as const } },
    };
    const ports = directPorts();

    const first = await runPipeline(cached, input, ports);
    expect(first.record.nodes.find((n) => n.id === "classify")?.cached).toBeUndefined();

    const second = await runPipeline(cached, input, { ...ports, decide: ports.decide });
    expect(second.record.nodes.find((n) => n.id === "classify")?.cached).toBe(true);
  });
});

describe("cost provenance", () => {
  it("separates a port that priced at zero from one that reported nothing", async () => {
    const scale = buildScalePipeline();

    // The scale classifier answering from its regex fallback: it ran, it cost
    // nothing, and it SAID so.
    const priced = testPorts({
      decide: { classify: { distributions: confidentDistributions(2), costUsd: 0 } },
      prompts: { "jev-scale-classify": { version: "12" } },
    });
    const withZero = await runPipeline(scale, input, priced);
    const zeroNode = withZero.record.nodes.find((n) => n.id === "classify");
    expect(zeroNode?.cost_usd).toBe(0);
    expect(zeroNode?.cost_reported).toBe(true);

    // A port that forgot `costUsd` altogether. Same $0, different fact — and
    // the one a cost meter must not add to a total in silence.
    const silent = testPorts({
      decide: { classify: { distributions: confidentDistributions(2) } },
      prompts: { "jev-scale-classify": { version: "12" } },
    });
    const withNone = await runPipeline(scale, input, silent);
    const silentNode = withNone.record.nodes.find((n) => n.id === "classify");
    expect(silentNode?.cost_usd).toBe(0);
    expect(silentNode?.cost_reported).toBe(false);
  });
});

describe("experiments", () => {
  const armed: ExperimentSpec = {
    id: "gate-tune",
    unit: "user",
    mode: "split",
    champion: "control",
    enabled: true,
    arms: { control: {}, tight: { thresholds: { gate: { category: 0.99 } } } },
  };

  it("an arm patch changes the branch, and the arm is on the record", async () => {
    const scale = buildScalePipeline({ experiments: [armed] });
    const ports = writerPorts({ decide: { classify: { distributions: confidentDistributions(2) } } });

    const control = await runPipeline(scale, input, ports, { forceArm: { "gate-tune": "control" } });
    expect(control.route).toBe("direct");

    const tight = await runPipeline(scale, input, ports, { forceArm: { "gate-tune": "tight" } });
    expect(tight.route).toBe("writer");
    expect(tight.arms).toEqual({ "gate-tune": "tight" });
    expect(tight.record.arms).toEqual({ "gate-tune": "tight" });
    expect(tight.patchApplied).toEqual(["gate.thresholds.category=0.99"]);
  });

  it("folds the arm into the version, so two arms never collide under one", async () => {
    const scale = buildScalePipeline({ experiments: [armed] });
    const ports = writerPorts({ decide: { classify: { distributions: confidentDistributions(2) } } });

    const a = await runPipeline(scale, input, ports, { forceArm: { "gate-tune": "control" } });
    const b = await runPipeline(scale, input, ports, { forceArm: { "gate-tune": "tight" } });
    expect(a.version).not.toBe(b.version);
  });

  it("records the assignment unit and hash, so an assignment is auditable", async () => {
    const scale = buildScalePipeline({ experiments: [armed] });
    // No `forceArm`: this exercises the real assignment path, so BOTH arms
    // have to be runnable.
    const result = await runPipeline(scale, input, writerPorts());
    expect(result.record.assignment_unit).toBe("user");
    expect(result.record.assignment_hash).toBe("gate-tune:user:u-1");
  });

  it("a shadow challenger must NOT write the fact", async () => {
    const shadow: ExperimentSpec = { ...armed, mode: "shadow" };
    const scale = buildScalePipeline({ experiments: [shadow] });
    const ports = writerPorts({ decide: { classify: { distributions: confidentDistributions(2) } } });

    await runPipeline(scale, input, ports, { forceArm: { "gate-tune": "tight" } });
    expect(ports.storeWrites[0]?.writesFact).toBe(false);

    await runPipeline(scale, input, ports, { forceArm: { "gate-tune": "control" } });
    expect(ports.storeWrites[1]?.writesFact).toBe(true);
  });
});

describe("overrides layer, never mutate", () => {
  it("applies the narrowest override at READ, leaving the run's own answer untouched", async () => {
    const scale = buildScalePipeline();
    const result = await runPipeline(scale, input, directPorts());

    const overridable = {
      ...scale,
      overridable: { scope: "device" as const, key: () => "scaled:r-1" },
    };
    const { ctx } = buildScopeContext({
      overrides: [
        { id: "o-1", key: "scaled:r-1", scope: "user", rank: "human", value: "the human's" },
        { id: "o-2", key: "scaled:r-1", scope: "device", rank: "human", value: "the device's" },
      ],
    });

    const read = applyOverride(overridable, result.output, ctx);
    // Narrowest wins: the device row, not the user row.
    expect(read.value).toBe("the device's");
    expect(read.override?.id).toBe("o-2");
    // What the pipeline decided is still exactly what it decided.
    expect(result.output.scaledIngredients).toEqual(["2x 1 cup flour", "2x 1 tsp salt"]);
  });
});

describe("output validation", () => {
  it("rejects a shape the manifest's output schema does not describe", async () => {
    const ports = writerPorts({
      generate: { writer: { value: { nonsense: true } } },
    });
    await expect(runPipeline(buildScalePipeline(), input, ports)).rejects.toThrow();
  });

  it("rejects an input the manifest's input schema does not describe", async () => {
    await expect(
      runPipeline(buildScalePipeline(), { recipeId: 7 }, directPorts()),
    ).rejects.toThrow();
  });
});
