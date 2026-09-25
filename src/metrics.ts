/**
 * Metrics — what a hypothesis MEASURES, one registered function per idea,
 * referenced `id@version` exactly like a spec primitive.
 *
 * The trick that makes one verdict engine serve every kind of prediction is
 * that almost any prediction task reduces to a per-row number:
 *
 *   classification   exact_match · top_k            (0/1 per row)
 *   probabilistic    log_loss · brier · prob_of_truth · crps_gaussian
 *   ranking          reciprocal_rank · ndcg_at_k · hit_at_k · average_precision · kendall_tau
 *   sets             jaccard · set_f1 · set_exact
 *   regression       abs_error · squared_error · log_ratio_error · within_tolerance · signed_error
 *   intervals        interval_covers · interval_width · interval_score · pinball
 *   generic          value · truthy · equals        (cost, latency, a route, a human score)
 *
 * A handful of ideas are NOT a mean of per-row numbers — AUC, calibration
 * error, kappa, correlation, macro-F1. Those are `sample` metrics: computed
 * over the whole sample, and always given a bootstrap interval.
 *
 * Anything not listed is either a host-registered metric (`defineMetric`) or a
 * `expr` metric in the hypothesis itself — which is how an LLM author covers
 * the problem nobody thought of without anyone writing TypeScript.
 */

import { z, type ZodType } from "zod";
import { stableStringify } from "./hash";
import { mean, normalCdf } from "./stats";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One observation: what was predicted, and (when known) what was true. The
 * verdict engine knows nothing about pipelines — `observationFromRun` builds
 * these from a `RunResult`, but any source works.
 */
export interface ObservationRow {
  /** The ITEM. Rows of two arms with the same id are a pair. */
  id: string;
  /** Which arm produced the prediction. Absent = a single-arm sample. */
  arm?: string;
  /**
   * The independent unit this row belongs to (a user, a recipe) — rows sharing
   * one are resampled together. Defaults to `id`. A hypothesis may instead name
   * a path (`population.unit`).
   */
  unit?: string;
  prediction: unknown;
  /** Ground truth, a human label, a reference answer. Absent = not yet known. */
  truth?: unknown;
  /** ISO time the prediction was made — what the preregistration check reads. */
  recordedAt?: string;
  /** Anything else a filter, segment, or `value` metric may read (cost, route, lang). */
  meta?: Record<string, unknown>;
}

/** What a metric function sees: the picked prediction and truth, plus the row. */
export interface Observation {
  prediction: unknown;
  truth: unknown;
  row: ObservationRow;
}

/** `a.b.0.c` into nested objects / arrays. An empty path is the value itself. */
export const pickPath = (value: unknown, path: string | undefined): unknown => {
  if (!path) return value;
  let cur: unknown = value;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
};

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

export type MetricTask =
  | "classification"
  | "probabilistic"
  | "ranking"
  | "set"
  | "regression"
  | "interval"
  | "agreement"
  | "generic";

/** Which way is better — so an author can tell whether to claim `greater` or `less`. */
export type MetricDirection = "higher" | "lower" | "target" | "either";

interface MetricBase<A> {
  /** Dotted, lower_snake: `ndcg_at_k`. Referenced as `id@version`. */
  id: string;
  version: string;
  /** One or two sentences, for the catalog a model reads. */
  describe: string;
  task: MetricTask;
  direction: MetricDirection;
  /** Row scores are always 0/1 — unlocks Wilson / Newcombe / McNemar. */
  binary: boolean;
  /** False when the metric reads only the prediction (cost, width, a route). */
  needsTruth: boolean;
  args: ZodType<A>;
}

export interface RowMetric<A = unknown> extends MetricBase<A> {
  scope: "row";
  /** null = this row cannot be scored (missing or malformed); it is counted, not guessed. */
  score: (o: Observation, args: A) => number | null;
}

export interface SampleMetric<A = unknown> extends MetricBase<A> {
  scope: "sample";
  compute: (os: readonly Observation[], args: A) => number | null;
}

