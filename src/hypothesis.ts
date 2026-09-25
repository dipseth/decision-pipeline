/**
 * Hypotheses — a claim, declared as data, that a sample can SUPPORT, REFUTE,
 * or leave INCONCLUSIVE, with the interval that decided it.
 *
 * Everything the pipeline had before this measured things; nothing turned a
 * measurement into a verdict. A hypothesis is the missing object:
 *
 *   population   which rows count (filters, the independent unit, a sealed holdout)
 *   metric       what is measured per row — a registered metric (./metrics) or an expression
 *   estimand     the quantity: one arm's LEVEL, or the DIFFERENCE between two (paired or not)
 *   test         the claim about it: greater · less · equivalent · different
 *   plan         minimum effect worth detecting, power, planned n
 *   guardrails   claims that must ALSO hold (cost, latency, failure rate)
 *   segments     preregistered breakdowns, reported but never used to rescue a verdict
 *
 * It is JSON on purpose, like a pipeline spec: an LLM authors it, the compiler
 * returns every problem at once, and `lockHypothesis` hashes it BEFORE data is
 * collected. `evaluateHypothesis` refuses a spec whose hash moved and drops
 * rows recorded before the lock — changing the claim after seeing the data is
 * the failure this exists to prevent.
 *
 * Decision rule — one rule for every claim shape. Build a confidence interval
 * for the estimand; the claim is SUPPORTED when the whole interval satisfies
 * it, REFUTED when the whole interval contradicts it, INCONCLUSIVE otherwise.
 * One-sided claims (greater, less) and equivalence use a 1 − 2α interval,
 * which is exactly a one-sided α test (TOST for equivalence); `different`
 * uses 1 − α. A `different` claim can never be refuted — absence of a
 * difference is an `equivalent` claim, which has to be made on purpose.
 */

import { z } from "zod";
import { hashToUnit, shortHash, stableStringify } from "./hash";
import {
  BUILTIN_METRICS,
  pickPath,
  type Metric,
  type MetricDirection,
  type MetricRegistry,
  type Observation,
  type ObservationRow,
} from "./metrics";
import type { RunRecord } from "./record";
import { zodProblems } from "./schema";
import type { ShadowResult } from "./shadow";
import type { CompiledExpression, ExpressionEngine } from "./spec";
import {
  STATS_VERSION,
  clusterBootstrap,
  clusterRobustSe,
  detectableEffect,
  mcnemarExact,
  mean,
  newcombeInterval,
  newcombePairedInterval,
  percentileInterval,
  pUpper,
  requiredSampleSize,
  seededRandom,
  wilsonInterval,
  zFor,
  type SampleDesign,
} from "./stats";

/** Bumped when the spec's MEANING changes. Part of every hash. */
export const HYPOTHESIS_FORMAT = "1";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * A dotted path into the ROW: `prediction.primary.cuisine_slug`,
 * `truth.slug`, `meta.cost_usd`, `meta.user`, `arm`, `id`.
 */
const pathSchema = z
  .string()
  .regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/, "a dotted path into the row, e.g. prediction.primary.cuisine_slug");

const metricSpecSchema = z
  .object({
    /** A registered metric, `id@version` — see `metricCatalog()`. */
    ref: z.string().regex(/^[a-z0-9_.]+@[\w.-]+$/, "id@version").optional(),
    args: z.record(z.string(), z.unknown()).default({}),
    /**
     * A per-row expression instead of a registered metric, for the case no
     * one wrote a metric for. Sees `prediction`, `truth` (already picked) and
     * `row`; returns a number, a boolean, or null (unscorable).
     */
    expr: z.string().min(1).optional(),
    /** `expr` only: its scores are always 0/1 (unlocks Wilson / Newcombe / McNemar). */
    binary: z.boolean().optional(),
    /** `expr` only: which way is better. */
    direction: z.enum(["higher", "lower", "target", "either"]).optional(),
    /** Where the metric's prediction comes from. Default `prediction`. */
    prediction: pathSchema.default("prediction"),
    /** Where its truth comes from. Default `truth`. */
    truth: pathSchema.default("truth"),
  })
  .strict()
  .superRefine((m, ctx) => {
    if ((m.ref === undefined) === (m.expr === undefined)) {
      ctx.addIssue({ code: "custom", message: "give exactly one of ref, expr" });
    }
    if (m.ref !== undefined && (m.binary !== undefined || m.direction !== undefined)) {
      ctx.addIssue({ code: "custom", message: "binary / direction come from the registered metric; set them only on an expr" });
    }
  });

const estimandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("level"),
      /** Only rows of this arm. Absent: every row. */
      arm: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("difference"),
      /** Estimand = treatment − control. */
      treatment: z.string().min(1),
      control: z.string().min(1),
      /**
       * Rows of both arms sharing an `id` are one PAIR (a shadow run is paired
       * by construction). Pairing removes item-to-item variation, often most
       * of the noise. Default true.
       */
      paired: z.boolean().default(true),
    })
    .strict()
    .refine((e) => e.treatment !== e.control, "treatment and control must differ"),
]);

const testSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("greater"), than: z.number() }).strict(),
  z.object({ kind: z.literal("less"), than: z.number() }).strict(),
  z
    .object({
      kind: z.literal("equivalent"),
      around: z.number().default(0),
      /** The margin inside which a difference does not matter. */
      within: z.number().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("different"), from: z.number().default(0) }).strict(),
]);

const filterSchema = z
  .object({
    path: pathSchema,
    equals: z.unknown().optional(),
    in: z.array(z.unknown()).optional(),
    exists: z.boolean().optional(),
  })
  .strict()
  .refine(
    (f) => [f.equals, f.in, f.exists].filter((v) => v !== undefined).length === 1,
    "give exactly one of equals, in, exists",
  );

