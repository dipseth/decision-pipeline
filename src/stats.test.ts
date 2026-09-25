import { describe, expect, it } from "vitest";
import {
  binomialCdf,
  clusterBootstrap,
  clusterRobustSe,
  mcnemarExact,
  newcombeInterval,
  normalCdf,
  normalQuantile,
  percentileInterval,
  requiredSampleSize,
  seededRandom,
  wilsonInterval,
} from "./stats";

describe("normal distribution", () => {
  it("quantile and cdf invert each other at the usual points", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.05)).toBeCloseTo(-1.644854, 5);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
  });
});

describe("proportion intervals", () => {
  it("Wilson does not collapse at n/n: 40/40 is about [0.912, 1]", () => {
    const { lo, hi } = wilsonInterval(40, 40, 0.95);
    expect(lo).toBeCloseTo(0.9124, 3);
    expect(hi).toBe(1);
  });

  it("Newcombe matches his published example (56/70 vs 48/80 → [0.0524, 0.3339])", () => {
    const { lo, hi } = newcombeInterval(56, 70, 48, 80, 0.95);
    expect(lo).toBeCloseTo(0.0524, 3);
    expect(hi).toBeCloseTo(0.3339, 3);
  });
});

describe("exact tests", () => {
  it("binomial cdf and McNemar", () => {
    expect(binomialCdf(0, 5, 0.5)).toBeCloseTo(1 / 32, 10);
    expect(mcnemarExact(0, 5)).toBeCloseTo(2 / 32, 10);
    expect(mcnemarExact(3, 3)).toBe(1);
    expect(mcnemarExact(0, 0)).toBe(1);
  });
});

describe("cluster-robust se", () => {
  it("equals sd/√n (with the g/(g−1) factor) when every row is its own cluster", () => {
    const xs = [1, 2, 3, 4, 5, 6];
    const se = clusterRobustSe(xs, xs.map(String));
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - 3.5) ** 2, 0) / 5);
    expect(se).toBeCloseTo(sd / Math.sqrt(6), 10);
  });

  it("grows when rows are duplicated inside clusters — copies are not new evidence", () => {
    const xs = [0, 1, 0, 1, 1, 0, 1, 1];
    const independent = clusterRobustSe(xs, xs.map((_, i) => String(i)));
    const dup = [...xs, ...xs];
    const clustered = clusterRobustSe(dup, dup.map((_, i) => String(i % xs.length)));
    const naive = clusterRobustSe(dup, dup.map((_, i) => String(i)));
    expect(naive).toBeLessThan(independent);
    expect(clustered).toBeGreaterThan(naive);
  });
});

describe("bootstrap", () => {
  it("is reproducible from its seed and differs across seeds", () => {
    const data = [[[1]], [[2]], [[3]], [[4]], [[5]]].map((c) => c as number[][]);
    const run = (seed: string) =>
      clusterBootstrap([data.flat()], ([rows]) => (rows as number[]).reduce((s, x) => s + x, 0) / (rows as number[]).length, {
        resamples: 300,
        random: seededRandom(seed),
      });
    expect(run("a").draws).toEqual(run("a").draws);
    expect(run("a").draws).not.toEqual(run("b").draws);
    const { lo, hi } = percentileInterval(run("a").draws, 0.9);
    expect(lo).toBeLessThan(3);
    expect(hi).toBeGreaterThan(3);
  });
});

describe("sample size", () => {
  it("one-sample, paired and two-sample designs", () => {
    // ((1.96 + 0.8416) · 1 / 0.5)² = 31.4
    expect(requiredSampleSize({ sd: 1, effect: 0.5, alphaPerSide: 0.025, power: 0.8, design: "one-sample" })).toBe(32);
    expect(requiredSampleSize({ sd: 1, effect: 0.5, alphaPerSide: 0.025, power: 0.8, design: "paired" })).toBe(32);
    expect(requiredSampleSize({ sd: 1, effect: 0.5, alphaPerSide: 0.025, power: 0.8, design: "two-sample" })).toBe(63);
  });
});