export type Metric<A = unknown> = RowMetric<A> | SampleMetric<A>;

export const defineMetric = <A>(m: Metric<A>): Metric<A> => m;

export const metricRef = (m: Pick<Metric, "id" | "version">): string => `${m.id}@${m.version}`;

export type MetricRegistry = Readonly<Record<string, Metric>>;

/** Keyed `id@version`. Later metrics win, so a host can override a built-in's version. */
// `any`: a registry is heterogeneous in its args type by definition, and a
// ZodType is not contravariant, so `Metric<never>` cannot stand in for it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const metricRegistry = (...metrics: ReadonlyArray<Metric<any>>): MetricRegistry => {
  const out: Record<string, Metric> = {};
  for (const m of metrics) out[metricRef(m)] = m as unknown as Metric;
  return out;
};

/** The catalog a model authors against: every metric with its args as JSON Schema. */
export const metricCatalog = (registry: MetricRegistry) =>
  Object.entries(registry).map(([ref, m]) => ({
    ref,
    describe: m.describe,
    task: m.task,
    scope: m.scope,
    direction: m.direction,
    binary: m.binary,
    needsTruth: m.needsTruth,
    args: z.toJSONSchema(m.args, { unrepresentable: "any" }),
  }));

// ---------------------------------------------------------------------------
// Coercions — lenient in, null out
// ---------------------------------------------------------------------------

const keyOf = (v: unknown): string => (typeof v === "string" ? v : stableStringify(v));

const asNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const asBinary = (v: unknown): 0 | 1 | null => {
  if (v === true || v === 1) return 1;
  if (v === false || v === 0) return 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(s)) return 1;
    if (["0", "false", "no", "n"].includes(s)) return 0;
  }
  return null;
};

/** A list of item keys, in order. A bare scalar is a list of one. */
const asKeys = (v: unknown): string[] | null => {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(keyOf);
  if (v instanceof Set) return [...v].map(keyOf);
  if (typeof v === "object") return null;
  return [keyOf(v)];
};

/** `{ label: p }` — also accepts `[{ label, p }]`. */
const asProbMap = (v: unknown): Map<string, number> | null => {
  if (Array.isArray(v)) {
    const m = new Map<string, number>();
    for (const e of v) {
      if (!e || typeof e !== "object") return null;
      const { label, p } = e as { label?: unknown; p?: unknown };
      const n = asNumber(p);
      if (label === undefined || n === null) return null;
      m.set(keyOf(label), n);
    }
    return m;
  }
  if (v && typeof v === "object") {
    const m = new Map<string, number>();
    for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
      const n = asNumber(p);
      if (n === null) return null;
      m.set(k, n);
    }
    return m;
  }
  return null;
};

/** A ranked list from either a list or a probability map (sorted by p, then label). */
const asRanking = (v: unknown): string[] | null => {
  if (Array.isArray(v)) return v.map(keyOf);
  const m = asProbMap(v);
  if (!m) return null;
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
};

/** Relevance: a single item, a list of items (gain 1), or `{ item: gain }`. */
const asGains = (v: unknown): Map<string, number> | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !Array.isArray(v) && !(v instanceof Set)) return asProbMap(v);
  const keys = asKeys(v);
  return keys ? new Map(keys.map((k) => [k, 1])) : null;
};

/** P(truth) under the prediction: a number is P(true) of a binary outcome; a map is per label. */
const probOfTruth = (prediction: unknown, truth: unknown): number | null => {
  const p = asNumber(prediction);
  if (p !== null && typeof prediction !== "boolean") {
    const y = asBinary(truth);
    return y === null ? null : y === 1 ? p : 1 - p;
  }
  const m = asProbMap(prediction);
  if (!m || truth === undefined || truth === null) return null;
  return m.get(keyOf(truth)) ?? 0;
};

