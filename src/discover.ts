/**
 * Feature discovery (#321): an author proposes questions, a question-answering
 * port answers them for every row, a small model learns from the answers, and
 * the model's worst-predicted rows go back to the author for the next round.
 *
 * After TypeSafe's "Autoresearch feature discovery" cookbook, with three
 * departures:
 *   - the learner is LINEAR, so it is pure TS, inspectable, and writable into a
 *     spec as one expression (./learned): L2 logistic regression for a binary
 *     target (e.g. "was the cheap branch's answer right?"), ridge regression for a
 *     numeric one (the cookbook's critic score). A gate needs a calibrated
 *     probability more than it needs the last point of accuracy, and at a few
 *     hundred negatives a boosted model memorises;
 *   - folds are GROUPED (a row's `group`, e.g. the recipe a transformed copy
 *     came from), so a copy never sits in the fold that judges its parent;
 *   - every round is scored against `base` columns the host already has for
 *     free (today's gate inputs). A discovered question has to beat what the
 *     gate can already read, not a mean-only baseline.
 *
 * Accept rules follow the cookbook. An add goes in unless its column is flat.
 * A revise or drop is tried first by refitting, which costs no port calls, and is
 * kept only if the CV loss drops (log loss, or RMSE for a numeric target). Only dev rows may reach this function. The host
 * scores its held-out rows once, outside it.
 */

import { hashToUnit } from "./hash";

export type QuestionKind = "intensity" | "presence";
/** binary: labels are 0/1, logistic regression, log loss. numeric: any number, ridge regression, RMSE. */
export type DiscoverTarget = "binary" | "numeric";

export interface DiscoveredQuestion {
  name: string;
  kind: QuestionKind;
  question: string;
  /** Round the current wording came from; the answer cache is keyed on it. */
  round: number;
}

export interface DiscoverAction {
  op: "add" | "revise" | "drop";
  /** revise/drop: the existing question's name. */
  target: string;
  name: string;
  kind: QuestionKind;
  question: string;
}

export interface DiscoverRow {
  id: string;
  /** Rows sharing a group always share a fold. */
  group: string;
  /** 0 or 1 for a binary target; any finite number for a numeric one. */
  label: number;
  /** Columns the host already has (named by `baseNames`). */
  base: number[];
  /** What the author reads for this row. */
  text: string;
}

export interface DiscoverAuthorRequest {
  round: number;
  accepted: DiscoveredQuestion[];
  /** Rendered rows: round 1 spans the labels; later rounds show the worst half and the best half. */
  examples: string;
  /** The scoreboard: CV history, per-question importance and spread. Empty on round 1. */
  feedback: string;
  maxActions: number;
}

export interface DiscoverPorts {
  author: (req: DiscoverAuthorRequest) => Promise<DiscoverAction[]>;
  /**
   * Answer questions for rows. Returns, per question name, one probability
   * vector per row, in row order: intensity = 5 level probabilities,
   * presence = [p(true)]. Hosts should cache by (row, question text).
   */
  answer: (rows: DiscoverRow[], questions: DiscoveredQuestion[]) => Promise<Record<string, number[][]>>;
}

export interface DiscoverOptions {
  rows: DiscoverRow[];
  baseNames: string[];
  ports: DiscoverPorts;
  /** Default "binary". */
  target?: DiscoverTarget;
  rounds?: number;
  examples?: number;
  maxActions?: number;
  /** A column whose std over rows is below this cannot separate anything. */
  minSpread?: number;
  folds?: number;
  repeats?: number;
  lambda?: number;
  /** Stop early after this many rounds with no CV improvement. */
  patience?: number;
  log?: (line: string) => void;
}

export interface JournalEntry {
  round: number;
  what: "add" | "flat" | "revise" | "reject" | "drop" | "keep" | "stale";
  name: string;
  note: string;
}

