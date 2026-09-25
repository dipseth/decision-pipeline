import { describe, expect, it } from "vitest";
import {
  compileHypothesis,
  evaluateHypothesis,
  lockHypothesis,
  partitionRows,
  planHypothesis,
  type CompiledHypothesis,
  type HypothesisSpecInput,
} from "./hypothesis";
import { jsonataEngine } from "./jsonata";
import { defineMetric, metricRegistry, BUILTIN_METRICS, type ObservationRow } from "./metrics";
import { z } from "zod";

const compile = (spec: HypothesisSpecInput, opts: Parameters<typeof compileHypothesis>[1] = {}): CompiledHypothesis => {
  const r = compileHypothesis(spec, opts);
  if (!r.ok) throw new Error(r.problems.join("\n"));
  return r.hypothesis;
};

const agreement: HypothesisSpecInput = {
  id: "probe-gate-keeps-cuisine",
  claim: "The probe-gate challenger returns the champion's primary cuisine on at least 90% of recipes.",
  population: { describe: "held-out recipes" },
  metric: { ref: "exact_match@1", prediction: "prediction.slug", truth: "truth" },
  estimand: { kind: "level", arm: "challenger" },
  test: { kind: "greater", than: 0.9 },
};

const cuisineRows = (n: number, wrong = 0): ObservationRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    arm: "challenger",
    prediction: { slug: i < wrong ? "french" : "italian" },
    truth: "italian",
    recordedAt: "2026-09-24T00:00:00Z",
  }));