const pairNumbers = (os: readonly Observation[]): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (const o of os) {
    const p = asNumber(o.prediction);
    const t = asNumber(o.truth);
    if (p !== null && t !== null) out.push([p, t]);
  }
  return out;
};

const averageRanks = (xs: readonly number[]): number[] => {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && (idx[j + 1] as readonly [number, number])[0] === (idx[i] as readonly [number, number])[0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[(idx[k] as readonly [number, number])[1]] = r;
    i = j + 1;
  }
  return ranks;
};

const pearson = (pairs: ReadonlyArray<readonly [number, number]>): number | null => {
  if (pairs.length < 3) return null;
  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
};

// ---------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------

const none = z.object({}).strict();
const kArg = z.object({ k: z.number().int().min(1) }).strict();
const optionalK = z.object({ k: z.number().int().min(1).optional() }).strict();

const exactMatch = defineMetric({
  id: "exact_match",
  version: "1",
  describe: "1 when the prediction equals the truth (strings trimmed; optionally case-insensitive), else 0. Accuracy, as a mean.",
  task: "classification",
  direction: "higher",
  binary: true,
  needsTruth: true,
  scope: "row",
  args: z.object({ caseInsensitive: z.boolean().default(false) }).strict(),
  score: ({ prediction, truth }, { caseInsensitive }) => {
    if (prediction === undefined || truth === undefined || truth === null) return null;
    const norm = (v: unknown) => {
      if (typeof v !== "string") return keyOf(v);
      const s = v.trim();
      return caseInsensitive ? s.toLowerCase() : s;
    };
    return norm(prediction) === norm(truth) ? 1 : 0;
  },
});

const topK = defineMetric({
  id: "top_k",
  version: "1",
  describe: "1 when the truth is among the first k of a ranked list or the k most probable labels of a probability map.",
  task: "classification",
  direction: "higher",
  binary: true,
  needsTruth: true,
  scope: "row",
  args: kArg,
  score: ({ prediction, truth }, { k }) => {
    const ranked = asRanking(prediction);
    if (!ranked || truth === undefined || truth === null) return null;
    return ranked.slice(0, k).includes(keyOf(truth)) ? 1 : 0;
  },
});

const logLoss = defineMetric({
  id: "log_loss",
  version: "1",
  describe: "−ln P(truth). Prediction is P(true) for a binary truth, or a {label: p} map. Clamped at eps. Lower is better.",
  task: "probabilistic",
  direction: "lower",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: z.object({ eps: z.number().positive().max(0.1).default(1e-15) }).strict(),
  score: ({ prediction, truth }, { eps }) => {
    const p = probOfTruth(prediction, truth);
    return p === null ? null : -Math.log(Math.min(1 - eps, Math.max(eps, p)));
  },
});

const brier = defineMetric({
  id: "brier",
  version: "1",
  describe: "Squared probability error: (p − y)² for P(true), or Σ over labels of (p_label − 1[label = truth])² for a map. Lower is better.",
  task: "probabilistic",
  direction: "lower",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: none,
  score: ({ prediction, truth }) => {
    const p = asNumber(prediction);
    if (p !== null && typeof prediction !== "boolean") {
      const y = asBinary(truth);
      return y === null ? null : (p - y) ** 2;
    }
    const m = asProbMap(prediction);
    if (!m || truth === undefined || truth === null) return null;
    const t = keyOf(truth);
    let s = m.has(t) ? 0 : 1;
    for (const [k, q] of m) s += (q - (k === t ? 1 : 0)) ** 2;
    return s;
  },
});

const probTruth = defineMetric({
  id: "prob_of_truth",
  version: "1",
  describe: "The probability the prediction assigned to what turned out true. Higher is better.",
  task: "probabilistic",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: none,
  score: ({ prediction, truth }) => probOfTruth(prediction, truth),
});