export interface DiscoverResult {
  accepted: DiscoveredQuestion[];
  /** Every answered question id (`name@round`) → per-row probability vectors. */
  answers: Record<string, number[][]>;
  /** CV score of `base` alone: the bar. */
  baseCv: CvScore;
  history: CvScore[];
  snapshots: DiscoveredQuestion[][];
  journal: JournalEntry[];
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export const INTENSITY_LEVELS = [
  "Not present at all",
  "Barely present, mentioned once in passing",
  "Present at a moderate level",
  "Present strongly, the text dwells on it",
  "Dominant, the text is largely about this",
] as const;

export const questionId = (q: Pick<DiscoveredQuestion, "name" | "round">): string => `${q.name}@${q.round}`;

/** intensity → [mean level, sd]; presence → [p]. */
export const encodeAnswer = (kind: QuestionKind, p: readonly number[]): number[] => {
  if (kind === "presence") return [p[0] ?? 0];
  const total = p.reduce((a, b) => a + b, 0) || 1;
  let mean = 0, sq = 0;
  p.forEach((v, i) => { mean += (i * v) / total; sq += (i * i * v) / total; });
  return [mean, Math.sqrt(Math.max(0, sq - mean * mean))];
};

export const designMatrix = (
  rows: readonly DiscoverRow[],
  questions: readonly DiscoveredQuestion[],
  answers: Record<string, number[][]>,
): { X: number[][]; names: string[]; owner: string[] } => {
  const names: string[] = [];
  const owner: string[] = [];
  const X = rows.map((r) => [...r.base]);
  for (const q of questions) {
    const cols = answers[questionId(q)];
    if (!cols) throw new Error(`no answers for ${questionId(q)}`);
    const width = encodeAnswer(q.kind, cols[0] ?? []).length;
    for (let j = 0; j < width; j++) { names.push(j === 0 ? q.name : `${q.name}_sd`); owner.push(q.name); }
    rows.forEach((_, i) => X[i]!.push(...encodeAnswer(q.kind, cols[i] ?? [])));
  }
  return { X, names, owner };
};

// ---------------------------------------------------------------------------
// Learner: L2 logistic regression, Newton steps on standardised columns
// ---------------------------------------------------------------------------

export interface LogisticModel {
  w: number[];
  b: number;
  mean: number[];
  sd: number[];
}

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

const solve = (A: number[][], g: number[]): number[] => {
  const n = g.length;
  const M = A.map((row, i) => [...row, g[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const piv = M[c]![c]! || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / piv;
      if (f) for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / (row[i] || 1e-12));
};

export const fitLogistic = (X: readonly number[][], y: readonly number[], lambda = 1, iters = 25): LogisticModel => {
  const d = X[0]?.length ?? 0;
  const n = X.length;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((a, r) => a + r[j]!, 0) / Math.max(1, n));
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((a, r) => a + (r[j]! - mean[j]!) ** 2, 0) / Math.max(1, n)) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - mean[j]!) / sd[j]!));
  // Parameter vector: [b, w...]; the intercept is not penalised.
  let beta = new Array(d + 1).fill(0);
  const base = y.reduce((a, v) => a + v, 0) / Math.max(1, n);
  beta[0] = Math.log(Math.max(1e-6, base) / Math.max(1e-6, 1 - base));
  for (let it = 0; it < iters; it++) {
    const g = new Array(d + 1).fill(0);
    const H = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const z = Z[i]!;
      const p = sigmoid(beta[0] + z.reduce((a, v, j) => a + v * beta[j + 1]!, 0));
      const r = y[i]! - p;
      const wgt = Math.max(p * (1 - p), 1e-9);
      const x = [1, ...z];
      for (let a = 0; a <= d; a++) {
        g[a] += r * x[a]!;
        for (let b = a; b <= d; b++) H[a]![b]! += wgt * x[a]! * x[b]!;
      }
    }
    for (let a = 1; a <= d; a++) { g[a] -= lambda * beta[a]; H[a]![a]! += lambda; }
    for (let a = 0; a <= d; a++) for (let b = 0; b < a; b++) H[a]![b] = H[b]![a]!;
    const step = solve(H, g);
    beta = beta.map((v, i) => v + step[i]!);
    if (step.reduce((a, v) => a + Math.abs(v), 0) < 1e-6) break;
  }
  return { b: beta[0], w: beta.slice(1), mean, sd };
};

