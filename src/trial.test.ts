import { describe, expect, it } from "vitest";
import { compileHypothesis, splitOf, type CompiledHypothesis, type HypothesisSpecInput } from "./hypothesis";
import { collectTrial, judgeTrial, lockTrial, registerTrial } from "./trial";
import { memoryTrialStore, testPorts } from "./testing";
import { buildScalePipeline, confidentDistributions, type ScaledRecipeT, type ScaleInputT } from "./test-fixtures";
import type { DecisionPipeline } from "./define";

const compile = (spec: HypothesisSpecInput): CompiledHypothesis => {
  const r = compileHypothesis(spec);
  if (!r.ok) throw new Error(r.problems.join("\n"));
  return r.hypothesis;
};

/** Jev is confident, so the champion goes direct; the stricter challenger pays for the writer. */
const ports = () =>
  testPorts({
    decide: { classify: { distributions: confidentDistributions(2), costUsd: 0.0002 } },
    generate: {
      writer: {
        value: { scaledIngredients: ["2 cup flour", "2 tsp salt"], scalingNotes: [], factor: 2, changes: [] } satisfies ScaledRecipeT,
        costUsd: 0.004,
      },
    },
    prompts: { "jev-scale-classify": { version: "12" }, "recipe-scale": { version: "7", tools: [] } },
  });

const stricter = (): DecisionPipeline<ScaleInputT, ScaledRecipeT> => {
  const base = buildScalePipeline();
  const gate = base.nodes.gate as Extract<(typeof base.nodes)[string], { role: "gate" }>;
  return { ...base, nodes: { ...base.nodes, gate: { ...gate, thresholds: { category: 0.99, tools: 0.5 }, version: "2" } } };
};

const inputs: ScaleInputT[] = Array.from({ length: 24 }, (_, i) => ({
  recipeId: `r-${i}`,
  factor: 2,
  notes: "",
  substitutionCount: 0,
  ingredients: ["1 cup flour", `${i + 1} tsp salt`],
}));

const costlier = (split?: { salt: string; holdout: number; use: "holdout" | "dev" }): HypothesisSpecInput => ({
  id: "strict-gate-costs-more",
  claim: "The stricter gate costs more per scale than the champion.",
  population: { describe: "test recipes", ...(split && { split }) },
  metric: { ref: "value@1", prediction: "meta.cost_usd" },
  estimand: { kind: "difference", treatment: "strict", control: "champion" },
  test: { kind: "greater", than: 0 },
});

/** testPorts' clock starts in 2023, so a lock must predate it for the rows to count. */
const LOCKED_AT = new Date(1_600_000_000_000);

const arms = { champion: { name: "champion", pipeline: buildScalePipeline() }, challenger: { name: "strict", pipeline: stricter() } };

const base = (h: CompiledHypothesis, store: ReturnType<typeof memoryTrialStore>, p = ports()) => ({
  hypothesis: h,
  store,
  champion: buildScalePipeline(),
  challenger: stricter(),
  inputs,
  id: (i: ScaleInputT) => i.recipeId,
  ports: p,
});

describe("trials", () => {
  it("locks, collects shadow pairs, and judges them as a preregistered verdict", async () => {
    const h = compile(costlier());
    const store = memoryTrialStore();
    await registerTrial(store, lockTrial(h, arms, LOCKED_AT));

    const out = await collectTrial({ ...base(h, store), truth: async ({ id }) => `truth-${id}`, meta: ({ input, arm }) => ({ title: input.recipeId, arm_again: arm }) });
    expect(out.collected).toBe(24);
    expect(out.costUsd.strict! - out.costUsd.champion!).toBeCloseTo(24 * 0.004);
    const rows = await store.rows(h.spec.id);
    expect(rows).toHaveLength(48);
    expect(rows[0]).toMatchObject({ id: "r-0", unit: "r-0", truth: "truth-r-0", meta: { title: "r-0", arm_again: "champion" } });
    expect(rows[1]).toMatchObject({ arm: "strict", meta: { arm_again: "strict" } });

    const j = await judgeTrial(h, store);
    expect(j.verdict.status, j.verdict.reason).toBe("supported");
    expect(j.verdict.preregistered).toBe(true);
    expect(j.read).toBe(1);
  });

  it("resumes: a second collection skips what the store already has", async () => {
    const h = compile(costlier());
    const store = memoryTrialStore();
    await registerTrial(store, lockTrial(h, arms));
    await collectTrial({ ...base(h, store), inputs: inputs.slice(0, 5) });
    const p = ports();
    const again = await collectTrial({ ...base(h, store, p) });
    expect(again.skipped.alreadyCollected).toBe(5);
    expect(again.collected).toBe(19);
    expect(p.decideCalls).toHaveLength(19);
  });

  it("runs only the split the claim is judged on, and counts holdout reads", async () => {
    const split = { salt: "t", holdout: 0.5, use: "holdout" as const };
    const h = compile(costlier(split));
    const store = memoryTrialStore();
    await registerTrial(store, lockTrial(h, arms, LOCKED_AT));
    const p = ports();
    const out = await collectTrial({ ...base(h, store, p) });
    const holdout = inputs.filter((i) => splitOf(i.recipeId, split) === "holdout").length;
    expect(out.collected).toBe(holdout);
    expect(out.skipped.otherSplit).toBe(24 - holdout);
    expect(p.decideCalls).toHaveLength(holdout);

    expect((await judgeTrial(h, store)).verdict.warnings.join()).not.toMatch(/re-read/);
    const second = await judgeTrial(h, store);
    expect(second.read).toBe(2);
    expect(second.verdict.warnings.join()).toMatch(/holdout read 2/);
  });

  it("refuses a changed claim under a locked id, an unregistered trial, and a swapped pipeline", async () => {
    const h = compile(costlier());
    const store = memoryTrialStore();
    await expect(collectTrial(base(h, store))).rejects.toThrow(/not registered/);

    const lock = await registerTrial(store, lockTrial(h, arms));
    // Same trial again is idempotent and keeps the first registration time.
    expect((await registerTrial(store, lockTrial(h, arms, new Date(1_650_000_000_000)))).registered_at).toBe(lock.registered_at);

    const edited = compile({ ...costlier(), test: { kind: "greater", than: 0.001 } });
    await expect(registerTrial(store, lockTrial(edited, arms))).rejects.toThrow(/already locked/);
    await expect(collectTrial(base(edited, store))).rejects.toThrow(/changed since it was locked/);

    await expect(collectTrial({ ...base(h, store), challenger: buildScalePipeline() })).rejects.toThrow(/challenger is not the pipeline that was locked/);
  });
});
