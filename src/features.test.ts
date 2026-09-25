import { describe, expect, it } from "vitest";
import { distributionFeatures, normalizedEntropy, topMargin } from "./features";

describe("normalizedEntropy", () => {
  it("is 0 for a certainty and 1 for a uniform distribution", () => {
    expect(normalizedEntropy([1])).toBe(0);
    expect(normalizedEntropy([0.5, 0.5])).toBeCloseTo(1, 10);
    expect(normalizedEntropy([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(1, 10);
  });

  it("sits between the two for a lopsided one", () => {
    const h = normalizedEntropy([0.9, 0.1]);
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(1);
  });
});

describe("topMargin", () => {
  it("is the gap to the runner-up — how nearly the gate went the other way", () => {
    expect(topMargin([0.9, 0.1])).toBeCloseTo(0.8, 10);
    expect(topMargin([0.51, 0.49])).toBeCloseTo(0.02, 10);
    expect(topMargin([0.7])).toBeCloseTo(0.7, 10);
    expect(topMargin([])).toBeNull();
  });
});

describe("distributionFeatures", () => {
  it("flattens to `<node>.<question>.<stat>` keys", () => {
    const f = distributionFeatures([
      { nodeId: "classify", distributions: { "line:0": [0.92, 0.08] } },
    ]);
    expect(Object.keys(f).sort()).toEqual([
      "classify.line:0.entropy",
      "classify.line:0.margin",
      "classify.line:0.top",
    ]);
    expect(f["classify.line:0.top"]).toBeCloseTo(0.92, 10);
  });
});