const crpsGaussian = defineMetric({
  id: "crps_gaussian",
  version: "1",
  describe: "Continuous ranked probability score of a Gaussian forecast {mean, sd} against a numeric truth. Lower is better; equals abs error when sd → 0.",
  task: "probabilistic",
  direction: "lower",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: none,
  score: ({ prediction, truth }) => {
    const mu = asNumber(pickPath(prediction, "mean"));
    const sd = asNumber(pickPath(prediction, "sd"));
    const t = asNumber(truth);
    if (mu === null || sd === null || t === null || sd < 0) return null;
    if (sd === 0) return Math.abs(t - mu);
    const z = (t - mu) / sd;
    const pdf = Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);
    return sd * (z * (2 * normalCdf(z) - 1) + 2 * pdf - 1 / Math.sqrt(Math.PI));
  },
});

const reciprocalRank = defineMetric({
  id: "reciprocal_rank",
  version: "1",
  describe: "1 / (position of the first relevant item) in a ranked prediction, 0 if none in the first k. Truth: an item, a list, or {item: gain}. MRR, as a mean.",
  task: "ranking",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: optionalK,
  score: ({ prediction, truth }, { k }) => {
    const ranked = asRanking(prediction);
    const gains = asGains(truth);
    if (!ranked || !gains) return null;
    const top = k === undefined ? ranked : ranked.slice(0, k);
    const i = top.findIndex((item) => (gains.get(item) ?? 0) > 0);
    return i < 0 ? 0 : 1 / (i + 1);
  },
});

const hitAtK = defineMetric({
  id: "hit_at_k",
  version: "1",
  describe: "1 when any relevant item appears in the first k of the ranking.",
  task: "ranking",
  direction: "higher",
  binary: true,
  needsTruth: true,
  scope: "row",
  args: kArg,
  score: ({ prediction, truth }, { k }) => {
    const ranked = asRanking(prediction);
    const gains = asGains(truth);
    if (!ranked || !gains) return null;
    return ranked.slice(0, k).some((item) => (gains.get(item) ?? 0) > 0) ? 1 : 0;
  },
});

const precisionAtK = defineMetric({
  id: "precision_at_k",
  version: "1",
  describe: "Relevant items in the first k, divided by k.",
  task: "ranking",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: kArg,
  score: ({ prediction, truth }, { k }) => {
    const ranked = asRanking(prediction);
    const gains = asGains(truth);
    if (!ranked || !gains) return null;
    return ranked.slice(0, k).filter((item) => (gains.get(item) ?? 0) > 0).length / k;
  },
});

const recallAtK = defineMetric({
  id: "recall_at_k",
  version: "1",
  describe: "Relevant items in the first k, divided by all relevant items. Unscored when nothing is relevant.",
  task: "ranking",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: kArg,
  score: ({ prediction, truth }, { k }) => {
    const ranked = asRanking(prediction);
    const gains = asGains(truth);
    if (!ranked || !gains) return null;
    const relevant = [...gains.values()].filter((g) => g > 0).length;
    if (relevant === 0) return null;
    return ranked.slice(0, k).filter((item) => (gains.get(item) ?? 0) > 0).length / relevant;
  },
});

const averagePrecision = defineMetric({
  id: "average_precision",
  version: "1",
  describe: "Mean of precision@i over the positions i of relevant items (within the first k if given). MAP, as a mean.",
  task: "ranking",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: optionalK,
  score: ({ prediction, truth }, { k }) => {
    const ranked = asRanking(prediction);
    const gains = asGains(truth);
    if (!ranked || !gains) return null;
    const relevant = [...gains.values()].filter((g) => g > 0).length;
    if (relevant === 0) return null;
    const top = k === undefined ? ranked : ranked.slice(0, k);
    let hits = 0;
    let s = 0;
    top.forEach((item, i) => {
      if ((gains.get(item) ?? 0) > 0) {
        hits++;
        s += hits / (i + 1);
      }
    });
    return s / Math.min(relevant, top.length || relevant);
  },
});

