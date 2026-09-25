/**
 * Learned gates — what feature discovery hands a pipeline (#321).
 *
 * `discoverFeatures` (./discover) ends with a question set and a linear model
 * over their answers. This file writes both into a spec with no new node kind:
 *
 *   decide   asks the discovered questions (the host publishes the wording
 *            under the node's `questions` name, as it does for any decide node)
 *   derive   a `code` node whose `expr` IS the fitted model: the weights are
 *            literals, so a refit is a new expression, which the spec compiler
 *            already turns into a new node version
 *   gate     optional: cuts the score into branches on a named threshold, so
 *            the cut stays tunable like any other threshold
 *
 * Discovery is not a node. A node runs once per input; discovery runs over
 * many recorded runs and their labels, and its output has to clear a shadow
 * and a locked trial before it ships. So it is a spec operation, beside
 * `propose` and `shadow`: `discoverForSpec` runs the loop and returns a
 * patched spec, and `attachLearnedGate` is the pure half that does the patch.
 *
 * The decide port's contract for these questions is the one the discovery
 * answer port already had: presence → [P(true)], intensity → one probability
 * per `INTENSITY_LEVELS` level. The weights only mean in production what they
 * meant in the loop if both ports return the same shape AND ask the same
 * wording: build the answer port's questions with `learnedQuestionSet` and
 * pass the same `presence` criteria to the attach.
 */

import {
  INTENSITY_LEVELS,
  designMatrix,
  discoverFeatures,
  encodeAnswer,
  learnerFor,
  questionId,
  type DiscoverOptions,
  type DiscoverResult,
  type DiscoverRow,
  type DiscoverTarget,
  type DiscoveredQuestion,
  type LogisticModel,
} from "./discover";
import { shortHash } from "./hash";
import type { ExpressionEngine, NodeSpecJSON, PipelineSpecJSON, SpecRegistry } from "./spec";
import { compilePipelineSpec } from "./spec";
import type { ProbeQuestion, Threshold } from "./types";

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** One column the model reads: a base column by name, or an encoding of one question's answer. */
export type LearnedColumn =
  | { base: string }
  | { question: string; kind: DiscoveredQuestion["kind"]; encode: "p" | "mean" | "sd" };

export interface LearnedModel {
  target: DiscoverTarget;
  columns: LearnedColumn[];
  /** Standardised-space weights, as the learner fitted them. */
  w: number[];
  b: number;
  mean: number[];
  sd: number[];
}

/** Fit the final model on every row (CV already chose the questions). */
export const fitLearnedModel = (opts: {
  rows: readonly DiscoverRow[];
  baseNames: readonly string[];
  questions: readonly DiscoveredQuestion[];
  answers: Record<string, number[][]>;
  target?: DiscoverTarget;
  lambda?: number;
}): LearnedModel => {
  const target = opts.target ?? "binary";
  const { X } = designMatrix(opts.rows, opts.questions, opts.answers);
  const m: LogisticModel = learnerFor(target).fit(X, opts.rows.map((r) => r.label), opts.lambda ?? 1);
  const columns: LearnedColumn[] = opts.baseNames.map((base) => ({ base }));
  for (const q of opts.questions) {
    if (q.kind === "presence") columns.push({ question: q.name, kind: q.kind, encode: "p" });
    else columns.push({ question: q.name, kind: q.kind, encode: "mean" }, { question: q.name, kind: q.kind, encode: "sd" });
  }
  if (columns.length !== m.w.length) throw new Error(`model has ${m.w.length} weights for ${columns.length} columns`);
  return { target, columns, w: m.w, b: m.b, mean: m.mean, sd: m.sd };
};

const columnValue = (c: LearnedColumn, answers: Readonly<Record<string, readonly number[]>>, base: Readonly<Record<string, number>>, fill: number): number => {
  if ("base" in c) return base[c.base] ?? fill;
  const d = answers[c.question];
  if (!d || d.length === 0) return fill;
  const [first, second] = encodeAnswer(c.kind, d);
  return c.encode === "sd" ? second ?? fill : first ?? fill;
};