const populationSchema = z
  .object({
    /** In words: what the sample is drawn from. A claim is only ever about this. */
    describe: z.string().min(1),
    /**
     * The INDEPENDENT unit (`meta.user`, `meta.recipe`). Rows sharing one are
     * resampled together and land in the same split. Default: `row.unit`, else `row.id`.
     */
    unit: pathSchema.optional(),
    /** All must hold. */
    where: z.array(filterSchema).default([]),
    /**
     * A deterministic split by unit. The author iterates on `dev`; the claim
     * is judged on `holdout`, which it never saw.
     */
    split: z
      .object({
        salt: z.string().min(1),
        holdout: z.number().gt(0).lt(1),
        use: z.enum(["holdout", "dev"]),
      })
      .strict()
      .optional(),
  })
  .strict();

const planSchema = z
  .object({
    /** The smallest effect worth detecting — the distance from the bound that matters. */
    minEffect: z.number().positive().optional(),
    power: z.number().gt(0.5).lt(1).default(0.8),
    /** Per-unit SD of the metric (of the per-pair difference when paired), for planning before data. */
    sd: z.number().positive().optional(),
    /** Expected level of a binary metric (the control's, for a difference), for planning before data. */
    baseline: z.number().min(0).max(1).optional(),
    /** Planned units (per arm when unpaired). A verdict before it is reached is marked `final: false`. */
    n: z.number().int().positive().optional(),
  })
  .strict();

const guardrailSchema = z
  .object({
    name: z.string().min(1),
    metric: metricSpecSchema,
    /** Default: the primary estimand. */
    estimand: estimandSchema.optional(),
    test: testSchema,
    alpha: z.number().gt(0).lt(0.5).optional(),
  })
  .strict();

export const hypothesisSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, "lower-case slug"),
    /** The assertion in one plain sentence. */
    claim: z.string().min(10),
    rationale: z.string().optional(),
    population: populationSchema,
    metric: metricSpecSchema,
    estimand: estimandSchema,
    test: testSchema,
    alpha: z.number().gt(0).lt(0.5).default(0.05),
    /**
     * `auto`: Wilson for a binary level, Newcombe for an unpaired binary
     * difference, Newcombe's paired interval for a paired binary difference,
     * the cluster bootstrap for everything else (and for any clustered sample).
     */
    interval: z.enum(["auto", "wilson", "newcombe", "newcombe_paired", "normal", "bootstrap"]).default("auto"),
    bootstrap: z
      .object({
        resamples: z.number().int().min(200).max(100_000).default(2000),
        /** Default: the hypothesis id. */
        seed: z.string().optional(),
      })
      .strict()
      .prefault({}),
    plan: planSchema.prefault({}),
    guardrails: z.array(guardrailSchema).default([]),
    segments: z.array(z.object({ name: z.string().min(1), by: pathSchema }).strict()).default([]),
  })
  .strict();

export type HypothesisSpec = z.output<typeof hypothesisSpecSchema>;
export type HypothesisSpecInput = z.input<typeof hypothesisSpecSchema>;
export type MetricSpec = z.output<typeof metricSpecSchema>;
export type Estimand = z.output<typeof estimandSchema>;
export type ClaimTest = z.output<typeof testSchema>;
export type IntervalMethod = HypothesisSpec["interval"];

