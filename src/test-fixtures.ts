/**
 * The doc's worked example — scale — as a runnable manifest with fake bodies.
 *
 * Deliberately the SAME shape as `docs/decision-pipelines.md`: classify ->
 * table -> gate -> {direct | writer -> guard} -> changes -> persist. If the
 * runtime cannot run this, it cannot run the first real pipeline either.
 */

import { z } from "zod";
import { definePipeline, type DecisionPipeline } from "./define";
import { defineReviewLane, PIPELINE_REVIEW_QUEUE } from "./review";
import { definePrimitive, defineRegistry, type PipelineSpecJSON } from "./spec";
import type { ChangeRow, NodeRunArgs } from "./types";

export const ScaleInput = z.object({
  recipeId: z.string(),
  factor: z.number(),
  notes: z.string().default(""),
  substitutionCount: z.number().default(0),
  ingredients: z.array(z.string()),
});
export type ScaleInputT = z.infer<typeof ScaleInput>;

export const ScaledRecipe = z.object({
  scaledIngredients: z.array(z.string()),
  scalingNotes: z.array(z.string()),
  factor: z.number(),
  changes: z.array(
    z.object({
      kind: z.string(),
      subject: z.string(),
      before: z.unknown(),
      after: z.unknown(),
      reason: z.string(),
      nodeId: z.string(),
    }),
  ),
});
export type ScaledRecipeT = z.infer<typeof ScaledRecipe>;

interface Classification {
  lines: Array<{ index: number; category: string; confidence: number }>;
  dishConfidence: number;
}

interface TableRow {
  index: number;
  original: string;
  linear: string;
  category: string;
  confidence: number;
}

/** `decide` returns distributions; `interpret` turns them into what the table needs. */
export const interpretClassify = (
  distributions: Record<string, number[]>,
  args: NodeRunArgs<ScaleInputT>,
): Classification => ({
  lines: args.input.ingredients.map((_, index) => {
    const p = distributions[`line:${index}`] ?? [0];
    return {
      index,
      category: (p[0] ?? 0) >= 0.5 ? "linear" : "structural",
      confidence: p[0] ?? 0,
    };
  }),
  dishConfidence: distributions.dish?.[0] ?? 0,
});

export const buildScalingTable = (args: NodeRunArgs<ScaleInputT>): TableRow[] => {
  const classification = args.primary as Classification;
  return args.input.ingredients.map((original, index) => {
    const line = classification.lines[index];
    return {
      index,
      original,
      linear: `${args.input.factor}x ${original}`,
      category: line?.category ?? "structural",
      confidence: line?.confidence ?? 0,
    };
  });
};

/** The gate: code, never a model. Reads resolved NUMBERS, never `process.env`. */
export const directGate = (
  args: NodeRunArgs<ScaleInputT>,
): { branch: string; reason?: string; confidence: number } => {
  const rows = args.primary as TableRow[];
  const min = rows.length === 0 ? 0 : Math.min(...rows.map((r) => r.confidence));
  const gate = args.thresholds.category ?? 0.7;
  if (args.input.notes.trim() !== "") {
    return { branch: "writer", reason: "notes", confidence: min };
  }
  if (args.input.substitutionCount > 0) {
    return { branch: "writer", reason: "substitutions", confidence: min };
  }
  return min >= gate
    ? { branch: "direct", confidence: min }
    : { branch: "writer", reason: "low_line_confidence", confidence: min };
};

export const directScaledRecipe = (args: NodeRunArgs<ScaleInputT>): ScaledRecipeT => {
  const rows = args.primary as TableRow[];
  return {
    scaledIngredients: rows.map((r) => r.linear),
    scalingNotes: rows.map((r) => `${r.original}: scaled ${r.category}`),
    factor: args.input.factor,
    changes: [],
  };
};

export const scaleGuard = (args: NodeRunArgs<ScaleInputT>): ScaledRecipeT => {
  const written = args.primary as ScaledRecipeT;
  if (written.scaledIngredients.length !== args.input.ingredients.length) {
    throw new Error("writer dropped a line");
  }
  return written;
};