describe("compileHypothesis", () => {
  it("returns every problem at once", () => {
    const r = compileHypothesis({
      ...agreement,
      metric: { ref: "no_such@1" },
      guardrails: [
        { name: "cost", metric: { ref: "within_tolerance@1", args: {} }, test: { kind: "less", than: 0 } },
        { name: "cost", metric: { ref: "value@1" }, test: { kind: "less", than: 0 } },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.some((p) => p.includes("unknown metric no_such@1"))).toBe(true);
    expect(r.problems.some((p) => p.startsWith("guardrails.0.metric.args"))).toBe(true);
    expect(r.problems.some((p) => p.includes('duplicate "cost"'))).toBe(true);
  });

  it("refuses shape mismatches the data could never fix", () => {
    const bad = (patch: Partial<HypothesisSpecInput>) => {
      const r = compileHypothesis({ ...agreement, ...patch });
      return r.ok ? [] : r.problems;
    };
    expect(bad({ test: { kind: "greater", than: 1.2 } })[0]).toMatch(/outside \[0, 1\]/);
    expect(bad({ metric: { ref: "abs_error@1" }, interval: "wilson" })[0]).toMatch(/wilson needs a binary metric/);
    expect(bad({ metric: { ref: "auc@1" }, interval: "normal" })[0]).toMatch(/only a bootstrap/);
    expect(bad({ metric: { ref: "exact_match@1", expr: "1" } })[0]).toMatch(/exactly one of ref, expr/);
    expect(bad({ metric: { expr: "prediction = truth" } })[0]).toMatch(/needs an ExpressionEngine/);
    expect(bad({ estimand: { kind: "difference", treatment: "a", control: "a" } })[0]).toMatch(/must differ/);
  });

  it("warns when the claim says the treatment is WORSE on a lower-is-better metric", () => {
    const r = compileHypothesis({
      ...agreement,
      metric: { ref: "abs_error@1" },
      estimand: { kind: "difference", treatment: "b", control: "a" },
      test: { kind: "greater", than: 0 },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toMatch(/treatment is WORSE/);
  });

  it("hashes the meaning: key order is irrelevant, the claim is not", () => {
    const a = compile(agreement);
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]))
          : v;
    const b = compile(reverseKeys(agreement) as HypothesisSpecInput);
    expect(b.hash).toBe(a.hash);
    // An explicit default is the same claim.
    expect(compile({ ...agreement, alpha: 0.05 }).hash).toBe(a.hash);
    expect(compile({ ...agreement, test: { kind: "greater", than: 0.85 } }).hash).not.toBe(a.hash);
    expect(compile({ ...agreement, metric: { ...agreement.metric, args: { caseInsensitive: true } } }).hash).not.toBe(a.hash);
  });
});

describe("evaluateHypothesis — the decision rule", () => {
  it("40/40 supports > 0.9 with a Wilson interval instead of a zero-width one", async () => {
    const v = await evaluateHypothesis(compile(agreement), cuisineRows(40));
    expect(v.status).toBe("supported");
    expect(v.primary?.interval?.method).toBe("wilson");
    expect(v.primary?.interval?.confidence).toBeCloseTo(0.9, 10); // one-sided α=0.05 → 90% two-sided
    expect(v.primary?.interval?.hi).toBe(1);
    expect(v.primary?.interval?.lo).toBeGreaterThan(0.9);
    expect(v.preregistered).toBe(false);
    expect(v.warnings.join(" ")).toMatch(/EXPLORATORY/);
  });

  it("10/10 is inconclusive for > 0.9 and says how much data would settle it", async () => {
    const v = await evaluateHypothesis(compile({ ...agreement, plan: { minEffect: 0.05 } }), cuisineRows(10));
    expect(v.status).toBe("inconclusive");
    expect(v.primary?.power.underpowered).toBe(true);
    expect(v.primary?.power.requiredN).toBeGreaterThan(10);
    expect(v.reason).toMatch(/units would detect/);
  });

  it("refutes when the whole interval is on the wrong side", async () => {
    const v = await evaluateHypothesis(compile(agreement), cuisineRows(200, 60));
    expect(v.status).toBe("refuted");
    expect(v.primary?.estimate).toBeCloseTo(0.7, 10);
  });

  it("counts unscorable rows instead of guessing", async () => {
    const rows = [...cuisineRows(30), { id: "x", arm: "challenger", prediction: {}, truth: undefined }];
    const v = await evaluateHypothesis(compile(agreement), rows);
    expect(v.primary?.n.unscored).toBe(1);
    expect(v.primary?.n.scored.challenger).toBe(30);
  });
});

describe("preregistration and the holdout", () => {
  it("a lock whose hash moved makes the verdict invalid", async () => {
    const h = compile(agreement);
    const lock = lockHypothesis(h, new Date("2026-09-23T00:00:00Z"));
    const moved = compile({ ...agreement, test: { kind: "greater", than: 0.8 } });
    const v = await evaluateHypothesis(moved, cuisineRows(40), { lock });
    expect(v.status).toBe("invalid");
  });

  it("rows recorded before the lock are dropped; undated rows are flagged", async () => {
    const h = compile(agreement);
    const lock = lockHypothesis(h, new Date("2026-09-23T12:00:00Z"));
    const rows = [
      ...cuisineRows(40),
      ...cuisineRows(5, 5).map((r, i) => ({ ...r, id: `old${i}`, recordedAt: "2026-09-22T00:00:00Z" })),
      { ...cuisineRows(1)[0]!, id: "undated", recordedAt: undefined },
    ];
    const v = await evaluateHypothesis(h, rows, { lock });
    expect(v.preregistered).toBe(true);
    expect(v.excluded.beforeLock).toBe(5);
    expect(v.undated).toBe(1);
    expect(v.primary?.n.scored.challenger).toBe(41);
  });

  it("splits by unit, deterministically, and judges only the declared side", async () => {
    const spec = { ...agreement, population: { describe: "x", unit: "meta.user", split: { salt: "s1", holdout: 0.3, use: "holdout" as const } } };
    const rows = cuisineRows(400).map((r, i) => ({ ...r, meta: { user: `u${i % 80}` } }));
    const { dev, holdout } = partitionRows(compile(spec).spec, rows);
    expect(dev.length + holdout.length).toBe(400);
    // Whole users on one side.
    const holdoutUsers = new Set(holdout.map((r) => r.meta?.user));
    expect(dev.some((r) => holdoutUsers.has(r.meta?.user))).toBe(false);
    expect(holdoutUsers.size / 80).toBeGreaterThan(0.15);
    expect(holdoutUsers.size / 80).toBeLessThan(0.45);
    const v = await evaluateHypothesis(compile(spec), rows);
    expect(v.excluded.outsideSplit).toBe(dev.length);
    expect(v.primary?.n.units).toBe(holdoutUsers.size);
  });

  it("filters the population", async () => {
    const spec = { ...agreement, population: { describe: "tail only", where: [{ path: "meta.route", equals: "tail" }] } };
    const rows = cuisineRows(30).map((r, i) => ({ ...r, meta: { route: i % 3 === 0 ? "tail" : "leaf" } }));
    const v = await evaluateHypothesis(compile(spec), rows);
    expect(v.excluded.filtered).toBe(20);
  });
});

describe("prediction types beyond classification", () => {
  const pairedRows = (n: number, f: (i: number) => { a: unknown; b: unknown; truth: unknown }): ObservationRow[] =>
    Array.from({ length: n }, (_, i) => {
      const { a, b, truth } = f(i);
      return [
        { id: `i${i}`, arm: "champion", prediction: a, truth },
        { id: `i${i}`, arm: "challenger", prediction: b, truth },
      ];
    }).flat();

  it("regression: a paired MAE reduction, bootstrap", async () => {
    const h = compile({
      id: "scale-mae",
      claim: "The challenger's scaled quantities are closer to the cook's by at least 0.1 on average.",
      population: { describe: "scaled recipes" },
      metric: { ref: "abs_error@1" },
      estimand: { kind: "difference", treatment: "challenger", control: "champion" },
      test: { kind: "less", than: -0.1 },
    });
    const rows = pairedRows(60, (i) => ({ truth: i, a: i + 1 + (i % 5) * 0.1, b: i + 0.5 + (i % 5) * 0.1 }));
    const v = await evaluateHypothesis(h, rows);
    expect(v.primary?.interval?.method).toBe("bootstrap");
    expect(v.primary?.estimate).toBeCloseTo(-0.5, 10);
    expect(v.status).toBe("supported");
  });

  it("ranking: equivalent NDCG within a margin (a cheaper ranker is 'as good')", async () => {
    const h = compile({
      id: "graph-ndcg",
      claim: "The cheap ranker's NDCG@3 is within 0.05 of the current ranker's.",
      population: { describe: "search queries" },
      metric: { ref: "ndcg_at_k@1", args: { k: 3 } },
      estimand: { kind: "difference", treatment: "challenger", control: "champion" },
      test: { kind: "equivalent", within: 0.05 },
    });
    const rows = pairedRows(80, (i) => ({
      truth: { a: 3, b: 2, c: 1 },
      a: ["a", "b", "c"],
      b: i % 20 === 0 ? ["b", "a", "c"] : ["a", "b", "c"],
    }));
    const v = await evaluateHypothesis(h, rows);
    expect(v.status).toBe("supported");
    expect(v.primary?.estimate).toBeLessThan(0);
  });

  it("probabilistic: AUC above chance is a sample metric with a bootstrap interval", async () => {
    const h = compile({
      id: "confidence-auc",
      claim: "The gate's confidence separates right from wrong answers better than chance.",
      population: { describe: "cuisine runs with a hand label" },
      metric: { ref: "auc@1", prediction: "meta.confidence", truth: "truth.correct" },
      estimand: { kind: "level" },
      test: { kind: "greater", than: 0.5 },
    });
    const rows: ObservationRow[] = Array.from({ length: 80 }, (_, i) => ({
      id: `r${i}`,
      prediction: null,
      truth: { correct: i % 2 === 0 },
      meta: { confidence: i % 2 === 0 ? 0.6 + (i % 7) * 0.05 : 0.4 + (i % 9) * 0.05 },
    }));
    const v = await evaluateHypothesis(h, rows);
    expect(v.primary?.interval?.method).toBe("bootstrap");
    expect(v.status).toBe("supported");
  });

  it("paired binary adds McNemar's exact test", async () => {
    const h = compile({
      ...agreement,
      estimand: { kind: "difference", treatment: "challenger", control: "champion" },
      test: { kind: "different", from: 0 },
    });
    const rows = pairedRows(50, (i) => ({ truth: "it", a: { slug: i < 10 ? "fr" : "it" }, b: { slug: "it" } }));
    const v = await evaluateHypothesis(h, rows);
    expect(v.primary?.extra.mcnemar_only_treatment).toBe(10);
    expect(v.primary?.extra.mcnemar_only_control).toBe(0);
    expect(v.primary?.extra.mcnemar_p).toBeCloseTo(2 / 1024, 10);
    expect(v.status).toBe("supported");
  });

  it("an expression covers the metric nobody registered", async () => {
    const h = compile(
      {
        id: "servings-parity",
        claim: "The challenger keeps the servings count within one of the truth on at least 80% of recipes.",
        population: { describe: "scaled recipes" },
        metric: { expr: "$abs(prediction - truth) <= 1", binary: true, prediction: "prediction.servings" },
        estimand: { kind: "level" },
        test: { kind: "greater", than: 0.8 },
      },
      { engine: jsonataEngine() },
    );
    const rows: ObservationRow[] = Array.from({ length: 100 }, (_, i) => ({
      id: `r${i}`,
      prediction: { servings: i % 20 === 0 ? 9 : 4 },
      truth: 4,
    }));
    const v = await evaluateHypothesis(h, rows);
    expect(v.primary?.metric).toMatch(/^expr~/);
    expect(v.primary?.interval?.method).toBe("wilson");
    expect(v.primary?.estimate).toBeCloseTo(0.95, 10);
    expect(v.status).toBe("supported");
  });

  it("an expression that reads truth leaves rows with no truth unscored, not wrong", async () => {
    const h = compile(
      {
        id: "judged-right",
        claim: "At least half the answers are judged right by the reviewer.",
        population: { describe: "judged answers" },
        metric: { expr: "prediction in truth.right", binary: true, direction: "higher" },
        estimand: { kind: "level" },
        test: { kind: "greater", than: 0.5 },
      },
      { engine: jsonataEngine() },
    );
    const rows: ObservationRow[] = Array.from({ length: 40 }, (_, i) => ({
      id: `r${i}`,
      prediction: "thai",
      ...(i < 30 ? { truth: { right: ["thai"] } } : {}),
    }));
    const v = await evaluateHypothesis(h, rows);
    expect(v.primary?.n.unscored).toBe(10);
    expect(v.primary?.estimate).toBe(1);
  });

  it("a host metric registers like a built-in", async () => {
    const lengthRatio = defineMetric({
      id: "steps_ratio",
      version: "1",
      describe: "predicted steps / true steps",
      task: "regression",
      direction: "target",
      binary: false,
      needsTruth: true,
      scope: "row",
      args: z.object({}).strict(),
      score: ({ prediction, truth }) => (prediction as unknown[]).length / (truth as unknown[]).length,
    });
    const h = compile(
      {
        id: "steps",
        claim: "Break-it-down keeps step count within 10% of the source's on average.",
        population: { describe: "recipes" },
        metric: { ref: "steps_ratio@1" },
        estimand: { kind: "level" },
        test: { kind: "equivalent", around: 1, within: 0.1 },
      },
      { metrics: { ...BUILTIN_METRICS, ...metricRegistry(lengthRatio) } },
    );
    const rows: ObservationRow[] = Array.from({ length: 40 }, (_, i) => ({
      id: `r${i}`,
      prediction: new Array(10 + (i % 3) - 1).fill(0),
      truth: new Array(10).fill(0),
    }));
    expect((await evaluateHypothesis(h, rows)).status).toBe("supported");
  });
});

describe("guardrails and segments", () => {
  const rows: ObservationRow[] = Array.from({ length: 60 }, (_, i) => ({
    id: `r${i}`,
    arm: "challenger",
    prediction: { slug: "italian" },
    truth: "italian",
    meta: { cost_usd: 0.004 + (i % 3) * 0.001, lang: i % 2 ? "en" : "de" },
  }));

  it("a supported primary with a failed guardrail is refuted, and says which", async () => {
    const h = compile({
      ...agreement,
      guardrails: [{ name: "cost", metric: { ref: "value@1", prediction: "meta.cost_usd" }, estimand: { kind: "level" }, test: { kind: "less", than: 0.002 } }],
    });
    const v = await evaluateHypothesis(h, rows);
    expect(v.primary?.status).toBe("supported");
    expect(v.guardrails[0]?.status).toBe("refuted");
    expect(v.status).toBe("refuted");
    expect(v.reason).toMatch(/guardrail "cost" failed/);
  });

  it("segments are reported per value, and never change the verdict", async () => {
    const h = compile({ ...agreement, segments: [{ name: "lang", by: "meta.lang" }] });
    const v = await evaluateHypothesis(h, rows);
    expect(v.segments.map((s) => s.value)).toEqual(["de", "en"]);
    expect(v.segments.every((s) => s.result.n.scored.challenger === 30)).toBe(true);
    expect(v.status).toBe("supported");
  });

  it("a peek before plan.n is marked not final", async () => {
    const v = await evaluateHypothesis(compile({ ...agreement, plan: { n: 100 } }), rows);
    expect(v.final).toBe(false);
  });
});

describe("planHypothesis", () => {
  it("sizes a binary claim from its baseline", () => {
    const h = compile({ ...agreement, test: { kind: "greater", than: 0.85 }, plan: { minEffect: 0.05, baseline: 0.9 } });
    const p = planHypothesis(h);
    expect(p.design).toBe("one-sample");
    // ((1.645 + 0.8416) · 0.3 / 0.05)² ≈ 222.6
    expect(p.requiredN).toBe(223);
  });

  it("says what it is missing instead of inventing a number", () => {
    expect(planHypothesis(compile(agreement)).requiredN).toBeNull();
  });
});