const ndcgAtK = defineMetric({
  id: "ndcg_at_k",
  version: "1",
  describe: "Normalised discounted cumulative gain over the first k. Truth: relevant items (gain 1) or {item: gain} for graded relevance.",
  task: "ranking",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: kArg,
  score: ({ prediction, truth }, { k }) => {
    const ranked = asRanking(prediction);
    const gains = asGains(truth);
    if (!ranked || !gains) return null;
    const dcg = (gs: number[]) => gs.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
    const ideal = dcg([...gains.values()].filter((g) => g > 0).sort((a, b) => b - a).slice(0, k));
    if (ideal === 0) return null;
    return dcg(ranked.slice(0, k).map((item) => gains.get(item) ?? 0)) / ideal;
  },
});

const kendallTau = defineMetric({
  id: "kendall_tau",
  version: "1",
  describe: "Kendall's tau-a between the predicted and the true ORDER of the items both lists contain (−1 reversed … 1 identical).",
  task: "ranking",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: none,
  score: ({ prediction, truth }) => {
    const p = asRanking(prediction);
    const t = asKeys(truth);
    if (!p || !t) return null;
    const pos = new Map(t.map((k, i) => [k, i]));
    const common = p.filter((k) => pos.has(k));
    const n = common.length;
    if (n < 2) return null;
    let s = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        s += Math.sign((pos.get(common[j] as string) as number) - (pos.get(common[i] as string) as number));
      }
    }
    return s / ((n * (n - 1)) / 2);
  },
});

const setOps = (prediction: unknown, truth: unknown) => {
  const p = asKeys(prediction);
  const t = asKeys(truth);
  if (!p || !t) return null;
  const ps = new Set(p);
  const ts = new Set(t);
  let inter = 0;
  for (const x of ps) if (ts.has(x)) inter++;
  return { p: ps.size, t: ts.size, inter };
};

const jaccard = defineMetric({
  id: "jaccard",
  version: "1",
  describe: "|predicted ∩ true| / |predicted ∪ true| for set-valued predictions (tags, ingredients). Two empty sets score 1.",
  task: "set",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: none,
  score: ({ prediction, truth }) => {
    const s = setOps(prediction, truth);
    if (!s) return null;
    const union = s.p + s.t - s.inter;
    return union === 0 ? 1 : s.inter / union;
  },
});

const setF1 = defineMetric({
  id: "set_f1",
  version: "1",
  describe: "Per-row F1 between predicted and true sets: 2|P∩T| / (|P| + |T|). Two empty sets score 1.",
  task: "set",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: none,
  score: ({ prediction, truth }) => {
    const s = setOps(prediction, truth);
    if (!s) return null;
    return s.p + s.t === 0 ? 1 : (2 * s.inter) / (s.p + s.t);
  },
});

const setExact = defineMetric({
  id: "set_exact",
  version: "1",
  describe: "1 when the predicted and true sets are identical (order ignored).",
  task: "set",
  direction: "higher",
  binary: true,
  needsTruth: true,
  scope: "row",
  args: none,
  score: ({ prediction, truth }) => {
    const s = setOps(prediction, truth);
    return s ? (s.inter === s.p && s.inter === s.t ? 1 : 0) : null;
  },
});

const numeric = (fn: (p: number, t: number) => number | null) => ({ prediction, truth }: Observation) => {
  const p = asNumber(prediction);
  const t = asNumber(truth);
  return p === null || t === null ? null : fn(p, t);
};

const regression = (
  id: string,
  describe: string,
  direction: MetricDirection,
  fn: (p: number, t: number) => number | null,
) =>
  defineMetric({
    id,
    version: "1",
    describe,
    task: "regression",
    direction,
    binary: false,
    needsTruth: true,
    scope: "row",
    args: none,
    score: numeric(fn),
  });

