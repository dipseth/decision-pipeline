/**
 * Feature discovery (#321): an author proposes questions, a question-answering
 * port answers them for every row, a small model learns from the answers, and
 * the model's worst-predicted rows go back to the author for the next round.
 *
 * After TypeSafe's "Autoresearch feature discovery" cookbook, with three
 * departures:
 *   - the target is BINARY (e.g. "was the cheap branch's answer right?"), so the
 *     learner is L2 logistic regression, which is pure TS and inspectable, instead of
 *     CatBoost. A gate needs a calibrated probability more than it needs the last
 *     point of accuracy, and at a few hundred negatives a boosted model memorises;
 *   - folds are GROUPED (a row's `group`, e.g. the recipe a transformed copy
 *     came from), so a copy never sits in the fold that judges its parent;
 *   - every round is scored against `base` columns the host already has for
 *     free (today's gate inputs). A discovered question has to beat what the
 *     gate can already read, not a mean-only baseline.
 *
 * Accept rules follow the cookbook. An add goes in unless its column is flat.
 * A revise or drop is tried first by refitting, which costs no port calls, and is
 * kept only if CV log loss drops. Only dev rows may reach this function. The host
 * scores its held-out rows once, outside it.
 */

import { hashToUnit } from "./hash";

export type QuestionKind = "intensity" | "presence";

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
  label: 0 | 1;
  /** Columns the host already has (named by `baseNames`). */
  base: number[];
  /** What the author reads for this row. */
  text: string;
}