export const predictLogistic = (m: LogisticModel, x: readonly number[]): number =>
  sigmoid(m.b + x.reduce((a, v, j) => a + ((v - m.mean[j]!) / m.sd[j]!) * m.w[j]!, 0));

/** Ridge regression on standardised columns, closed form; the intercept is not penalised. Same shape as a logistic fit. */
export const fitRidge = (X: readonly number[][], y: readonly number[], lambda = 1): LogisticModel => {
  const d = X[0]?.length ?? 0;
  const n = X.length;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((a, r) => a + r[j]!, 0) / Math.max(1, n));
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((a, r) => a + (r[j]! - mean[j]!) ** 2, 0) / Math.max(1, n)) || 1);
  const yMean = y.reduce((a, v) => a + v, 0) / Math.max(1, n);
  // Centred columns and target, so the intercept is the target mean and drops out.
  const A = Array.from({ length: d }, (_, j) => Array.from({ length: d }, (_, k) => (j === k ? lambda : 0)));
  const g = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    const z = X[i]!.map((v, j) => (v - mean[j]!) / sd[j]!);
    const r = y[i]! - yMean;
    for (let j = 0; j < d; j++) {
      g[j] += z[j]! * r;
      for (let k = j; k < d; k++) A[j]![k]! += z[j]! * z[k]!;
    }
  }
  for (let j = 0; j < d; j++) for (let k = 0; k < j; k++) A[j]![k] = A[k]![j]!;
  return { b: yMean, w: d ? solve(A, g) : [], mean, sd };
};

export const predictLinear = (m: LogisticModel, x: readonly number[]): number =>
  m.b + x.reduce((a, v, j) => a + ((v - m.mean[j]!) / m.sd[j]!) * m.w[j]!, 0);

/** The learner a target implies. */
export const learnerFor = (target: DiscoverTarget) =>
  target === "numeric"
    ? { fit: fitRidge, predict: predictLinear }
    : { fit: (X: readonly number[][], y: readonly number[], lambda?: number) => fitLogistic(X, y, lambda), predict: predictLogistic };

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const logLoss = (y: readonly number[], p: readonly number[]): number =>
  y.reduce((a, v, i) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p[i]!)); return a - (v * Math.log(q) + (1 - v) * Math.log(1 - q)); }, 0) / Math.max(1, y.length);

/** Rank AUC with ties averaged. */
export const auc = (y: readonly number[], p: readonly number[]): number => {
  const idx = p.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(p.length).fill(0);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    for (let k = i; k <= j; k++) ranks[idx[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const pos = y.filter((v) => v === 1).length;
  const neg = y.length - pos;
  if (!pos || !neg) return 0.5;
  const sumPos = ranks.reduce((a, r, i) => a + (y[i] === 1 ? r : 0), 0);
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
};

export const rmse = (y: readonly number[], p: readonly number[]): number =>
  Math.sqrt(y.reduce((a, v, i) => a + (v - p[i]!) ** 2, 0) / Math.max(1, y.length));

const ranks = (v: readonly number[]): number[] => {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array(v.length).fill(0);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    for (let k = i; k <= j; k++) out[idx[k]![1]] = (i + j) / 2;
    i = j + 1;
  }
  return out;
};

/** Rank correlation, ties averaged: does the model order the rows the way the labels do? */
export const spearman = (a: readonly number[], b: readonly number[]): number => {
  const ra = ranks(a), rb = ranks(b);
  const n = ra.length;
  if (n < 2) return 0;
  const ma = ra.reduce((s, v) => s + v, 0) / n, mb = rb.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i]! - ma) * (rb[i]! - mb); da += (ra[i]! - ma) ** 2; db += (rb[i]! - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
};

export interface CvScore {
  /** What the loop minimises: log loss (binary) or RMSE (numeric). */
  loss: number;
  /** Binary target only. */
  logLoss?: number;
  auc?: number;
  /** Numeric target only. */
  rmse?: number;
  spearman?: number;
  columns: number;
}