/**
 * The reference implementation of `learnedExpression`: the score for one run's
 * answers (decide distributions keyed by question name) and base columns. A
 * missing answer or base column takes its training mean, so it moves nothing.
 */
export const scoreLearned = (
  model: LearnedModel,
  answers: Readonly<Record<string, readonly number[]>>,
  base: Readonly<Record<string, number>> = {},
): number => {
  const z = model.b + model.columns.reduce((a, c, j) => a + ((columnValue(c, answers, base, model.mean[j]!) - model.mean[j]!) / model.sd[j]!) * model.w[j]!, 0);
  return model.target === "binary" ? 1 / (1 + Math.exp(-z)) : z;
};

/** Share of |standardised weight| per question or base column. */
export const learnedImportance = (model: LearnedModel): Record<string, number> => {
  const total = model.w.reduce((a, v) => a + Math.abs(v), 0) || 1;
  const out: Record<string, number> = {};
  model.columns.forEach((c, j) => {
    const k = "base" in c ? c.base : c.question;
    out[k] = (out[k] ?? 0) + Math.abs(model.w[j]!) / total;
  });
  return out;
};

// ---------------------------------------------------------------------------
// The model as a JSONata expression
// ---------------------------------------------------------------------------

/** Ten significant digits: exact enough, and short enough to read in a diff. */
const num = (v: number): string => {
  const s = String(Number(v.toPrecision(10)));
  return v < 0 ? `(${s})` : s;
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The model as one JSONata expression, weights folded into raw-space
 * coefficients so it reads as `intercept + c₁·x₁ + …`. `answers` and `base`
 * name the roots it reads (the derive node's `inputs`); a missing answer or
 * base column falls back to its training mean, like `scoreLearned`.
 */
export const learnedExpression = (model: LearnedModel, roots: { answers: string; base?: string }): string => {
  if (!IDENT.test(roots.answers) || (roots.base !== undefined && !IDENT.test(roots.base))) throw new Error("roots must be plain identifiers");
  if (model.columns.some((c) => "base" in c) && !roots.base) throw new Error("the model reads base columns: name the `base` root");
  const coef = model.w.map((w, j) => w / model.sd[j]!);
  const intercept = model.b - coef.reduce((a, c, j) => a + c * model.mean[j]!, 0);
  const lets: string[] = [];
  const terms: string[] = [];
  const seen = new Set<string>();
  const v = (name: string) => `$${name.replace(/[^A-Za-z0-9_]/g, "_")}`;
  model.columns.forEach((c, j) => {
    const fill = num(model.mean[j]!);
    if ("base" in c) {
      const x = v(`b_${c.base}`);
      lets.push(`${x} := $lookup(${roots.base}, ${JSON.stringify(c.base)}); ${x} := $type(${x}) = "number" ? ${x} : ${fill};`);
      terms.push(`${num(coef[j]!)} * ${x}`);
      return;
    }
    const d = v(`d_${c.question}`);
    if (!seen.has(c.question)) {
      seen.add(c.question);
      // $lookup, not a path: a one-element array read by path collapses to its element.
      lets.push(`${d} := $lookup(${roots.answers}, ${JSON.stringify(c.question)});`);
      if (c.kind === "intensity") {
        const m = v(`m_${c.question}`);
        lets.push(
          `${m} := $exists(${d}) ? $sum($map(${d}, function($p, $i) { $p * $i })) / $sum(${d}) : null;`,
          `${v(`s_${c.question}`)} := $exists(${d}) ? $sqrt($max([0, $sum($map(${d}, function($p, $i) { $p * $i * $i })) / $sum(${d}) - ${m} * ${m}])) : null;`,
        );
      }
    }
    const x = c.encode === "p" ? `(${"$exists(" + d + ") ? " + d + "[0] : " + fill})` : `(${v(`${c.encode === "mean" ? "m" : "s"}_${c.question}`)} != null ? ${v(`${c.encode === "mean" ? "m" : "s"}_${c.question}`)} : ${fill})`;
    terms.push(`${num(coef[j]!)} * ${x}`);
  });
  const z = [num(intercept), ...terms].join(" + ");
  const score = model.target === "binary" ? `1 / (1 + $power(2.718281828459045, -($z)))` : "$z";
  return ["(", ...lets.map((l) => `  ${l}`), `  $z := ${z};`, `  { "score": ${score} }`, ")"].join("\n");
};

// ---------------------------------------------------------------------------
// Question wording
// ---------------------------------------------------------------------------

export const DEFAULT_PRESENCE_CRITERIA = {
  true: "The state states this or clearly implies it",
  false: "The state gives no indication of this",
};

/** The question set the host publishes under the decide node's `questions` name. */
export const learnedQuestionSet = (
  questions: readonly DiscoveredQuestion[],
  presence: { true: string; false: string } = DEFAULT_PRESENCE_CRITERIA,
): Record<string, ProbeQuestion> =>
  Object.fromEntries(
    questions.map((q) => [
      q.name,
      q.kind === "intensity"
        ? { type: "score", instructions: q.question, criteria: [...INTENSITY_LEVELS] }
        : { type: "noul", instructions: q.question, criteria: presence },
    ]),
  );

// ---------------------------------------------------------------------------
// Attaching it to a spec
// ---------------------------------------------------------------------------

export interface LearnedGateAttach {
  /** Prefix for the fragment's node ids: `<prefix>_ask`, `<prefix>_score`, `<prefix>_gate`. */
  prefix: string;
  /** The node the decide node hangs off (its only inbound edge). */
  after: string;
  /** The decide node's `questions` name — what the host resolves to `questionSet`. */
  questionsName: string;
  /** Named state blocks for the decide node, when the host resolves them. */
  state?: string[];
  /**
   * The presence criteria the answer port asked with. The published wording
   * must be the wording the model was fitted on, or the weights read answers
   * to a different question. Default `DEFAULT_PRESENCE_CRITERIA`.
   */
  presence?: { true: string; false: string };
  /** Where the base columns come from: a ref on a DIRECT inbound node (`features.base`). Its node gets an edge into the score node. */
  base?: string;
  /** No gate: the score node's output feeds these nodes. */
  feeds?: string[];
  /** A gate on the score: `score >= cut` takes `above`. `routes` maps each branch to the nodes it feeds. */
  gate?: {
    cut: Threshold;
    above: string;
    below: string;
    routes: Record<string, string[]>;
  };
}

export interface AttachResult {
  spec: PipelineSpecJSON;
  ids: { ask: string; score: string; gate: string | null };
  /** Human-readable diff, for the review and the commit message. */
  applied: string[];
}

/**
 * Add (or replace) a learned gate in a spec. Pure: no model calls. Re-running
 * it with a refitted model replaces the fragment's nodes and edges in place,
 * so the version history of `<prefix>_score` IS the model's history.
 */
export const attachLearnedGate = (
  spec: PipelineSpecJSON,
  model: LearnedModel,
  questions: readonly DiscoveredQuestion[],
  at: LearnedGateAttach,
): AttachResult => {
  const ids = { ask: `${at.prefix}_ask`, score: `${at.prefix}_score`, gate: at.gate ? `${at.prefix}_gate` : null };
  const mine = new Set([ids.ask, ids.score, `${at.prefix}_gate`]);
  const applied: string[] = [];
  const replacing = Object.keys(spec.nodes).filter((id) => mine.has(id));
  if (replacing.length) applied.push(`replaced ${replacing.join(", ")}`);
  if (!spec.nodes[at.after]) throw new Error(`attach.after: no node "${at.after}"`);
  const baseNode = at.base?.split(".")[0];
  if (baseNode && !spec.nodes[baseNode]) throw new Error(`attach.base: no node "${baseNode}"`);
  const usesBase = model.columns.some((c) => "base" in c);
  if (usesBase && !at.base) throw new Error("the model reads base columns: pass attach.base");

  const nodes: Record<string, NodeSpecJSON> = Object.fromEntries(Object.entries(spec.nodes).filter(([id]) => !mine.has(id)));
  const edges = spec.edges.filter((e) => !mine.has(e.from) && !mine.has(e.to));

  const questionSet = learnedQuestionSet(questions, at.presence);
  nodes[ids.ask] = {
    kind: "decide",
    version: `q${shortHash(questionSet)}`,
    describe: `${questions.length} discovered questions (${at.questionsName})`,
    questions: at.questionsName,
    ...(at.state ? { state: at.state } : {}),
  };
  edges.push({ from: at.after, to: ids.ask });
  applied.push(`${ids.ask}: decide, ${questions.length} questions from "${at.questionsName}"`);

  nodes[ids.score] = {
    kind: "code",
    role: "derive",
    version: "1",
    describe: `learned ${model.target === "binary" ? "logistic" : "ridge"} model over ${model.columns.length} columns`,
    inputs: { answers: ids.ask, ...(usesBase ? { base: at.base! } : {}) },
    expr: learnedExpression(model, { answers: "answers", ...(usesBase ? { base: "base" } : {}) }),
  };
  edges.push({ from: ids.ask, to: ids.score });
  if (usesBase && baseNode && baseNode !== ids.ask) edges.push({ from: baseNode, to: ids.score });
  applied.push(`${ids.score}: derive, ${model.target} score over ${model.columns.length} columns`);

  if (at.gate) {
    const g = at.gate;
    nodes[ids.gate!] = {
      kind: "code",
      role: "gate",
      version: "1",
      inputs: { score: `${ids.score}.score` },
      thresholds: { cut: g.cut },
      branches: [g.above, g.below],
      rules: [
        { when: "score >= $t.cut", branch: g.above, reason: "'score ' & $string(score) & ' >= ' & $string($t.cut)" },
        { branch: g.below, reason: "'score ' & $string(score) & ' < ' & $string($t.cut)" },
      ],
    };
    edges.push({ from: ids.score, to: ids.gate! });
    for (const [branch, targets] of Object.entries(g.routes)) {
      for (const to of targets) edges.push({ from: ids.gate!, to, when: { gate: ids.gate!, branch } });
    }
    applied.push(`${ids.gate}: gate, score >= cut → ${g.above}, else ${g.below}`);
  } else {
    for (const to of at.feeds ?? []) edges.push({ from: ids.score, to });
  }
  return { spec: { ...spec, nodes, edges }, ids, applied };
};

// ---------------------------------------------------------------------------
// The whole step
// ---------------------------------------------------------------------------

export interface DiscoverForSpecOptions extends DiscoverOptions {
  spec: PipelineSpecJSON;
  attach: LearnedGateAttach;
  /** Reuse a finished loop instead of running one (its answers must cover `rows`). */
  discovery?: DiscoverResult;
  /** Compile the patched spec and report its problems. */
  check?: { registry: SpecRegistry; engine: ExpressionEngine };
}

export interface DiscoverForSpecResult extends AttachResult {
  discovery: DiscoverResult;
  model: LearnedModel;
  /** Publish this under `attach.questionsName` before the spec runs. */
  questionSet: Record<string, ProbeQuestion>;
  /** Empty when the patched spec compiles (or when no `check` was given). */
  problems: string[];
}

/**
 * Discovery as a spec operation: run the loop on dev rows, fit the final
 * model, and return the spec with the learned gate attached. What it returns
 * is a CHALLENGER — shadow it beside the champion and lock a trial before it
 * ships. Held-out rows never reach this function; score them once, outside.
 */
export async function discoverForSpec(opts: DiscoverForSpecOptions): Promise<DiscoverForSpecResult> {
  const discovery = opts.discovery ?? (await discoverFeatures(opts));
  const answers = Object.fromEntries(discovery.accepted.map((q) => [questionId(q), discovery.answers[questionId(q)]!]));
  const model = fitLearnedModel({ rows: opts.rows, baseNames: opts.baseNames, questions: discovery.accepted, answers, target: opts.target, lambda: opts.lambda });
  const attached = attachLearnedGate(opts.spec, model, discovery.accepted, opts.attach);
  const problems = opts.check ? compilePipelineSpec(attached.spec, opts.check.registry, opts.check.engine).problems : [];
  return { ...attached, discovery, model, questionSet: learnedQuestionSet(discovery.accepted, opts.attach.presence), problems };
}