export interface DiscoverAuthorRequest {
  round: number;
  accepted: DiscoveredQuestion[];
  /** Rendered rows: round 1 spans both labels; later rounds show the worst half and the best half. */
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
  /** CV log loss of `base` alone: the bar. */
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

export interface CvScore {
  logLoss: number;
  auc: number;
  columns: number;
}

/** Fold index per row: whole groups dealt to folds by salted hash. */
export const groupFolds = (groups: readonly string[], k: number, seed: number): number[] =>
  groups.map((g) => Math.min(k - 1, Math.floor(hashToUnit(`fold${seed}:${g}`) * k)));

export const crossValidate = (
  X: readonly number[][],
  y: readonly number[],
  groups: readonly string[],
  opts: { folds?: number; repeats?: number; lambda?: number } = {},
): { oof: number[]; score: CvScore } => {
  const k = opts.folds ?? 5;
  const repeats = opts.repeats ?? 2;
  const oof = new Array(y.length).fill(0);
  let loss = 0;
  for (let rep = 0; rep < repeats; rep++) {
    const fold = groupFolds(groups, k, rep);
    const pred = new Array(y.length).fill(0);
    for (let f = 0; f < k; f++) {
      const tr = y.map((_, i) => i).filter((i) => fold[i] !== f);
      const te = y.map((_, i) => i).filter((i) => fold[i] === f);
      if (!te.length || !tr.length) continue;
      const m = fitLogistic(tr.map((i) => X[i]!), tr.map((i) => y[i]!), opts.lambda);
      for (const i of te) pred[i] = predictLogistic(m, X[i]!);
    }
    loss += logLoss(y, pred);
    pred.forEach((v, i) => (oof[i] += v / repeats));
  }
  return { oof, score: { logLoss: loss / repeats, auc: auc(y, oof), columns: X[0]?.length ?? 0 } };
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

const pickExamples = (rows: readonly DiscoverRow[], oof: number[] | null, n: number): Array<{ row: DiscoverRow; p: number | null }> => {
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

const renderExamples = (ex: Array<{ row: DiscoverRow; p: number | null }>): string =>
  ex[0]?.p === null
    ? ["Example rows with their label:", ...ex.map(({ row }) => `- label ${row.label}:\n${row.text}`)].join("\n")
    : [
        "Rows, worst-predicted first. The first half is where the current questions miss by the most, the second half where they are already right, so what separates the halves is what the questions have not captured.",
        ...ex.map(({ row, p }) => `- label ${row.label}, predicted ${p!.toFixed(2)}:\n${row.text}`),
      ].join("\n");

export async function discoverFeatures(opts: DiscoverOptions): Promise<DiscoverResult> {
  const { rows, ports } = opts;
  const rounds = opts.rounds ?? 4;
  const minSpread = opts.minSpread ?? 0.05;
  const cvOpts = { folds: opts.folds ?? 5, repeats: opts.repeats ?? 2, lambda: opts.lambda ?? 1 };
  const log = opts.log ?? (() => {});
  const y = rows.map((r) => r.label);
  const groups = rows.map((r) => r.group);

  const answers: Record<string, number[][]> = {};
  let accepted: DiscoveredQuestion[] = [];
  const history: CvScore[] = [];
  const snapshots: DiscoveredQuestion[][] = [];
  const journal: JournalEntry[] = [];
  const cv = (qs: DiscoveredQuestion[]) => crossValidate(designMatrix(rows, qs, answers).X, y, groups, cvOpts);

  const baseRun = cv([]);
  const baseCv = baseRun.score;
  log(`base (${opts.baseNames.length} columns): CV log loss ${baseCv.logLoss.toFixed(4)}, AUC ${baseCv.auc.toFixed(3)}`);
  let oof: number[] | null = null;
  let feedback = "";
  let stale = 0;

  for (let round = 1; round <= rounds; round++) {
    const actions = (await ports.author({ round, accepted, examples: renderExamples(pickExamples(rows, oof, opts.examples ?? 40)), feedback, maxActions: opts.maxActions ?? 12 })).slice(0, opts.maxActions ?? 12);
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
      if (s.logLoss < current.logLoss) { accepted = trial; journal.push({ round, what: "revise", name: q.name, note: `was ${q.replaces}, ${current.logLoss.toFixed(4)} → ${s.logLoss.toFixed(4)}` }); current = s; }
      else journal.push({ round, what: "reject", name: q.name, note: `would cost ${(s.logLoss - current.logLoss).toFixed(4)}` });
    }
    for (const name of drops) {
      const trial = accepted.filter((a) => a.name !== name);
      if (trial.length === accepted.length) continue;
      const s = cv(trial).score;
      if (s.logLoss < current.logLoss) { accepted = trial; journal.push({ round, what: "drop", name, note: `${current.logLoss.toFixed(4)} → ${s.logLoss.toFixed(4)}` }); current = s; }
      else journal.push({ round, what: "keep", name, note: `dropping would cost ${(s.logLoss - current.logLoss).toFixed(4)}` });
    }

    const run = cv(accepted);
    oof = run.oof;
    const best = history.reduce((a, h) => Math.min(a, h.logLoss), baseCv.logLoss);
    stale = run.score.logLoss < best - 1e-4 ? 0 : stale + 1;
    history.push(run.score);
    snapshots.push([...accepted]);
    const { X, owner } = designMatrix(rows, accepted, answers);
    const imp = importanceByOwner(fitLogistic(X, y, cvOpts.lambda), [...opts.baseNames, ...owner]);
    feedback = [
      `CV log loss (lower is better). Base columns alone: ${baseCv.logLoss.toFixed(4)} (AUC ${baseCv.auc.toFixed(3)}).`,
      ...history.map((h, i) => `  round ${i + 1}: ${h.logLoss.toFixed(4)} (AUC ${h.auc.toFixed(3)}, ${h.columns} columns)`),
      "",
      "Importance share of every column the model reads, base columns included. A question with a low share is not earning its place; revise or drop it.",
      ...Object.entries(imp).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${(100 * v).toFixed(1)}%${live.has(k) || accepted.some((a) => a.name === k) ? "" : opts.baseNames.includes(k) ? " (base)" : ""}`),
    ].join("\n");
    log(`round ${round}: ${fresh.length} answered, ${accepted.length} kept, CV ${run.score.logLoss.toFixed(4)} AUC ${run.score.auc.toFixed(3)}`);
    for (const j of journal.filter((j) => j.round === round)) log(`  ${j.what.padEnd(7)}${j.name.padEnd(40)}${j.note}`);
    if (opts.patience && stale >= opts.patience) { log(`stopping: no improvement for ${stale} rounds`); break; }
  }
  return { accepted, answers, baseCv, history, snapshots, journal };
}
