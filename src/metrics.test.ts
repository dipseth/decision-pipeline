import { describe, expect, it } from "vitest";
import { BUILTIN_METRICS, metricCatalog, type Metric, type Observation } from "./metrics";

const row = { id: "r", prediction: null };
const obs = (prediction: unknown, truth?: unknown): Observation => ({ prediction, truth, row });

const score = (ref: string, prediction: unknown, truth?: unknown, args: Record<string, unknown> = {}) => {
  const m = BUILTIN_METRICS[ref] as Metric;
  if (m.scope !== "row") throw new Error(`${ref} is not a row metric`);
  return m.score(obs(prediction, truth), m.args.parse(args) as never);
};

const compute = (ref: string, pairs: Array<[unknown, unknown]>, args: Record<string, unknown> = {}) => {
  const m = BUILTIN_METRICS[ref] as Metric;
  if (m.scope !== "sample") throw new Error(`${ref} is not a sample metric`);
  return m.compute(pairs.map(([p, t]) => obs(p, t)), m.args.parse(args) as never);
};

describe("classification", () => {
  it("exact_match trims, optionally ignores case, compares objects structurally", () => {
    expect(score("exact_match@1", " french ", "french")).toBe(1);
    expect(score("exact_match@1", "French", "french")).toBe(0);
    expect(score("exact_match@1", "French", "french", { caseInsensitive: true })).toBe(1);
    expect(score("exact_match@1", { a: 1, b: 2 }, { b: 2, a: 1 })).toBe(1);
    expect(score("exact_match@1", "x", undefined)).toBeNull();
  });

  it("top_k reads a ranked list or a probability map", () => {
    expect(score("top_k@1", ["a", "b", "c"], "b", { k: 2 })).toBe(1);
    expect(score("top_k@1", { a: 0.1, b: 0.2, c: 0.7 }, "a", { k: 2 })).toBe(0);
    expect(score("top_k@1", { a: 0.1, b: 0.2, c: 0.7 }, "b", { k: 2 })).toBe(1);
  });
});

describe("probabilistic", () => {
  it("log_loss and brier, binary and multiclass", () => {
    expect(score("log_loss@1", 0.8, true)).toBeCloseTo(-Math.log(0.8), 10);
    expect(score("log_loss@1", 0.8, 0)).toBeCloseTo(-Math.log(0.2), 10);
    expect(score("log_loss@1", { a: 0.5, b: 0.5 }, "c")).toBeCloseTo(-Math.log(1e-15), 5);
    expect(score("brier@1", 0.8, 1)).toBeCloseTo(0.04, 10);
    // (0.7−1)² + (0.3−0)²
    expect(score("brier@1", { a: 0.7, b: 0.3 }, "a")).toBeCloseTo(0.18, 10);
    // truth absent from the map: 1 for the missing label + 0.7² + 0.3²
    expect(score("brier@1", { a: 0.7, b: 0.3 }, "c")).toBeCloseTo(1.58, 10);
    expect(score("prob_of_truth@1", [{ label: "a", p: 0.6 }], "a")).toBe(0.6);
  });

  it("crps_gaussian reduces to absolute error as sd → 0 and rewards honest spread", () => {
    expect(score("crps_gaussian@1", { mean: 2, sd: 0 }, 5)).toBe(3);
    const tight = score("crps_gaussian@1", { mean: 0, sd: 0.1 }, 3) as number;
    const honest = score("crps_gaussian@1", { mean: 0, sd: 2 }, 3) as number;
    expect(honest).toBeLessThan(tight);
  });

  it("auc: perfect separation 1, pure ties 0.5, one class undefined", () => {
    expect(compute("auc@1", [[0.9, 1], [0.8, 1], [0.2, 0], [0.1, 0]])).toBe(1);
    expect(compute("auc@1", [[0.5, 1], [0.5, 0]])).toBe(0.5);
    expect(compute("auc@1", [[0.5, 1], [0.7, 1]])).toBeNull();
  });

  it("ece is 0 for a calibrated bin and |gap| for a miscalibrated one", () => {
    const calibrated: Array<[unknown, unknown]> = [[0.75, 1], [0.75, 1], [0.75, 1], [0.75, 0]];
    expect(compute("ece@1", calibrated)).toBeCloseTo(0, 10);
    const overconfident: Array<[unknown, unknown]> = [[0.95, 1], [0.95, 0]];
    expect(compute("ece@1", overconfident)).toBeCloseTo(0.45, 10);
  });
});