/** One line for a log or the author's scoreboard. */
export const describeCv = (s: CvScore): string =>
  s.rmse !== undefined
    ? `RMSE ${s.rmse.toFixed(3)}, Spearman ${(s.spearman ?? 0).toFixed(3)}`
    : `log loss ${(s.logLoss ?? s.loss).toFixed(4)}, AUC ${(s.auc ?? 0.5).toFixed(3)}`;

/** Fold index per row: whole groups dealt to folds by salted hash. */
export const groupFolds = (groups: readonly string[], k: number, seed: number): number[] =>
  groups.map((g) => Math.min(k - 1, Math.floor(hashToUnit(`fold${seed}:${g}`) * k)));

export const crossValidate = (
  X: readonly number[][],
  y: readonly number[],
  groups: readonly string[],
  opts: { folds?: number; repeats?: number; lambda?: number; target?: DiscoverTarget } = {},
): { oof: number[]; score: CvScore } => {
  const k = opts.folds ?? 5;
  const repeats = opts.repeats ?? 2;
  const numeric = opts.target === "numeric";
  const { fit, predict } = learnerFor(opts.target ?? "binary");
  const oof = new Array(y.length).fill(0);
  let loss = 0;
  for (let rep = 0; rep < repeats; rep++) {
    const fold = groupFolds(groups, k, rep);
    const pred = new Array(y.length).fill(0);
    for (let f = 0; f < k; f++) {
      const tr = y.map((_, i) => i).filter((i) => fold[i] !== f);
      const te = y.map((_, i) => i).filter((i) => fold[i] === f);
      if (!te.length || !tr.length) continue;
      const m = fit(tr.map((i) => X[i]!), tr.map((i) => y[i]!), opts.lambda);
      for (const i of te) pred[i] = predict(m, X[i]!);
    }
    loss += numeric ? rmse(y, pred) : logLoss(y, pred);
    pred.forEach((v, i) => (oof[i] += v / repeats));
  }
  const columns = X[0]?.length ?? 0;
  const mean = loss / repeats;
  return {
    oof,
    score: numeric
      ? { loss: mean, rmse: mean, spearman: spearman(y, oof), columns }
      : { loss: mean, logLoss: mean, auc: auc(y, oof), columns },
  };
};

/** Share of |standardised coefficient| per owner (a question owns its mean + sd columns). */
export const importanceByOwner = (m: LogisticModel, owners: readonly string[]): Record<string, number> => {
  const total = m.w.reduce((a, v) => a + Math.abs(v), 0) || 1;
  const out: Record<string, number> = {};
  owners.forEach((o, j) => (out[o] = (out[o] ?? 0) + Math.abs(m.w[j]!) / total));
  return out;
};

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

const slug = (name: string, taken: Set<string>): string => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "feature";
  let c = base, n = 2;
  while (taken.has(c)) c = `${base}_${n++}`;
  return c;
};

const pickExamples = (rows: readonly DiscoverRow[], oof: number[] | null, n: number, target: DiscoverTarget): Array<{ row: DiscoverRow; p: number | null }> => {
  if (!oof && target === "numeric") {
    // Round 1: evenly spaced across the label range, ties broken by hash so it is stable.
    const sorted = [...rows].sort((a, b) => a.label - b.label || hashToUnit(a.id) - hashToUnit(b.id));
    const at = Array.from({ length: Math.min(n, sorted.length) }, (_, k) => Math.round((k * (sorted.length - 1)) / Math.max(1, Math.min(n, sorted.length) - 1)));
    return [...new Set(at)].map((i) => ({ row: sorted[i]!, p: null }));
  }
  if (!oof) {
    // Round 1: half of each label, spread by hash so it is stable.
    const byHash = [...rows].sort((a, b) => hashToUnit(a.id) - hashToUnit(b.id));
    const pos = byHash.filter((r) => r.label === 1).slice(0, Math.ceil(n / 2));
    const neg = byHash.filter((r) => r.label === 0).slice(0, n - pos.length);
    return [...neg, ...pos].map((row) => ({ row, p: null }));
  }
  const order = rows.map((r, i) => ({ row: r, p: oof[i]!, err: Math.abs(r.label - oof[i]!) })).sort((a, b) => b.err - a.err);
  return [...order.slice(0, Math.floor(n / 2)), ...order.slice(order.length - Math.ceil(n / 2))].map(({ row, p }) => ({ row, p }));
};

