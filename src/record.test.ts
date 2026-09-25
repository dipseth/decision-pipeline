import { describe, expect, it } from "vitest";
import {
  aggregateGateMetric,
  defineGateMetric,
  gateMetricNames,
  getGateMetric,
  hasGateMetric,
  type RunLabel,
  type RunRecord,
} from "./record";

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  pipeline: "scale",
  version: "v1",
  run_id: "r1",
  run_key: "r1",
  group: "cook-1",
  tenant: null,
  user: null,
  trigger: "on-demand",
  input_hash: "h",
  cost_usd: 0,
  ms: 1,
  nodes: [],
  features: {},
  fact: "scaled_recipe",
  fact_route: "direct",
  fact_confidence: 0.9,
  consumed_feedback_ids: [],
  arms: {},
  parent_run_id: null,
  assignment_unit: null,
  assignment_hash: null,
  created_at: "2026-09-22T00:00:00.000Z",
  ...over,
});

const label = (over: Partial<RunLabel> = {}): RunLabel => ({
  run_id: "r1",
  kind: "score",
  value: 1,
  scope: "user",
  rank: "human",
  source_id: "s1",
  created_at: "2026-09-22T00:00:00.000Z",
  ...over,
});

const EXTRA = "test_only_metric";

describe("the gate-metric registry", () => {
  it("ships two metrics so `eval.gateMetric` is never a stub", () => {
    expect(gateMetricNames()).toContain("score_positive");
    expect(gateMetricNames()).toContain("no_override_disagreement");
  });

  it("refuses to redefine a name with a different body", () => {
    const fn = () => 1;
    defineGateMetric(EXTRA, fn);
    expect(() => defineGateMetric(EXTRA, fn)).not.toThrow();
    expect(() => defineGateMetric(EXTRA, () => 0)).toThrow(/already defined/);
  });

  it("returns null when a run cannot contribute — never a silent zero", () => {
    const metric = getGateMetric("score_positive");
    expect(metric?.(record(), [])).toBeNull();
    expect(metric?.(record(), [label({ value: 1 })])).toBe(1);
    expect(metric?.(record(), [label({ value: -1 })])).toBe(0);
  });

  it("drops nulls from the aggregate rather than counting them as zero", () => {
    const result = aggregateGateMetric("score_positive", [
      { record: record(), labels: [label({ value: 1 })] },
      { record: record(), labels: [label({ value: -1 })] },
      { record: record(), labels: [] },
    ]);
    expect(result).toEqual({ name: "score_positive", n: 2, mean: 0.5 });
  });

  it("reports n=0 and a null mean when nothing is labelled yet", () => {
    expect(aggregateGateMetric("score_positive", [{ record: record(), labels: [] }])).toEqual({
      name: "score_positive",
      n: 0,
      mean: null,
    });
  });

  it("throws on an unknown metric instead of quietly returning nothing", () => {
    expect(() => aggregateGateMetric("nope", [])).toThrow(/Unknown gate metric/);
  });

  it("scores the disagreement set", () => {
    const metric = getGateMetric("no_override_disagreement");
    expect(metric?.(record(), [label({ kind: "override_disagreement", value: 1 })])).toBe(0);
    expect(metric?.(record(), [label({ kind: "override_disagreement", value: 0 })])).toBe(1);
  });
});