const absError = regression("abs_error", "|prediction − truth|. MAE, as a mean.", "lower", (p, t) => Math.abs(p - t));
const squaredError = regression("squared_error", "(prediction − truth)². MSE, as a mean.", "lower", (p, t) => (p - t) ** 2);
const signedError = regression(
  "signed_error",
  "prediction − truth. Its mean is the BIAS; claim it is equivalent to 0.",
  "target",
  (p, t) => p - t,
);
const absPctError = regression(
  "abs_pct_error",
  "|prediction − truth| / |truth|. MAPE, as a mean. Unscored when truth is 0.",
  "lower",
  (p, t) => (t === 0 ? null : Math.abs(p - t) / Math.abs(t)),
);
const logRatioError = regression(
  "log_ratio_error",
  "|ln(prediction / truth)| — symmetric multiplicative error, for positive quantities (scale factors, amounts).",
  "lower",
  (p, t) => (p > 0 && t > 0 ? Math.abs(Math.log(p / t)) : null),
);

const withinTolerance = defineMetric({
  id: "within_tolerance",
  version: "1",
  describe: "1 when |prediction − truth| ≤ max(abs, rel·|truth|). Give abs, rel, or both.",
  task: "regression",
  direction: "higher",
  binary: true,
  needsTruth: true,
  scope: "row",
  args: z
    .object({ abs: z.number().nonnegative().optional(), rel: z.number().nonnegative().optional() })
    .strict()
    .refine((a) => a.abs !== undefined || a.rel !== undefined, "give abs, rel, or both"),
  score: ({ prediction, truth }, { abs, rel }) => {
    const p = asNumber(prediction);
    const t = asNumber(truth);
    if (p === null || t === null) return null;
    return Math.abs(p - t) <= Math.max(abs ?? 0, (rel ?? 0) * Math.abs(t)) ? 1 : 0;
  },
});

const bounds = (prediction: unknown, lo: string, hi: string): [number, number] | null => {
  const a = asNumber(Array.isArray(prediction) ? prediction[0] : pickPath(prediction, lo));
  const b = asNumber(Array.isArray(prediction) ? prediction[1] : pickPath(prediction, hi));
  return a === null || b === null || a > b ? null : [a, b];
};

const boundKeys = z.object({ lo: z.string().default("lo"), hi: z.string().default("hi") }).strict();

const intervalCovers = defineMetric({
  id: "interval_covers",
  version: "1",
  describe: "1 when the truth lies inside a predicted interval ({lo, hi} or [lo, hi]). Its mean is empirical COVERAGE — claim it is equivalent to the nominal level.",
  task: "interval",
  direction: "target",
  binary: true,
  needsTruth: true,
  scope: "row",
  args: boundKeys,
  score: ({ prediction, truth }, { lo, hi }) => {
    const b = bounds(prediction, lo, hi);
    const t = asNumber(truth);
    return !b || t === null ? null : t >= b[0] && t <= b[1] ? 1 : 0;
  },
});

const intervalWidth = defineMetric({
  id: "interval_width",
  version: "1",
  describe: "hi − lo of a predicted interval. Sharpness; needs no truth.",
  task: "interval",
  direction: "lower",
  binary: false,
  needsTruth: false,
  scope: "row",
  args: boundKeys,
  score: ({ prediction }, { lo, hi }) => {
    const b = bounds(prediction, lo, hi);
    return b ? b[1] - b[0] : null;
  },
});

const intervalScore = defineMetric({
  id: "interval_score",
  version: "1",
  describe: "Gneiting–Raftery interval score for a central (1 − alpha) interval: width plus 2/alpha × the miss distance. Rewards narrow AND honest intervals. Lower is better.",
  task: "interval",
  direction: "lower",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: boundKeys.extend({ alpha: z.number().gt(0).lt(1) }),
  score: ({ prediction, truth }, { lo, hi, alpha }) => {
    const b = bounds(prediction, lo, hi);
    const t = asNumber(truth);
    if (!b || t === null) return null;
    const [l, u] = b;
    return u - l + (2 / alpha) * Math.max(0, l - t) + (2 / alpha) * Math.max(0, t - u);
  },
});