export const scaleChanges = (args: NodeRunArgs<ScaleInputT>): ScaledRecipeT => {
  const scaled = args.primary as ScaledRecipeT;
  const changes: ChangeRow[] = scaled.scaledIngredients.map((after, index) => ({
    kind: "scaled",
    subject: args.input.ingredients[index] ?? "",
    before: args.input.ingredients[index] ?? "",
    after,
    reason: `factor ${args.input.factor}`,
    nodeId: "changes",
  }));
  return { ...scaled, changes };
};

/**
 * A lane, not a queue: it lands in the shared `pipeline-review` queue with the
 * pipeline and edge id on the item. Its score config is what a reviewer grades
 * the flagged line with.
 */
export const SCALE_LINE_LANE = defineReviewLane({
  lane: "scale-line-review",
  queue: PIPELINE_REVIEW_QUEUE,
  scoreConfig: {
    name: "scale_line_verdict",
    dataType: "CATEGORICAL",
    categories: [
      { label: "wrong", value: 0 },
      { label: "arguable", value: 1 },
      { label: "fine", value: 2 },
    ],
    description:
      "A line a cook flagged on the scaling notes panel. `wrong` = the category or the rounding is wrong for this ingredient; `arguable` = defensible but not what a cook would do; `fine` = the flag was a misread.",
  },
});

export const buildScalePipeline = (
  overrides: { experiments?: Parameters<typeof definePipeline>[0]["experiments"] } = {},
): DecisionPipeline<ScaleInputT, ScaledRecipeT> =>
  definePipeline<ScaleInputT, ScaledRecipeT>({
    id: "scale",
    fact: "scaled_recipe",
    input: ScaleInput,
    output: ScaledRecipe,
    trigger: ["on-demand"],
    group: (i) => `cook-${i.recipeId}`,
    result: ["changes"],
    decidedBy: "llm",
    nodes: {
      classify: {
        kind: "decide",
        questions: "jev-scale-classify",
        state: ["scale-categories"],
        acceptsFeatures: true,
        interpret: (d, args) => interpretClassify(d, args as NodeRunArgs<ScaleInputT>),
        version: "3",
      },
      table: { kind: "code", role: "transform", run: buildScalingTable, version: "2" },
      gate: {
        kind: "code",
        role: "gate",
        run: directGate,
        branches: ["direct", "writer"],
        thresholds: {
          category: { env: "RECIPES_SCALE_CATEGORY_GATE", default: 0.7 },
          tools: 0.5,
        },
        version: "1",
      },
      direct: { kind: "code", role: "derive", run: directScaledRecipe, version: "1" },
      writer: {
        kind: "generate",
        prompt: "recipe-scale",
        route: "scale-writer",
        submit: "submit_scaled_recipe",
        tools: {
          static: "prompt-config",
          selectable: {
            candidates: ["lookup_pan_conversion", "lookup_cooking_adjustment"],
            from: "classify",
            gate: "gate",
          },
          allow: [
            "lookup_pan_conversion",
            "lookup_cooking_adjustment",
            "lookup_scaling_rule",
          ],
        },
        version: "7",
      },
      guard: {
        kind: "code",
        role: "validate",
        run: scaleGuard,
        onFailure: "revert",
        version: "1",
      },
      changes: { kind: "code", role: "derive", run: scaleChanges, version: "2" },
      persist: { kind: "store", target: "qdrant", scope: "tenant", version: "1" },
    },
    edges: [
      { from: "classify", to: "table" },
      { from: "table", to: "gate" },
      { from: "gate", to: "direct", when: { gate: "gate", branch: "direct" } },
      { from: "gate", to: "writer", when: { gate: "gate", branch: "writer" } },
      { from: "direct", to: "changes" },
      { from: "writer", to: "guard" },
      { from: "guard", to: "changes" },
      { from: "changes", to: "persist" },
    ],
    feedback: [
      {
        id: "rating",
        from: "surface:scaling-notes",
        to: "gate",
        source: "explicit",
        scope: "user",
        form: "score",
        latency: "deferred",
        // What the SPA already writes today: bad 0 / okay 0.5 / good 1, NUMERIC.
        score: {
          name: "scale_feedback",
          dataType: "NUMERIC",
          description:
            "The cook's rating of a scaled recipe (#317). bad 0 / okay 0.5 / good 1, on the run's trace; the comment carries the factor, the route and the flagged lines.",
        },
      },
      {
        id: "flagged-lines",
        from: "surface:scaling-notes",
        to: "classify",
        source: "explicit",
        scope: "user",
        form: "queue",
        latency: "deferred",
        promoteVia: SCALE_LINE_LANE,
      },
    ],
    eval: { dataset: "scale-eval", gateMetric: "score_positive" },
    ...overrides,
  }) as DecisionPipeline<ScaleInputT, ScaledRecipeT>;

