import { describe, expect, it } from "vitest";
import { evalItemId, evalRunName, recordPipelineEvalRun } from "./eval";
import { testPorts } from "./testing";
import { buildScalePipeline } from "./test-fixtures";
import type { RunLabel, RunRecord } from "./record";

const scale = buildScalePipeline();

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  pipeline: "scale", version: "v-aaa", run_id: "r1", run_key: "r1", group: "cook-1",
  tenant: null, user: null, trigger: "on-demand", input_hash: "h",
  cost_usd: 0, ms: 1, nodes: [], features: {}, fact: "scaled_recipe",
  fact_route: "direct", fact_confidence: 0.9, consumed_feedback_ids: [],
  arms: {}, parent_run_id: null, assignment_unit: null, assignment_hash: null,
  created_at: "2026-09-22T00:00:00.000Z", ...over,
});

const label = (value: number): RunLabel => ({
  run_id: "r1", kind: "score", value, scope: "user", rank: "human",
  source_id: "s", created_at: "2026-09-22T00:00:00.000Z",
});

describe("naming", () => {
  it("makes item ids deterministic so a re-run upserts", () => {
    expect(evalItemId("scale-eval", "recipe-7")).toBe("scale-eval/recipe-7");
    expect(evalItemId("d", "x".repeat(400))).toHaveLength(255);
  });

  it("puts the ARM in the run name, so Langfuse's run comparison IS the experiment readout", () => {
    expect(evalRunName({ pipeline: "scale", version: "v1" })).toBe("scale@v1");
    expect(
      evalRunName({ pipeline: "scale", version: "v1", experiment: "gate-tune", arm: "tight" }),
    ).toBe("scale:gate-tune=tight@v1");
  });
});

describe("recordPipelineEvalRun", () => {
  const rows = [
    { id: "a", input: { id: "a" }, record: record({ run_id: "r1" }), labels: [label(1)] },
    { id: "b", input: { id: "b" }, record: record({ run_id: "r2" }), labels: [label(-1)] },
    { id: "c", input: { id: "c" }, record: record({ run_id: "r3" }), labels: [] },
  ];

  it("computes eval.gateMetric through the registered extractor, not an ad-hoc query", async () => {
    const ports = testPorts();
    const result = await recordPipelineEvalRun(scale, { rows, traceId: "t-root" }, ports);

    // One label positive, one negative, one unlabelled and therefore dropped.
    expect(result.gateMetric).toEqual({ name: "score_positive", n: 2, mean: 0.5 });
    expect(result.submitted).toBe(true);
  });

  it("registers the dataset run with the metric as a score on the harness trace", async () => {
    const ports = testPorts();
    await recordPipelineEvalRun(
      scale,
      { rows, traceId: "t-root", experiment: "gate-tune", arm: "tight", extraScores: [["cost_usd", 0.004]] },
      ports,
    );

    const run = ports.datasetRuns[0];
    expect(run?.dataset).toBe("scale-eval");
    expect(run?.run).toBe("scale:gate-tune=tight@v-aaa");
    expect(run?.traceId).toBe("t-root");
    expect(run?.items).toHaveLength(3);
    expect(run?.scores).toEqual([["score_positive", 0.5], ["cost_usd", 0.004]]);
    expect(run?.runMetadata).toMatchObject({ pipeline: "scale", arm: "tight", n: 2 });
  });

  it("warns when rows span composite versions — two such runs are not comparable", async () => {
    const mixed = [rows[0]!, { ...rows[1]!, record: record({ version: "v-bbb" }) }];
    const result = await recordPipelineEvalRun(scale, { rows: mixed, traceId: "t" }, testPorts());
    expect(result.warnings.join()).toContain("span 2 composite versions");
  });

  it("still computes the metric with no dataset port, and says it did not register", async () => {
    const result = await recordPipelineEvalRun(scale, { rows, traceId: "t" }, {});
    expect(result.gateMetric.mean).toBe(0.5);
    expect(result.submitted).toBe(false);
    expect(result.warnings.join()).toContain("no `dataset` port");
  });
});