const pinball = defineMetric({
  id: "pinball",
  version: "1",
  describe: "Quantile (pinball) loss of a predicted q-quantile against the truth. Lower is better.",
  task: "interval",
  direction: "lower",
  binary: false,
  needsTruth: true,
  scope: "row",
  args: z.object({ q: z.number().gt(0).lt(1) }).strict(),
  score: (o, { q }) =>
    numeric((p, t) => Math.max(q * (t - p), (q - 1) * (t - p)))(o),
});

const value = defineMetric({
  id: "value",
  version: "1",
  describe: "The prediction itself as a number (booleans → 0/1). For cost, latency, confidence, a human score — anything already numeric. Point `prediction` at it.",
  task: "generic",
  direction: "either",
  binary: false,
  needsTruth: false,
  scope: "row",
  args: none,
  score: ({ prediction }) => asNumber(prediction),
});

const truthy = defineMetric({
  id: "truthy",
  version: "1",
  describe: "1 when the prediction is true / 1 / \"yes\", 0 when false / 0 / \"no\". A rate of some yes/no property.",
  task: "generic",
  direction: "either",
  binary: true,
  needsTruth: false,
  scope: "row",
  args: none,
  score: ({ prediction }) => asBinary(prediction),
});

const equals = defineMetric({
  id: "equals",
  version: "1",
  describe: "1 when the prediction equals `value` (or is one of `in`). The rate of a particular answer — a route, a label.",
  task: "generic",
  direction: "either",
  binary: true,
  needsTruth: false,
  scope: "row",
  args: z
    .object({ value: z.unknown().optional(), in: z.array(z.unknown()).optional() })
    .strict()
    .refine((a) => (a.value !== undefined) !== (a.in !== undefined), "give exactly one of value, in"),
  score: ({ prediction }, a) => {
    if (prediction === undefined) return null;
    const k = keyOf(prediction);
    const allowed = a.in ?? [a.value];
    return allowed.some((v) => keyOf(v) === k) ? 1 : 0;
  },
});

// --- sample-scope --------------------------------------------------------

const labels = (os: readonly Observation[]) =>
  os
    .filter((o) => o.prediction !== undefined && o.truth !== undefined && o.truth !== null)
    .map((o) => [keyOf(o.prediction), keyOf(o.truth)] as const);

const cohenKappa = defineMetric({
  id: "cohen_kappa",
  version: "1",
  describe: "Cohen's kappa between predicted and true categories — agreement beyond chance. Use it to check an LLM judge against human labels.",
  task: "agreement",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "sample",
  args: none,
  compute: (os) => {
    const pairs = labels(os);
    const n = pairs.length;
    if (n === 0) return null;
    const pc = new Map<string, number>();
    const tc = new Map<string, number>();
    let agree = 0;
    for (const [p, t] of pairs) {
      pc.set(p, (pc.get(p) ?? 0) + 1);
      tc.set(t, (tc.get(t) ?? 0) + 1);
      if (p === t) agree++;
    }
    let pe = 0;
    for (const [k, c] of pc) pe += (c / n) * ((tc.get(k) ?? 0) / n);
    return pe === 1 ? null : (agree / n - pe) / (1 - pe);
  },
});

const macroF1 = defineMetric({
  id: "macro_f1",
  version: "1",
  describe: "Unweighted mean over labels of per-label F1 — classification quality that a dominant class cannot carry.",
  task: "classification",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "sample",
  args: none,
  compute: (os) => {
    const pairs = labels(os);
    if (pairs.length === 0) return null;
    const all = new Set(pairs.flatMap(([p, t]) => [p, t]));
    const f1s: number[] = [];
    for (const l of all) {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      for (const [p, t] of pairs) {
        if (p === l && t === l) tp++;
        else if (p === l) fp++;
        else if (t === l) fn++;
      }
      f1s.push((2 * tp) / (2 * tp + fp + fn));
    }
    return mean(f1s);
  },
});