/** Distributions that clear the 0.7 gate on every line. */
export const confidentDistributions = (n: number): Record<string, number[]> => {
  const out: Record<string, number[]> = { dish: [0.95] };
  for (let i = 0; i < n; i += 1) out[`line:${i}`] = [0.92, 0.08];
  return out;
};

/** Distributions that do not. */
export const unsureDistributions = (n: number): Record<string, number[]> => {
  const out: Record<string, number[]> = { dish: [0.55] };
  for (let i = 0; i < n; i += 1) out[`line:${i}`] = [0.52, 0.48];
  return out;
};

// ---------------------------------------------------------------------------
// A small JSON spec over a demo registry (./spec, ./propose)
// ---------------------------------------------------------------------------

export const DemoInput = z.object({ id: z.string(), title: z.string(), factor: z.number() });
export type DemoIn = z.infer<typeof DemoInput>;
export const DemoOutput = z.object({ text: z.string(), n: z.number() });
export type DemoOut = z.infer<typeof DemoOutput>;

export const demoRegistry = defineRegistry({
  primitives: [
    definePrimitive({
      id: "demo.load",
      version: "1",
      describe: "The recipe's evidence.",
      args: z.object({}),
      run: (_a, ctx) => ({ row: { p: 0.8, top: [{ slug: "thai", p: 0.8 }] }, title: (ctx.input as DemoIn).title }),
    }),
    definePrimitive({
      id: "demo.shout",
      version: "1",
      describe: "Upper-cases a title, n times.",
      args: z.object({ title: z.string(), n: z.number() }),
      run: (a) => ({ text: a.title.toUpperCase(), n: a.n }),
    }),
  ],
  functions: { half: { describe: "x / 2", fn: ((x: number) => x / 2) as never } },
  schemas: { "demo.input": DemoInput, "demo.output": DemoOutput },
});

export const demoSpec = (): PipelineSpecJSON => ({
  id: "spec-demo",
  fact: "demo",
  input: "demo.input",
  output: "demo.output",
  trigger: ["on-demand"],
  group: "demo-{id}",
  result: ["loud", "plain"],
  nodes: {
    evidence: { kind: "read", call: "demo.load@1", version: "1" },
    bundle: {
      kind: "code",
      role: "transform",
      inputs: { p: "evidence.row.p", title: "evidence.title", missing: "evidence.nope | 0" },
      version: "1",
    },
    gate: {
      kind: "code",
      role: "gate",
      inputs: { p: "bundle.p" },
      thresholds: { p: 0.5 },
      branches: ["loud", "plain"],
      rules: [
        { when: "p >= $t.p", branch: "loud", reason: "'p ' & $string(p)", confidence: "p" },
        { branch: "plain", reason: "'under'" },
      ],
      version: "1",
    },
    loud: {
      kind: "code",
      role: "derive",
      call: "demo.shout@1",
      args: { title: "gate.title", n: "$half($input.factor)" },
      version: "1",
    },
    plain: { kind: "code", role: "derive", expr: '{ "text": gate.title, "n": 0 }', version: "1" },
    check: {
      kind: "code",
      role: "validate",
      assert: [{ that: "$string(loud.text ? loud.text : plain.text) != ''", message: "empty text" }],
      version: "1",
    },
    persist: { kind: "store", target: "memory", scope: "user", version: "1" },
  },
  edges: [
    { from: "evidence", to: "bundle" },
    { from: "bundle", to: "gate" },
    { from: "gate", to: "loud", when: { gate: "gate", branch: "loud" } },
    { from: "gate", to: "plain", when: { gate: "gate", branch: "plain" } },
    { from: "loud", to: "check" },
    { from: "plain", to: "check" },
    { from: "check", to: "persist" },
  ],
  feedback: [
    {
      id: "rating",
      from: "surface:demo",
      to: "gate",
      source: "explicit",
      scope: "user",
      form: "score",
      latency: "deferred",
      score: { name: "demo_feedback", dataType: "NUMERIC" },
    },
  ],
  eval: { dataset: "demo-eval", gateMetric: "score_positive" },
});