describe("ranking", () => {
  it("reciprocal_rank, hit/precision/recall at k, average precision", () => {
    expect(score("reciprocal_rank@1", ["x", "y", "z"], "z")).toBeCloseTo(1 / 3, 10);
    expect(score("reciprocal_rank@1", ["x", "y", "z"], "z", { k: 2 })).toBe(0);
    expect(score("hit_at_k@1", ["x", "y"], ["q", "y"], { k: 2 })).toBe(1);
    expect(score("precision_at_k@1", ["x", "y", "z"], ["x", "z"], { k: 2 })).toBe(0.5);
    expect(score("recall_at_k@1", ["x", "y", "z"], ["x", "z"], { k: 2 })).toBe(0.5);
    // relevant at 1 and 3: (1/1 + 2/3) / 2
    expect(score("average_precision@1", ["x", "y", "z"], ["x", "z"])).toBeCloseTo((1 + 2 / 3) / 2, 10);
  });

  it("ndcg is 1 for the ideal order and uses graded gains", () => {
    expect(score("ndcg_at_k@1", ["a", "b"], { a: 3, b: 1 }, { k: 2 })).toBeCloseTo(1, 10);
    expect(score("ndcg_at_k@1", ["b", "a"], { a: 3, b: 1 }, { k: 2 })).toBeLessThan(1);
    expect(score("ndcg_at_k@1", ["c"], { a: 0 }, { k: 2 })).toBeNull();
  });

  it("kendall_tau: identical 1, reversed −1, only shared items count", () => {
    expect(score("kendall_tau@1", ["a", "b", "c"], ["a", "b", "c"])).toBe(1);
    expect(score("kendall_tau@1", ["c", "b", "a"], ["a", "b", "c"])).toBe(-1);
    expect(score("kendall_tau@1", ["a", "x", "b"], ["a", "b"])).toBe(1);
  });
});

describe("sets", () => {
  it("jaccard, set_f1, set_exact", () => {
    expect(score("jaccard@1", ["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 10);
    expect(score("set_f1@1", ["a", "b"], ["b", "c"])).toBe(0.5);
    expect(score("set_exact@1", ["b", "a"], ["a", "b"])).toBe(1);
    expect(score("jaccard@1", [], [])).toBe(1);
  });
});

describe("regression and intervals", () => {
  it("errors", () => {
    expect(score("abs_error@1", 3, 5)).toBe(2);
    expect(score("squared_error@1", 3, 5)).toBe(4);
    expect(score("signed_error@1", 3, 5)).toBe(-2);
    expect(score("abs_pct_error@1", 3, 0)).toBeNull();
    expect(score("log_ratio_error@1", 2, 1)).toBeCloseTo(Math.log(2), 10);
    expect(score("log_ratio_error@1", 1, 2)).toBeCloseTo(Math.log(2), 10);
    expect(score("within_tolerance@1", 10.4, 10, { rel: 0.05 })).toBe(1);
    expect(score("within_tolerance@1", 10.6, 10, { rel: 0.05 })).toBe(0);
    expect(() => BUILTIN_METRICS["within_tolerance@1"]?.args.parse({})).toThrow();
  });

  it("interval coverage, width, score, pinball", () => {
    expect(score("interval_covers@1", { lo: 1, hi: 3 }, 2)).toBe(1);
    expect(score("interval_covers@1", [1, 3], 4)).toBe(0);
    expect(score("interval_width@1", { low: 1, high: 4 }, undefined, { lo: "low", hi: "high" })).toBe(3);
    // width 2 + (2/0.1)·(4 − 3)
    expect(score("interval_score@1", [1, 3], 4, { alpha: 0.1 })).toBeCloseTo(22, 10);
    expect(score("pinball@1", 5, 7, { q: 0.9 })).toBeCloseTo(1.8, 10);
    expect(score("pinball@1", 5, 3, { q: 0.9 })).toBeCloseTo(0.2, 10);
  });

  it("sample correlations", () => {
    const mono: Array<[unknown, unknown]> = [[1, 1], [2, 4], [3, 9], [4, 16]];
    expect(compute("spearman@1", mono)).toBeCloseTo(1, 10);
    expect(compute("pearson@1", mono) as number).toBeLessThan(1);
    expect(compute("r2@1", [[1, 1], [2, 2], [3, 3]])).toBe(1);
  });
});

describe("agreement and generic", () => {
  it("cohen_kappa and macro_f1", () => {
    expect(compute("cohen_kappa@1", [["a", "a"], ["b", "b"], ["a", "a"], ["b", "b"]])).toBe(1);
    expect(compute("cohen_kappa@1", [["a", "a"], ["a", "b"], ["b", "a"], ["b", "b"]])).toBe(0);
    expect(compute("macro_f1@1", [["a", "a"], ["b", "b"]])).toBe(1);
  });

  it("value / truthy / equals read the prediction alone", () => {
    expect(score("value@1", 0.0031)).toBe(0.0031);
    expect(score("value@1", "n/a")).toBeNull();
    expect(score("truthy@1", "yes")).toBe(1);
    expect(score("equals@1", "tail", undefined, { value: "tail" })).toBe(1);
    expect(score("equals@1", "leaf", undefined, { in: ["tail", "probe"] })).toBe(0);
  });
});

describe("catalog", () => {
  it("lists every metric with its args as JSON schema", () => {
    const catalog = metricCatalog(BUILTIN_METRICS);
    expect(catalog.length).toBe(Object.keys(BUILTIN_METRICS).length);
    const ndcg = catalog.find((c) => c.ref === "ndcg_at_k@1");
    expect(ndcg?.task).toBe("ranking");
    expect(JSON.stringify(ndcg?.args)).toContain('"k"');
  });
});