const auc = defineMetric({
  id: "auc",
  version: "1",
  describe: "ROC AUC: probability a random positive (truth true) gets a higher prediction score than a random negative. Undefined with one class.",
  task: "probabilistic",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "sample",
  args: none,
  compute: (os) => {
    const scored: Array<[number, 0 | 1]> = [];
    for (const o of os) {
      const s = asNumber(o.prediction);
      const y = asBinary(o.truth);
      if (s !== null && y !== null) scored.push([s, y]);
    }
    const pos = scored.filter((x) => x[1] === 1).length;
    const neg = scored.length - pos;
    if (pos === 0 || neg === 0) return null;
    const ranks = averageRanks(scored.map((x) => x[0]));
    let rankSum = 0;
    scored.forEach((x, i) => {
      if (x[1] === 1) rankSum += ranks[i] as number;
    });
    return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
  },
});

const ece = defineMetric({
  id: "ece",
  version: "1",
  describe: "Expected calibration error: bins predictions by stated probability and averages |observed rate − stated probability|. Prediction: a confidence in [0,1]; truth: whether it was right. Lower is better.",
  task: "probabilistic",
  direction: "lower",
  binary: false,
  needsTruth: true,
  scope: "sample",
  args: z.object({ bins: z.number().int().min(2).max(100).default(10) }).strict(),
  compute: (os, { bins }) => {
    const acc = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
    let n = 0;
    for (const o of os) {
      const p = asNumber(o.prediction);
      const y = asBinary(o.truth);
      if (p === null || y === null || p < 0 || p > 1) continue;
      const b = acc[Math.min(bins - 1, Math.floor(p * bins))] as { n: number; p: number; y: number };
      b.n++;
      b.p += p;
      b.y += y;
      n++;
    }
    if (n === 0) return null;
    return acc.reduce((s, b) => (b.n === 0 ? s : s + (b.n / n) * Math.abs(b.y / b.n - b.p / b.n)), 0);
  },
});

const pearsonMetric = defineMetric({
  id: "pearson",
  version: "1",
  describe: "Pearson correlation between numeric predictions and truths across rows.",
  task: "regression",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "sample",
  args: none,
  compute: (os) => pearson(pairNumbers(os)),
});

const spearman = defineMetric({
  id: "spearman",
  version: "1",
  describe: "Spearman rank correlation between numeric predictions and truths across rows — monotone agreement, robust to scale.",
  task: "regression",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "sample",
  args: none,
  compute: (os) => {
    const pairs = pairNumbers(os);
    const rx = averageRanks(pairs.map((p) => p[0]));
    const ry = averageRanks(pairs.map((p) => p[1]));
    return pearson(rx.map((r, i) => [r, ry[i] as number] as const));
  },
});

const r2 = defineMetric({
  id: "r2",
  version: "1",
  describe: "Coefficient of determination 1 − SS_res / SS_tot of predictions against truths.",
  task: "regression",
  direction: "higher",
  binary: false,
  needsTruth: true,
  scope: "sample",
  args: none,
  compute: (os) => {
    const pairs = pairNumbers(os);
    if (pairs.length < 2) return null;
    const my = mean(pairs.map((p) => p[1]));
    let res = 0;
    let tot = 0;
    for (const [p, t] of pairs) {
      res += (t - p) ** 2;
      tot += (t - my) ** 2;
    }
    return tot === 0 ? null : 1 - res / tot;
  },
});

export const BUILTIN_METRICS: MetricRegistry = metricRegistry(
  exactMatch,
  topK,
  logLoss,
  brier,
  probTruth,
  crpsGaussian,
  reciprocalRank,
  hitAtK,
  precisionAtK,
  recallAtK,
  averagePrecision,
  ndcgAtK,
  kendallTau,
  jaccard,
  setF1,
  setExact,
  absError,
  squaredError,
  signedError,
  absPctError,
  logRatioError,
  withinTolerance,
  intervalCovers,
  intervalWidth,
  intervalScore,
  pinball,
  value,
  truthy,
  equals,
  cohenKappa,
  macroF1,
  auc,
  ece,
  pearsonMetric,
  spearman,
  r2,
);