/** What a model authors against. */
export const hypothesisJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(hypothesisSpecSchema, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

export interface CompiledMetric {
  /** `exact_match@1`, or `expr~<hash>`. */
  label: string;
  scope: "row" | "sample";
  binary: boolean;
  needsTruth: boolean;
  direction: MetricDirection;
  observe: (row: ObservationRow) => Observation;
  /** Row scope: one score per row, null = unscorable. */
  scoreRows: (rows: readonly ObservationRow[]) => Promise<Array<number | null>>;
  /** Sample scope: the metric over a set of observations. */
  compute: (os: readonly Observation[]) => number | null;
}

export interface CompiledClaim {
  name: string;
  metric: CompiledMetric;
  estimand: Estimand;
  test: ClaimTest;
  alpha: number;
  interval: IntervalMethod;
}

export interface CompiledHypothesis {
  spec: HypothesisSpec;
  /** Over the spec as parsed (defaults applied) and every metric's parsed args. */
  hash: string;
  primary: CompiledClaim;
  guardrails: CompiledClaim[];
}

export type CompileHypothesisResult =
  | { ok: true; hypothesis: CompiledHypothesis; warnings: string[] }
  | { ok: false; problems: string[]; warnings: string[] };

export interface CompileHypothesisOptions {
  /** Default `BUILTIN_METRICS`. Pass `{ ...BUILTIN_METRICS, ...yours }` to extend. */
  metrics?: MetricRegistry;
  /** Required only for `expr` metrics (`jsonataEngine()` from `@rivers/decision-pipeline/jsonata`). */
  engine?: ExpressionEngine;
}

/** The view every path reads. */
const rowView = (row: ObservationRow): Record<string, unknown> => ({
  id: row.id,
  arm: row.arm,
  unit: row.unit,
  prediction: row.prediction,
  truth: row.truth,
  recordedAt: row.recordedAt,
  meta: row.meta ?? {},
});

const readPath = (row: ObservationRow, path: string): unknown => pickPath(rowView(row), path);

const keyOf = (v: unknown): string => (typeof v === "string" ? v : stableStringify(v));

const EXPR_ROOTS = new Set(["prediction", "truth", "row"]);

const compileMetric = (
  spec: MetricSpec,
  where: string,
  opts: Required<Pick<CompileHypothesisOptions, "metrics">> & CompileHypothesisOptions,
  problems: string[],
): { metric: CompiledMetric; hashable: unknown } | null => {
  const observe = (row: ObservationRow): Observation => ({
    prediction: readPath(row, spec.prediction),
    truth: readPath(row, spec.truth),
    row,
  });

  if (spec.ref !== undefined) {
    const m = opts.metrics[spec.ref] as Metric | undefined;
    if (!m) {
      problems.push(`${where}.ref: unknown metric ${spec.ref} (known: ${Object.keys(opts.metrics).sort().join(", ")})`);
      return null;
    }
    const parsed = m.args.safeParse(spec.args);
    if (!parsed.success) {
      for (const p of zodProblems(parsed.error)) problems.push(`${where}.args.${p}`);
      return null;
    }
    const args = parsed.data;
    const metric: CompiledMetric = {
      label: spec.ref,
      scope: m.scope,
      binary: m.binary,
      needsTruth: m.needsTruth,
      direction: m.direction,
      observe,
      scoreRows: async (rows) =>
        m.scope === "row" ? rows.map((r) => sanitize(m.score(observe(r), args as never))) : rows.map(() => null),
      compute: (os) => (m.scope === "sample" ? sanitize(m.compute(os, args as never)) : null),
    };
    return { metric, hashable: { ref: spec.ref, args, prediction: spec.prediction, truth: spec.truth } };
  }

  // expr
  const source = spec.expr as string;
  if (!opts.engine) {
    problems.push(`${where}.expr: an expression metric needs an ExpressionEngine (pass options.engine)`);
    return null;
  }
  let compiled: CompiledExpression;
  try {
    compiled = opts.engine.compile(source);
  } catch (err) {
    problems.push(`${where}.expr: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const bad = (compiled.roots?.() ?? []).filter((r) => !EXPR_ROOTS.has(r));
  if (bad.length) {
    problems.push(`${where}.expr reads ${bad.join(", ")} — an expression sees only prediction, truth, row`);
    return null;
  }
  // An expression that reads truth cannot score a row whose truth is unknown:
  // JSONata would happily evaluate `x in undefined` to false and count a miss.
  const needsTruth = (compiled.roots?.() ?? []).includes("truth") || /\btruth\b/.test(source);
  const metric: CompiledMetric = {
    label: `expr~${shortHash(source).slice(0, 8)}`,
    scope: "row",
    binary: spec.binary ?? false,
    needsTruth,
    direction: spec.direction ?? "either",
    observe,
    scoreRows: (rows) =>
      Promise.all(
        rows.map(async (r) => {
          const o = observe(r);
          if (needsTruth && (o.truth === undefined || o.truth === null)) return null;
          try {
            const v = await compiled.evaluate({ prediction: o.prediction, truth: o.truth, row: rowView(r) }, {});
            return sanitize(typeof v === "boolean" ? (v ? 1 : 0) : v);
          } catch {
            return null;
          }
        }),
      ),
    compute: () => null,
  };
  return {
    metric,
    hashable: { expr: source, binary: spec.binary ?? false, prediction: spec.prediction, truth: spec.truth },
  };
};

const sanitize = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const checkClaim = (
  claim: CompiledClaim,
  where: string,
  problems: string[],
  warnings: string[],
): void => {
  const { metric, estimand, test, interval } = claim;
  if (metric.scope === "sample" && interval !== "auto" && interval !== "bootstrap") {
    problems.push(`${where}: ${metric.label} is a sample metric — only a bootstrap interval applies`);
  }
  if (interval === "wilson" && !(estimand.kind === "level" && metric.binary)) {
    problems.push(`${where}: wilson needs a binary metric and a level estimand`);
  }
  if (interval === "newcombe" && !(estimand.kind === "difference" && !estimand.paired && metric.binary)) {
    problems.push(`${where}: newcombe needs a binary metric and an UNPAIRED difference`);
  }
  if (interval === "newcombe_paired" && !(estimand.kind === "difference" && estimand.paired && metric.binary && metric.scope === "row")) {
    problems.push(`${where}: newcombe_paired needs a binary row metric and a PAIRED difference`);
  }
  if (metric.binary) {
    const [lo, hi] = estimand.kind === "level" ? [0, 1] : [-1, 1];
    const bounds =
      test.kind === "greater" ? [test.than] : test.kind === "less" ? [test.than] : test.kind === "different" ? [test.from] : [test.around];
    for (const b of bounds) {
      if ((b as number) < lo || (b as number) > hi) {
        problems.push(`${where}.test: bound ${b} is outside [${lo}, ${hi}] for a rate — the claim is decided before any data`);
      }
    }
  }
  const worse =
    (metric.direction === "lower" && test.kind === "greater") || (metric.direction === "higher" && test.kind === "less");
  if (worse && estimand.kind === "difference") {
    warnings.push(
      `${where}: ${metric.label} is ${metric.direction}-is-better, so a "${test.kind}" difference claims the treatment is WORSE — intended?`,
    );
  }
};

/**
 * Parse and check a hypothesis. Never throws: every problem comes back at once
 * so an author can repair them in one round. Warnings do not block.
 */
export const compileHypothesis = (
  input: unknown,
  options: CompileHypothesisOptions = {},
): CompileHypothesisResult => {
  const warnings: string[] = [];
  const parsed = hypothesisSpecSchema.safeParse(input);
  if (!parsed.success) return { ok: false, problems: zodProblems(parsed.error), warnings };
  const spec = parsed.data;
  const opts = { ...options, metrics: options.metrics ?? BUILTIN_METRICS };
  const problems: string[] = [];

  const primaryMetric = compileMetric(spec.metric, "metric", opts, problems);
  const guardrailMetrics = spec.guardrails.map((g, i) => compileMetric(g.metric, `guardrails.${i}.metric`, opts, problems));

  const names = new Set<string>();
  spec.guardrails.forEach((g, i) => {
    if (names.has(g.name)) problems.push(`guardrails.${i}.name: duplicate "${g.name}"`);
    names.add(g.name);
  });
  const segNames = new Set<string>();
  spec.segments.forEach((s, i) => {
    if (segNames.has(s.name)) problems.push(`segments.${i}.name: duplicate "${s.name}"`);
    segNames.add(s.name);
  });

  if (!primaryMetric || guardrailMetrics.some((g) => g === null)) return { ok: false, problems, warnings };

  const primary: CompiledClaim = {
    name: "primary",
    metric: primaryMetric.metric,
    estimand: spec.estimand,
    test: spec.test,
    alpha: spec.alpha,
    interval: spec.interval,
  };
  checkClaim(primary, "primary", problems, warnings);
  const guardrails = spec.guardrails.map((g, i) => {
    const claim: CompiledClaim = {
      name: g.name,
      metric: (guardrailMetrics[i] as { metric: CompiledMetric }).metric,
      estimand: g.estimand ?? spec.estimand,
      test: g.test,
      alpha: g.alpha ?? spec.alpha,
      interval: "auto",
    };
    checkClaim(claim, `guardrails.${i}`, problems, warnings);
    return claim;
  });

  if (spec.plan.baseline !== undefined && !primary.metric.binary) {
    warnings.push("plan.baseline only informs planning for a binary metric; give plan.sd instead");
  }
  if (problems.length) return { ok: false, problems, warnings };

  const hash = shortHash({
    format: HYPOTHESIS_FORMAT,
    spec: { ...spec, metric: undefined, guardrails: spec.guardrails.map((g) => ({ ...g, metric: undefined })) },
    metric: primaryMetric.hashable,
    guardrails: guardrailMetrics.map((g) => (g as { hashable: unknown }).hashable),
  });
  return { ok: true, hypothesis: { spec, hash, primary, guardrails }, warnings };
};

// ---------------------------------------------------------------------------
// Preregistration
// ---------------------------------------------------------------------------

/**
 * Freezes a hypothesis before its data exists. Persist it where the claim's
 * readers will look (the host's job — a Langfuse dataset's metadata, a row).
 */
export interface HypothesisLock {
  hypothesis: string;
  hash: string;
  registered_at: string;
  spec: HypothesisSpec;
}

export const lockHypothesis = (h: CompiledHypothesis, at: Date = new Date()): HypothesisLock => ({
  hypothesis: h.spec.id,
  hash: h.hash,
  registered_at: at.toISOString(),
  spec: h.spec,
});

// ---------------------------------------------------------------------------
// Population
// ---------------------------------------------------------------------------

const unitOf = (row: ObservationRow, path: string | undefined): string => {
  if (path) {
    const v = readPath(row, path);
    return v === undefined || v === null ? row.id : keyOf(v);
  }
  return row.unit ?? row.id;
};

/** Deterministic, by unit — a unit's rows always land on the same side. */
export const splitOf = (unit: string, split: { salt: string; holdout: number }): "holdout" | "dev" =>
  hashToUnit(`${split.salt}:${unit}`) < split.holdout ? "holdout" : "dev";

/** What an author may iterate on (`dev`) vs. what judges it (`holdout`). */
export const partitionRows = (
  spec: Pick<HypothesisSpec, "population">,
  rows: readonly ObservationRow[],
): { dev: ObservationRow[]; holdout: ObservationRow[] } => {
  const split = spec.population.split;
  const out = { dev: [] as ObservationRow[], holdout: [] as ObservationRow[] };
  if (!split) return { dev: [...rows], holdout: [] };
  for (const r of rows) out[splitOf(unitOf(r, spec.population.unit), split)].push(r);
  return out;
};

const passes = (row: ObservationRow, f: HypothesisSpec["population"]["where"][number]): boolean => {
  const v = readPath(row, f.path);
  if (f.exists !== undefined) return (v !== undefined && v !== null) === f.exists;
  if (f.in !== undefined) return f.in.some((x) => keyOf(x) === keyOf(v));
  return keyOf(f.equals) === keyOf(v);
};

// ---------------------------------------------------------------------------
// Evaluate one claim
// ---------------------------------------------------------------------------

export type ClaimStatus = "supported" | "refuted" | "inconclusive";

export interface ClaimResult {
  name: string;
  metric: string;
  status: ClaimStatus;
  /** One plain sentence: which interval, against what, why this status. */
  reason: string;
  estimate: number | null;
  interval: { lo: number; hi: number; confidence: number; method: Exclude<IntervalMethod, "auto"> } | null;
  /** Normal approximation from the interval's implied standard error. The interval decides; this is for readers. */
  pValue: number | null;
  n: {
    /** Rows with a score, per arm. */
    scored: Record<string, number>;
    unscored: number;
    /** Independent units in the analysis (pairs' units when paired). */
    units: number;
    /** Rows of either arm with no partner (paired only). */
    unpaired: number;
  };
  power: {
    se: number | null;
    /** The smallest true effect this sample detects with `plan.power`. */
    detectableEffect: number | null;
    /** Units needed (per arm when unpaired) for `plan.minEffect` — scaled from THIS sample's se. */
    requiredN: number | null;
    underpowered: boolean;
  };
  /** Method-specific extras: McNemar's discordant counts and exact p, undefined bootstrap draws. */
  extra: Record<string, number>;
  warnings: string[];
}

interface Scored {
  row: ObservationRow;
  unit: string;
  score: number | null;
  obs: Observation;
}

const fmt = (x: number): string => (Math.abs(x) >= 100 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(3) : x.toPrecision(3));

const describeTest = (t: ClaimTest): string =>
  t.kind === "greater"
    ? `> ${fmt(t.than)}`
    : t.kind === "less"
      ? `< ${fmt(t.than)}`
      : t.kind === "equivalent"
        ? `within ±${fmt(t.within)} of ${fmt(t.around)}`
        : `≠ ${fmt(t.from)}`;

const decide = (t: ClaimTest, lo: number, hi: number): ClaimStatus => {
  switch (t.kind) {
    case "greater":
      return lo > t.than ? "supported" : hi < t.than ? "refuted" : "inconclusive";
    case "less":
      return hi < t.than ? "supported" : lo > t.than ? "refuted" : "inconclusive";
    case "equivalent": {
      const a = t.around - t.within;
      const b = t.around + t.within;
      return lo > a && hi < b ? "supported" : hi < a || lo > b ? "refuted" : "inconclusive";
    }
    case "different":
      return lo > t.from || hi < t.from ? "supported" : "inconclusive";
  }
};

const pValueFor = (t: ClaimTest, est: number, se: number): number | null => {
  if (!(se > 0)) return null;
  switch (t.kind) {
    case "greater":
      return pUpper((est - t.than) / se);
    case "less":
      return pUpper((t.than - est) / se);
    case "different":
      return Math.min(1, 2 * pUpper(Math.abs(est - t.from) / se));
    case "equivalent":
      return Math.max(pUpper((est - (t.around - t.within)) / se), pUpper((t.around + t.within - est) / se));
  }
};

const groupByUnit = <T>(items: readonly T[], unit: (t: T) => string): T[][] => {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = unit(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return [...m.values()];
};

const distinct = (xs: readonly string[]): number => new Set(xs).size;

interface EvalContext {
  unitPath: string | undefined;
  resamples: number;
  seed: string;
  power: number;
  minEffect: number | undefined;
}

const evaluateClaim = async (
  claim: CompiledClaim,
  rows: readonly ObservationRow[],
  ctx: EvalContext,
): Promise<ClaimResult> => {
  const { metric, estimand, test, alpha } = claim;
  const warnings: string[] = [];
  const confidence = test.kind === "different" ? 1 - alpha : 1 - 2 * alpha;
  const alphaPerSide = test.kind === "different" ? alpha / 2 : alpha;

  const scores = await metric.scoreRows(rows);
  const all: Scored[] = rows.map((row, i) => {
    const obs = metric.observe(row);
    let score = scores[i] ?? null;
    if (metric.scope === "sample") {
      const missing = obs.prediction === undefined || (metric.needsTruth && (obs.truth === undefined || obs.truth === null));
      score = missing ? null : 0; // a placeholder: "this row takes part"
    }
    return { row, unit: unitOf(row, ctx.unitPath), score, obs };
  });
  const usable = all.filter((s) => s.score !== null);
  const unscored = all.length - usable.length;
  if (unscored > 0) warnings.push(`${unscored} row(s) could not be scored by ${metric.label} and were left out`);

  const stat = (items: readonly Scored[]): number | null => {
    if (items.length === 0) return null;
    return metric.scope === "row" ? mean(items.map((s) => s.score as number)) : metric.compute(items.map((s) => s.obs));
  };

  const base = {
    name: claim.name,
    metric: metric.label,
    extra: {} as Record<string, number>,
    warnings,
  };
  const empty = (reason: string, scored: Record<string, number>, units: number, unpaired = 0): ClaimResult => ({
    ...base,
    status: "inconclusive",
    reason,
    estimate: null,
    interval: null,
    pValue: null,
    n: { scored, unscored, units, unpaired },
    power: { se: null, detectableEffect: null, requiredN: null, underpowered: true },
  });

  // --- shape the sample ------------------------------------------------------
  type Shape =
    | { kind: "level"; items: Scored[] }
    | { kind: "unpaired"; t: Scored[]; c: Scored[] }
    | { kind: "paired"; pairs: Array<{ t: Scored; c: Scored; unit: string }> };

  let shape: Shape;
  let scored: Record<string, number>;
  let units: number;
  let unpaired = 0;

  if (estimand.kind === "level") {
    const items = estimand.arm === undefined ? usable : usable.filter((s) => s.row.arm === estimand.arm);
    if (estimand.arm === undefined) {
      const arms = distinct(usable.map((s) => s.row.arm ?? ""));
      if (arms > 1) warnings.push(`a level estimand with no arm pooled ${arms} arms`);
    }
    shape = { kind: "level", items };
    scored = { [estimand.arm ?? "all"]: items.length };
    units = distinct(items.map((s) => s.unit));
  } else if (!estimand.paired) {
    const t = usable.filter((s) => s.row.arm === estimand.treatment);
    const c = usable.filter((s) => s.row.arm === estimand.control);
    shape = { kind: "unpaired", t, c };
    scored = { [estimand.treatment]: t.length, [estimand.control]: c.length };
    units = Math.min(distinct(t.map((s) => s.unit)), distinct(c.map((s) => s.unit)));
  } else {
    const byId = (arm: string) => {
      const m = new Map<string, Scored>();
      let dup = 0;
      for (const s of usable) {
        if (s.row.arm !== arm) continue;
        if (m.has(s.row.id)) dup++;
        else m.set(s.row.id, s);
      }
      if (dup) warnings.push(`${dup} duplicate id(s) in arm ${arm}; the first of each was paired`);
      return m;
    };
    const t = byId(estimand.treatment);
    const c = byId(estimand.control);
    const pairs: Array<{ t: Scored; c: Scored; unit: string }> = [];
    for (const [id, ts] of t) {
      const cs = c.get(id);
      if (cs) pairs.push({ t: ts, c: cs, unit: ts.unit });
    }
    unpaired = t.size + c.size - 2 * pairs.length;
    if (unpaired) warnings.push(`${unpaired} row(s) had no partner in the other arm and were left out`);
    shape = { kind: "paired", pairs };
    scored = { [estimand.treatment]: pairs.length, [estimand.control]: pairs.length };
    units = distinct(pairs.map((p) => p.unit));
  }

  if (units < 2) return empty(`not enough data: ${units} independent unit(s)`, scored, units, unpaired);

  // --- the point estimate -------------------------------------------------------
  const estimate =
    shape.kind === "level"
      ? stat(shape.items)
      : shape.kind === "unpaired"
        ? diff(stat(shape.t), stat(shape.c))
        : metric.scope === "row"
          ? mean(shape.pairs.map((p) => (p.t.score as number) - (p.c.score as number)))
          : diff(stat(shape.pairs.map((p) => p.t)), stat(shape.pairs.map((p) => p.c)));
  if (estimate === null) return empty(`${metric.label} is undefined on this sample`, scored, units, unpaired);

  // --- the method -------------------------------------------------------------
  const rowCount = shape.kind === "level" ? shape.items.length : shape.kind === "unpaired" ? shape.t.length + shape.c.length : shape.pairs.length;
  const clustered =
    shape.kind === "unpaired"
      ? distinct(shape.t.map((s) => s.unit)) < shape.t.length || distinct(shape.c.map((s) => s.unit)) < shape.c.length
      : units < rowCount;
  let method: Exclude<IntervalMethod, "auto">;
  if (claim.interval !== "auto") method = claim.interval;
  else if (metric.scope === "sample" || !metric.binary || clustered) method = "bootstrap";
  else method = shape.kind === "level" ? "wilson" : shape.kind === "unpaired" ? "newcombe" : "newcombe_paired";
  if ((method === "wilson" || method === "newcombe" || method === "newcombe_paired") && clustered) {
    warnings.push(`${method} assumes independent rows, but ${rowCount} rows share ${units} units — the interval is too narrow`);
  }

  let lo: number;
  let hi: number;
  const z = zFor(confidence);

  if (method === "wilson" && shape.kind === "level") {
    const x = shape.items.reduce((s, i) => s + (i.score as number), 0);
    ({ lo, hi } = wilsonInterval(x, shape.items.length, confidence));
  } else if (method === "newcombe" && shape.kind === "unpaired") {
    const x1 = shape.t.reduce((s, i) => s + (i.score as number), 0);
    const x2 = shape.c.reduce((s, i) => s + (i.score as number), 0);
    ({ lo, hi } = newcombeInterval(x1, shape.t.length, x2, shape.c.length, confidence));
  } else if (method === "newcombe_paired" && shape.kind === "paired") {
    const cell = { a: 0, b: 0, c: 0, d: 0 };
    for (const p of shape.pairs) cell[p.t.score === 1 ? (p.c.score === 1 ? "a" : "b") : p.c.score === 1 ? "c" : "d"]++;
    ({ lo, hi } = newcombePairedInterval(cell.a, cell.b, cell.c, cell.d, confidence));
  } else if (method === "normal") {
    const se = normalSe(shape);
    if (!Number.isFinite(se)) return empty("not enough independent units for a standard error", scored, units, unpaired);
    lo = estimate - z * se;
    hi = estimate + z * se;
    if (units < 30) warnings.push(`normal interval on ${units} units — the bootstrap or a t-interval would be safer`);
  } else {
    method = "bootstrap";
    const random = seededRandom(`${ctx.seed}:${claim.name}`);
    const boot =
      shape.kind === "level"
        ? clusterBootstrap([groupByUnit(shape.items, (s) => s.unit)], ([a]) => stat(a as Scored[]), {
            resamples: ctx.resamples,
            random,
          })
        : shape.kind === "unpaired"
          ? clusterBootstrap(
              [groupByUnit(shape.t, (s) => s.unit), groupByUnit(shape.c, (s) => s.unit)],
              ([a, b]) => diff(stat(a as Scored[]), stat(b as Scored[])),
              { resamples: ctx.resamples, random },
            )
          : clusterBootstrap(
              [groupByUnit(shape.pairs, (p) => p.unit)],
              ([ps]) => {
                const pairs = ps as typeof shape.pairs;
                return metric.scope === "row"
                  ? mean(pairs.map((p) => (p.t.score as number) - (p.c.score as number)))
                  : diff(stat(pairs.map((p) => p.t)), stat(pairs.map((p) => p.c)));
              },
              { resamples: ctx.resamples, random },
            );
    if (boot.draws.length < ctx.resamples / 2) {
      return empty(`${metric.label} was undefined on most bootstrap resamples`, scored, units, unpaired);
    }
    if (boot.undefinedDraws > 0) {
      base.extra.bootstrap_undefined = boot.undefinedDraws;
      if (boot.undefinedDraws > ctx.resamples * 0.05) {
        warnings.push(`${boot.undefinedDraws}/${ctx.resamples} resamples left ${metric.label} undefined — the interval is conditional on the rest`);
      }
    }
    ({ lo, hi } = percentileInterval(boot.draws, confidence));
    if (hi - lo === 0) {
      warnings.push(
        "the bootstrap interval has zero width — the sample shows no variation, which understates the uncertainty (collect more, or use wilson for a rate)",
      );
    }
    if (units < 20) warnings.push(`bootstrap on ${units} units — percentile intervals run narrow below ~20`);
  }

  if (shape.kind === "paired" && metric.binary && metric.scope === "row") {
    let b = 0;
    let c = 0;
    for (const p of shape.pairs) {
      if (p.t.score === 1 && p.c.score === 0) b++;
      else if (p.t.score === 0 && p.c.score === 1) c++;
    }
    base.extra.mcnemar_only_treatment = b;
    base.extra.mcnemar_only_control = c;
    base.extra.mcnemar_p = mcnemarExact(b, c);
  }

  // --- verdict + power ----------------------------------------------------------
  const status = decide(test, lo, hi);
  const se = (hi - lo) / (2 * z);
  const detectable = se > 0 ? detectableEffect(se, alphaPerSide, ctx.power) : null;
  const minEffect = ctx.minEffect ?? (test.kind === "equivalent" ? test.within : undefined);
  const nNow = units;
  const requiredN =
    minEffect !== undefined && detectable !== null ? Math.ceil(nNow * (detectable / minEffect) ** 2) : null;
  const underpowered = status === "inconclusive" && (requiredN === null ? true : nNow < requiredN);

  const pct = `${Math.round(confidence * 1000) / 10}%`;
  const where = `${pct} ${method} interval [${fmt(lo)}, ${fmt(hi)}] (n=${nNow} units)`;
  const reason =
    status === "supported"
      ? `${where} lies entirely ${describeTest(test)}`
      : status === "refuted"
        ? `${where} lies entirely outside ${describeTest(test)}`
        : `${where} straddles ${describeTest(test)}` +
          (requiredN !== null && nNow < requiredN
            ? ` — about ${requiredN} units would detect an effect of ${fmt(minEffect as number)}`
            : test.kind === "different"
              ? " — to claim NO difference, test equivalence"
              : "");

  return {
    ...base,
    status,
    reason,
    estimate,
    interval: { lo, hi, confidence, method },
    pValue: pValueFor(test, estimate, se),
    n: { scored, unscored, units, unpaired },
    power: { se, detectableEffect: detectable, requiredN, underpowered },
  };

  function normalSe(s: Shape): number {
    if (s.kind === "level") {
      return clusterRobustSe(
        s.items.map((i) => i.score as number),
        s.items.map((i) => i.unit),
      );
    }
    if (s.kind === "unpaired") {
      const a = clusterRobustSe(s.t.map((i) => i.score as number), s.t.map((i) => i.unit));
      const b = clusterRobustSe(s.c.map((i) => i.score as number), s.c.map((i) => i.unit));
      return Math.sqrt(a * a + b * b);
    }
    return clusterRobustSe(
      s.pairs.map((p) => (p.t.score as number) - (p.c.score as number)),
      s.pairs.map((p) => p.unit),
    );
  }
};

const diff = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a - b);

// ---------------------------------------------------------------------------
// Evaluate a hypothesis
// ---------------------------------------------------------------------------

export type HypothesisStatus = ClaimStatus | "invalid";

export interface HypothesisVerdict {
  hypothesis: string;
  hash: string;
  claim: string;
  status: HypothesisStatus;
  reason: string;
  /** Locked before the data it was judged on. False = exploratory, whatever it says. */
  preregistered: boolean;
  /** False while `plan.n` has not been reached: this read is a peek. */
  final: boolean;
  primary: ClaimResult | null;
  guardrails: ClaimResult[];
  /** Preregistered breakdowns. Descriptive: never multiplicity-corrected, never a rescue. */
  segments: Array<{ name: string; value: string; result: ClaimResult }>;
  excluded: { beforeLock: number; filtered: number; outsideSplit: number };
  /** Rows with no `recordedAt` — kept, but the lock cannot vouch for them. */
  undated: number;
  warnings: string[];
  stats_version: string;
  evaluated_at: string;
}

export interface EvaluateHypothesisOptions {
  /** The lock taken before collection. Without it the verdict is exploratory. */
  lock?: HypothesisLock;
  now?: Date;
}

export const evaluateHypothesis = async (
  h: CompiledHypothesis,
  rows: readonly ObservationRow[],
  opts: EvaluateHypothesisOptions = {},
): Promise<HypothesisVerdict> => {
  const { spec } = h;
  const now = (opts.now ?? new Date()).toISOString();
  const warnings: string[] = [];
  const verdict = (partial: Partial<HypothesisVerdict> & Pick<HypothesisVerdict, "status" | "reason">): HypothesisVerdict => ({
    hypothesis: spec.id,
    hash: h.hash,
    claim: spec.claim,
    preregistered: opts.lock !== undefined,
    final: true,
    primary: null,
    guardrails: [],
    segments: [],
    excluded: { beforeLock: 0, filtered: 0, outsideSplit: 0 },
    undated: 0,
    warnings,
    stats_version: STATS_VERSION,
    evaluated_at: now,
    ...partial,
  });

  if (opts.lock && opts.lock.hash !== h.hash) {
    return verdict({
      status: "invalid",
      reason: `the hypothesis changed after it was locked (locked ${opts.lock.hash}, now ${h.hash}) — lock the new version and collect fresh data`,
      preregistered: false,
    });
  }
  if (!opts.lock) warnings.push("no lock: this verdict is EXPLORATORY — lock the hypothesis before collecting data to make it confirmatory");

  // --- population ---------------------------------------------------------------
  const excluded = { beforeLock: 0, filtered: 0, outsideSplit: 0 };
  let undated = 0;
  const lockedAt = opts.lock ? Date.parse(opts.lock.registered_at) : null;
  const population: ObservationRow[] = [];
  for (const row of rows) {
    if (lockedAt !== null) {
      if (!row.recordedAt) undated++;
      else if (Date.parse(row.recordedAt) < lockedAt) {
        excluded.beforeLock++;
        continue;
      }
    }
    if (!spec.population.where.every((f) => passes(row, f))) {
      excluded.filtered++;
      continue;
    }
    const split = spec.population.split;
    if (split && splitOf(unitOf(row, spec.population.unit), split) !== split.use) {
      excluded.outsideSplit++;
      continue;
    }
    population.push(row);
  }
  if (undated) warnings.push(`${undated} row(s) carry no recordedAt — the lock cannot vouch that they came after it`);
  if (excluded.beforeLock) warnings.push(`${excluded.beforeLock} row(s) predate the lock and were left out`);
  if (spec.population.split?.use === "dev") warnings.push("judged on the DEV split — fine for iterating, never for the confirmatory verdict");

  const ctx: EvalContext = {
    unitPath: spec.population.unit,
    resamples: spec.bootstrap.resamples,
    seed: spec.bootstrap.seed ?? spec.id,
    power: spec.plan.power,
    minEffect: spec.plan.minEffect,
  };

  const primary = await evaluateClaim(h.primary, population, ctx);
  const guardrails: ClaimResult[] = [];
  for (const g of h.guardrails) guardrails.push(await evaluateClaim(g, population, { ...ctx, minEffect: undefined }));

  const segments: HypothesisVerdict["segments"] = [];
  for (const seg of spec.segments) {
    const groups = new Map<string, ObservationRow[]>();
    for (const r of population) {
      const v = readPath(r, seg.by);
      const k = v === undefined || v === null ? "(none)" : keyOf(v);
      const list = groups.get(k);
      if (list) list.push(r);
      else groups.set(k, [r]);
    }
    for (const [value, members] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const result = await evaluateClaim({ ...h.primary, name: `segment:${seg.name}=${value}` }, members, ctx);
      segments.push({ name: seg.name, value, result });
    }
  }

  const final = spec.plan.n === undefined || primary.n.units >= spec.plan.n;
  if (!final) warnings.push(`${primary.n.units} of ${spec.plan.n} planned units — a verdict before the plan is reached is a peek`);

  let status: HypothesisStatus = primary.status;
  let reason = primary.reason;
  if (primary.status === "supported") {
    const failed = guardrails.find((g) => g.status === "refuted");
    const open = guardrails.find((g) => g.status === "inconclusive");
    if (failed) {
      status = "refuted";
      reason = `primary held (${primary.reason}), but guardrail "${failed.name}" failed: ${failed.reason}`;
    } else if (open) {
      status = "inconclusive";
      reason = `primary held (${primary.reason}), but guardrail "${open.name}" is unproven: ${open.reason}`;
    }
  }

  return verdict({ status, reason, final, primary, guardrails, segments, excluded, undated });
};

// ---------------------------------------------------------------------------
// Planning — before any data
// ---------------------------------------------------------------------------

export interface HypothesisPlan {
  /** Units (per arm for an unpaired difference) the plan needs, or null when it cannot say. */
  requiredN: number | null;
  design: SampleDesign;
  /** What the number assumed, so a reader can dispute it. */
  assumptions: string[];
}

/**
 * How much data the claim needs, from `plan` alone. Needs `plan.minEffect`
 * plus `plan.sd` — or, for a binary metric, `plan.baseline`.
 */
export const planHypothesis = (h: CompiledHypothesis): HypothesisPlan => {
  const { spec, primary } = h;
  const design: SampleDesign =
    primary.estimand.kind === "level" ? "one-sample" : primary.estimand.paired ? "paired" : "two-sample";
  const assumptions: string[] = [];
  const effect = spec.plan.minEffect ?? (spec.test.kind === "equivalent" ? spec.test.within : undefined);
  if (effect === undefined) return { requiredN: null, design, assumptions: ["no plan.minEffect"] };
  let sd = spec.plan.sd;
  if (sd === undefined && primary.metric.binary && spec.plan.baseline !== undefined) {
    const p = spec.plan.baseline;
    sd = design === "paired" ? Math.sqrt(2 * p * (1 - p)) : Math.sqrt(p * (1 - p));
    assumptions.push(
      design === "paired"
        ? `sd of the paired difference ≈ √(2p(1−p)) at baseline ${p} — the worst case, uncorrelated arms`
        : `sd ≈ √(p(1−p)) at baseline ${p}`,
    );
  }
  if (sd === undefined) return { requiredN: null, design, assumptions: ["no plan.sd (or plan.baseline for a binary metric)"] };
  const alphaPerSide = spec.test.kind === "different" ? spec.alpha / 2 : spec.alpha;
  assumptions.push(`normal approximation; α=${spec.alpha} (${alphaPerSide} per side), power ${spec.plan.power}, effect ${effect}, sd ${sd}`);
  return { requiredN: requiredSampleSize({ sd, effect, alphaPerSide, power: spec.plan.power, design }), design, assumptions };
};

// ---------------------------------------------------------------------------
// From pipeline runs
// ---------------------------------------------------------------------------

/** One run as an observation. `meta` carries what guardrails and segments usually read. */
export const observationFromRun = (
  run: { output: unknown; record: RunRecord },
  opts: { arm?: string; truth?: unknown; id?: string; unit?: string } = {},
): ObservationRow => {
  const r = run.record;
  return {
    id: opts.id ?? r.input_hash,
    ...(opts.arm !== undefined ? { arm: opts.arm } : {}),
    ...(opts.unit !== undefined ? { unit: opts.unit } : {}),
    prediction: run.output,
    ...(opts.truth !== undefined ? { truth: opts.truth } : {}),
    recordedAt: r.created_at,
    meta: {
      route: r.fact_route,
      confidence: r.fact_confidence,
      cost_usd: r.cost_usd,
      ms: r.ms,
      version: r.version,
      run_key: r.run_key,
      user: r.user,
      tenant: r.tenant,
      group: r.group,
      arms: r.arms,
      features: r.features,
    },
  };
};

/** A shadow run as a PAIR: one row per side, sharing the champion's id. */
export const observationsFromShadow = (
  shadow: ShadowResult<unknown>,
  opts: { truth?: unknown; id?: string; unit?: string; champion?: string; challenger?: string } = {},
): ObservationRow[] => {
  const id = opts.id ?? shadow.champion.record.input_hash;
  const common = { id, truth: opts.truth, unit: opts.unit };
  const rows = [observationFromRun(shadow.champion, { ...common, arm: opts.champion ?? "champion" })];
  if (shadow.challenger) rows.push(observationFromRun(shadow.challenger, { ...common, arm: opts.challenger ?? "challenger" }));
  return rows;
};