const renderExamples = (ex: Array<{ row: DiscoverRow; p: number | null }>, target: DiscoverTarget): string => {
  const label = (v: number) => (target === "numeric" ? String(Math.round(v * 100) / 100) : String(v));
  const pred = (v: number) => v.toFixed(target === "numeric" ? 1 : 2);
  return ex[0]?.p === null
    ? ["Example rows with their label:", ...ex.map(({ row }) => `- label ${label(row.label)}:\n${row.text}`)].join("\n")
    : [
        "Rows, worst-predicted first. The first half is where the current questions miss by the most, the second half where they are already right, so what separates the halves is what the questions have not captured.",
        ...ex.map(({ row, p }) => `- label ${label(row.label)}, predicted ${pred(p!)}:\n${row.text}`),
      ].join("\n");
};

export async function discoverFeatures(opts: DiscoverOptions): Promise<DiscoverResult> {
  const { rows, ports } = opts;
  const rounds = opts.rounds ?? 4;
  const minSpread = opts.minSpread ?? 0.05;
  const cvOpts = { folds: opts.folds ?? 5, repeats: opts.repeats ?? 2, lambda: opts.lambda ?? 1, target: opts.target ?? "binary" };
  const log = opts.log ?? (() => {});
  const target = opts.target ?? "binary";
  const y = rows.map((r) => r.label);
  if (target === "binary" && y.some((v) => v !== 0 && v !== 1)) throw new Error("a binary target needs 0/1 labels; pass target: \"numeric\" for a score");
  if (y.some((v) => !Number.isFinite(v))) throw new Error("every label must be a finite number");
  const groups = rows.map((r) => r.group);

  const answers: Record<string, number[][]> = {};
  let accepted: DiscoveredQuestion[] = [];
  const history: CvScore[] = [];
  const snapshots: DiscoveredQuestion[][] = [];
  const journal: JournalEntry[] = [];
  const cv = (qs: DiscoveredQuestion[]) => crossValidate(designMatrix(rows, qs, answers).X, y, groups, cvOpts);

  const baseRun = cv([]);
  const baseCv = baseRun.score;
  log(`base (${opts.baseNames.length} columns): CV ${describeCv(baseCv)}`);
  let oof: number[] | null = null;
  let feedback = "";
  let stale = 0;

  for (let round = 1; round <= rounds; round++) {
    const actions = (await ports.author({ round, accepted, examples: renderExamples(pickExamples(rows, oof, opts.examples ?? 40, target), target), feedback, maxActions: opts.maxActions ?? 12 })).slice(0, opts.maxActions ?? 12);
    const live = new Map(accepted.map((q) => [q.name, q]));
    const drops = actions.filter((a) => a.op === "drop" && live.has(a.target)).map((a) => a.target);
    const replacing = new Set(actions.filter((a) => a.op === "revise" && live.has(a.target)).map((a) => a.target));
    const taken = new Set([...live.keys()].filter((n) => !replacing.has(n)));
    const fresh: Array<DiscoveredQuestion & { replaces: string }> = [];
    for (const a of actions) {
      if (a.op === "drop" || (a.op === "revise" && !live.has(a.target)) || !a.question.trim()) continue;
      const name = slug(a.name, taken);
      taken.add(name);
      fresh.push({ name, kind: a.kind === "intensity" ? "intensity" : "presence", question: a.question.trim(), round, replaces: a.op === "revise" ? a.target : "" });
    }
    if (fresh.length) {
      const got = await ports.answer(rows, fresh);
      for (const q of fresh) {
        const cols = got[q.name];
        if (!cols || cols.length !== rows.length) throw new Error(`answer port returned ${cols?.length ?? 0} rows for ${q.name}, expected ${rows.length}`);
        answers[questionId(q)] = cols;
      }
    }
    const strip = ({ replaces: _r, ...q }: DiscoveredQuestion & { replaces: string }): DiscoveredQuestion => q;
    for (const q of fresh.filter((f) => !f.replaces)) {
      const col = answers[questionId(q)]!.map((p) => encodeAnswer(q.kind, p)[0]!);
      const m = col.reduce((a, v) => a + v, 0) / col.length;
      const spread = Math.sqrt(col.reduce((a, v) => a + (v - m) ** 2, 0) / col.length);
      if (spread < minSpread) { journal.push({ round, what: "flat", name: q.name, note: `spread ${spread.toFixed(3)}` }); continue; }
      accepted.push(strip(q));
      journal.push({ round, what: "add", name: q.name, note: "" });
    }
    let current = cv(accepted).score;
    for (const q of fresh.filter((f) => f.replaces)) {
      const at = accepted.findIndex((a) => a.name === q.replaces);
      if (at < 0) { journal.push({ round, what: "stale", name: q.name, note: `${q.replaces} is gone` }); continue; }
      const trial = [...accepted];
      trial[at] = strip(q);
      const s = cv(trial).score;
      if (s.loss < current.loss) { accepted = trial; journal.push({ round, what: "revise", name: q.name, note: `was ${q.replaces}, ${current.loss.toFixed(4)} → ${s.loss.toFixed(4)}` }); current = s; }
      else journal.push({ round, what: "reject", name: q.name, note: `would cost ${(s.loss - current.loss).toFixed(4)}` });
    }
    for (const name of drops) {
      const trial = accepted.filter((a) => a.name !== name);
      if (trial.length === accepted.length) continue;
      const s = cv(trial).score;
      if (s.loss < current.loss) { accepted = trial; journal.push({ round, what: "drop", name, note: `${current.loss.toFixed(4)} → ${s.loss.toFixed(4)}` }); current = s; }
      else journal.push({ round, what: "keep", name, note: `dropping would cost ${(s.loss - current.loss).toFixed(4)}` });
    }

    const run = cv(accepted);
    oof = run.oof;
    const best = history.reduce((a, h) => Math.min(a, h.loss), baseCv.loss);
    stale = run.score.loss < best - 1e-4 ? 0 : stale + 1;
    history.push(run.score);
    snapshots.push([...accepted]);
    const { X, owner } = designMatrix(rows, accepted, answers);
    const imp = importanceByOwner(learnerFor(target).fit(X, y, cvOpts.lambda), [...opts.baseNames, ...owner]);
    const spreadOf = (name: string): string => {
      const q = accepted.find((a) => a.name === name);
      if (!q) return "";
      const col = answers[questionId(q)]!.map((p) => encodeAnswer(q.kind, p)[0]!);
      const m = col.reduce((a, v) => a + v, 0) / col.length;
      return `, spread ${Math.sqrt(col.reduce((a, v) => a + (v - m) ** 2, 0) / col.length).toFixed(2)}`;
    };
    feedback = [
      `Cross-validated ${target === "numeric" ? "RMSE" : "log loss"} (lower is better). Base columns alone: ${describeCv(baseCv)}.`,
      ...history.map((h, i) => `  round ${i + 1}: ${describeCv(h)} (${h.columns} columns)`),
      "",
      "Importance share of every column the model reads, base columns included, and the spread of each question's answer across rows. A question with a low share or a low spread is not earning its place; revise or drop it.",
      ...Object.entries(imp).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${(100 * v).toFixed(1)}%${opts.baseNames.includes(k) && !accepted.some((a) => a.name === k) ? " (base)" : spreadOf(k)}`),
    ].join("\n");
    log(`round ${round}: ${fresh.length} answered, ${accepted.length} kept, CV ${describeCv(run.score)}`);
    for (const j of journal.filter((j) => j.round === round)) log(`  ${j.what.padEnd(7)}${j.name.padEnd(40)}${j.note}`);
    if (opts.patience && stale >= opts.patience) { log(`stopping: no improvement for ${stale} rounds`); break; }
  }
  return { accepted, answers, baseCv, history, snapshots, journal };
}
