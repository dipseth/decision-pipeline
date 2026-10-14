/**
 * A decision pipeline explained in plain words, from its own JSON (#321).
 *
 * The diagram shows WHAT a pipeline is; this says what it MEANS, for a reader
 * who picked an audience on a scale — a five-year-old, a ten-year-old, a
 * fifteen-year-old, an engineer. Nothing here calls a model: `explainPrompt`
 * turns `manifest.toJSON()` into a brief and the instructions for one level,
 * and the host supplies the model through the `generate` port of
 * {@link explainPipeline}, the same way every other side effect is a port.
 *
 * An explanation is worth caching per VERSION of the pipeline, not per
 * request: {@link explainVersion} hashes the declarative half that changes
 * what the pipeline does (nodes, edges, gates, feedback), and ignores the
 * operational knobs that do not (timeouts, cache policy, eval dataset). A
 * host keys its store on {@link explainCacheKey}: pipeline · version · level
 * · language, plus whatever prompt version it resolved.
 */

import type { DiagramFeedback, DiagramInput, DiagramNode } from "./diagram";
import { shortHash } from "./hash";

// ---------------------------------------------------------------------------
// Levels — a scale, in order from simplest to fullest
// ---------------------------------------------------------------------------

export const EXPLAIN_LEVELS = ["eli5", "eli10", "eli15", "expert"] as const;
export type ExplainLevel = (typeof EXPLAIN_LEVELS)[number];

export const isExplainLevel = (value: unknown): value is ExplainLevel =>
  typeof value === "string" && (EXPLAIN_LEVELS as readonly string[]).includes(value);

interface LevelBrief {
  /** Who is reading, in the second person for the model. */
  audience: string;
  /** How much to write. */
  length: string;
  /** What to keep and what to leave out at this level. */
  rules: string;
}

const LEVELS: Record<ExplainLevel, LevelBrief> = {
  eli5: {
    audience: "a curious five-year-old who has never used a computer",
    length: "Three or four short sentences, one idea each.",
    rules:
      "Use one everyday comparison (a kitchen, a game, a helper) and keep it the whole way through. " +
      "No names of steps, no technical words, no numbers. Say what goes in, what comes out, and the one place where it has to choose.",
  },
  eli10: {
    audience: "a sharp ten-year-old who likes knowing how things work",
    length: "One short paragraph, then a list of at most five steps in order.",
    rules:
      "Plain words. You may name the steps in your own words, never by their identifiers. " +
      "Explain each choice the pipeline makes as a question it asks itself. Mention that a person can correct it afterwards if the pipeline has a feedback surface.",
  },
  eli15: {
    audience: "a fifteen-year-old who has written a little code",
    length: "Two or three short paragraphs and a step list.",
    rules:
      "Distinguish the steps a model does from the steps plain code does, and say why that split exists. " +
      "Name the gates and what each branch means. Say what happens when a step fails. Identifiers may appear in parentheses after the plain name.",
  },
  expert: {
    audience: "an engineer who will maintain this pipeline",
    length: "As long as it needs to be, and no longer: headed sections, dense, no filler.",
    rules:
      "Use the identifiers. Cover: the fact it establishes and what triggers it; every node in order with its kind, role, and failure policy; " +
      "each gate's branches and the thresholds that decide them; the feedback edges and what they change; what is stored, where, at what scope. " +
      "Point out anything a maintainer would want to know before changing it — ordering constraints, where a model is in the loop, what is reversible.",
  },
};

export const explainLevelBrief = (level: ExplainLevel): Readonly<LevelBrief> => LEVELS[level];

// ---------------------------------------------------------------------------
// Version — what an explanation is ABOUT
// ---------------------------------------------------------------------------

/** The declarative half of a node that changes its meaning. Knobs that do not are left out. */
const MEANING_KEYS: readonly string[] = [
  "id",
  "kind",
  "role",
  "describe",
  "version",
  "onFailure",
  "questions",
  "probes",
  "prompt",
  "route",
  "target",
  "scope",
  "branches",
  "thresholds",
  "providesFeatures",
  "acceptsFeatures",
  "batched",
  "submit",
  "tools",
  "inputs",
  "call",
];

const meaningOfNode = (node: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of MEANING_KEYS) if (node[key] !== undefined) out[key] = node[key];
  return out;
};

/**
 * A short hash of what the pipeline DOES. Two manifests with the same version
 * deserve the same explanation; a node version bump, a new branch, a changed
 * threshold or a new feedback edge produce a new one. Timeouts, cache policy,
 * eval dataset and experiments do not.
 */
export const explainVersion = (pipeline: DiagramInput): string =>
  shortHash({
    id: pipeline.id,
    fact: pipeline.fact ?? null,
    trigger: pipeline.trigger ?? [],
    result: pipeline.result ?? [],
    decidedBy: pipeline.decidedBy ?? null,
    nodes: pipeline.nodes.map((n) => meaningOfNode(n as Record<string, unknown>)),
    edges: pipeline.edges.map((e) => ({ from: e.from, to: e.to, when: e.when ?? null })),
    feedback: (pipeline.feedback ?? []).map((f) => ({
      from: f.from,
      to: f.to,
      form: f.form ?? null,
      promoteVia: f.promoteVia ?? null,
    })),
  });

export interface ExplainCacheKeyInputs {
  level: ExplainLevel;
  /** BCP-47 primary subtag, lower case. Default "en". */
  language?: string;
  /** The host's resolved prompt version, when its system prompt is managed outside this package. */
  promptVersion?: string | number | null;
}

/** `pipeline:version:level:language[:prompt]` — stable, readable in a table. */
export const explainCacheKey = (pipeline: DiagramInput, inputs: ExplainCacheKeyInputs): string => {
  const lang = (inputs.language ?? "en").toLowerCase().split("-")[0] || "en";
  const base = `${pipeline.id}:${explainVersion(pipeline)}:${inputs.level}:${lang}`;
  return inputs.promptVersion === undefined || inputs.promptVersion === null
    ? base
    : `${base}:p${inputs.promptVersion}`;
};

// ---------------------------------------------------------------------------
// The brief — the manifest, written out for a model
// ---------------------------------------------------------------------------

const asText = (value: unknown): string =>
  typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);

const nodeLine = (node: DiagramNode, branchIn: string | null): string => {
  const parts: string[] = [`- ${node.id} · ${node.kind}${node.role ? `/${node.role}` : ""}`];
  if (branchIn) parts.push(`(reached on branch "${branchIn}")`);
  if (node.describe) parts.push(`— ${node.describe}`);
  const facts: string[] = [];
  if (node.kind === "decide" && node.questions) facts.push(`asks a fast classifier the "${node.questions}" questions`);
  if (node.kind === "decide" && node.probes) facts.push(`extra questions written by ${node.probes.from}`);
  if (node.kind === "generate" && node.prompt) facts.push(`a writer model on prompt "${node.prompt}"`);
  const tools = node.tools as { static?: string[] | "prompt-config"; selectable?: { candidates: string[]; from: string } } | undefined;
  if (tools?.static === "prompt-config") facts.push("tools: the ones its prompt's config names");
  else if (Array.isArray(tools?.static) && tools.static.length > 0) facts.push(`tools it can call: ${tools.static.join(", ")}`);
  if (tools?.selectable) facts.push(`tools offered when ${tools.selectable.from} says so: ${tools.selectable.candidates.join(", ")}`);
  if (typeof node.submit === "string") facts.push(`answers through the "${node.submit}" tool`);
  if (typeof node.call === "string") facts.push(`calls ${node.call}`);
  if (node.inputs && typeof node.inputs === "object") facts.push(`reads: ${Object.keys(node.inputs as object).join(", ")}`);
  if (node.role === "gate" && node.branches?.length) facts.push(`branches: ${node.branches.join(" | ")}`);
  if (node.thresholds && Object.keys(node.thresholds).length > 0) {
    const t = Object.entries(node.thresholds)
      .map(([k, v]) => {
        const spec = v as { default?: unknown } | number | undefined;
        const d = typeof spec === "object" && spec !== null && "default" in spec ? spec.default : spec;
        return d === undefined ? k : `${k}=${asText(d)}`;
      })
      .join(", ");
    facts.push(`thresholds: ${t}`);
  }
  if (node.kind === "store") facts.push(`stores to ${node.target ?? "?"}${node.scope ? ` at ${node.scope} scope` : ""}`);
  if (node.onFailure && node.onFailure !== "fail") facts.push(`on failure: ${node.onFailure}`);
  if (facts.length > 0) parts.push(`[${facts.join("; ")}]`);
  return parts.join(" ");
};

const feedbackLine = (f: DiagramFeedback): string => {
  const via =
    typeof f.promoteVia === "string"
      ? f.promoteVia
      : f.promoteVia && typeof f.promoteVia === "object"
        ? `${f.promoteVia.lane}${f.promoteVia.queue ? ` (${f.promoteVia.queue})` : ""}`
        : null;
  return `- "${f.from}" → ${f.to}${f.form ? ` as a ${f.form}` : ""}${via ? `, promoted via ${via}` : ""}`;
};

/**
 * The pipeline written out as a brief: what it establishes, when it runs,
 * every node in topological order with the branch that reaches it, and the
 * feedback edges. The same brief feeds every level; the level changes the
 * instructions, not the facts.
 */
export const explainBrief = (pipeline: DiagramInput, opts: { title?: string; summary?: string } = {}): string => {
  const byId = new Map<string, DiagramNode>();
  for (const n of pipeline.nodes) byId.set(String((n as DiagramNode).id), n as DiagramNode);
  const order = pipeline.order ?? [...byId.keys()];
  const branchInto = new Map<string, string>();
  for (const e of pipeline.edges) if (e.when?.branch) branchInto.set(e.to, e.when.branch);
  const flow = pipeline.edges.map((e) => `${e.from} → ${e.to}${e.when?.branch ? ` [${e.when.branch}]` : ""}`);

  const lines: string[] = [];
  lines.push(`Pipeline: ${opts.title ?? pipeline.id} (id "${pipeline.id}")`);
  if (opts.summary) lines.push(`One-line summary: ${opts.summary}`);
  if (pipeline.fact) lines.push(`Establishes the fact: ${pipeline.fact}`);
  if (pipeline.trigger?.length) lines.push(`Runs: ${pipeline.trigger.join(", ")}`);
  if (pipeline.result?.length) lines.push(`Produces: ${pipeline.result.join(", ")}`);
  if (pipeline.decidedBy) lines.push(`Highest-ranked decider: ${pipeline.decidedBy}`);
  lines.push("", "Steps, in order:");
  for (const id of order) {
    const node = byId.get(id);
    if (node) lines.push(nodeLine(node, branchInto.get(id) ?? null));
  }
  lines.push("", "Flow:", ...flow.map((f) => `- ${f}`));
  if (pipeline.feedback?.length) {
    lines.push("", "Feedback from people, after a run:", ...pipeline.feedback.map(feedbackLine));
  } else {
    lines.push("", "Feedback from people: none — the run is final once stored.");
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/**
 * The system half. A host may manage its own copy (a prompt store) and pass
 * that version into {@link explainCacheKey}; this is the default.
 */
export const EXPLAIN_SYSTEM_PROMPT = `You explain how an automated decision pipeline works to a reader at a chosen level.

A pipeline is a fixed sequence of steps. Some steps are plain code, some ask a small fast classifier a yes/no question, some ask a writing model to produce text, some are gates where code picks a branch, and one usually stores the result. People may send feedback afterwards, which changes future runs — a run never waits on a person.

You are given the pipeline as a brief and a level. Write for exactly that reader, in Markdown, with no preamble and no sign-off. Never invent a step, a threshold or a feedback path that is not in the brief; if the brief does not say, do not say. Prefer concrete verbs ("checks", "picks", "writes") to abstractions. Write in the language you are asked for.`;

export interface ExplainPromptOptions {
  level: ExplainLevel;
  /** Human title and summary, when the host has them (the brief uses the id otherwise). */
  title?: string;
  summary?: string;
  /** English name of the language to write in. Default English. */
  languageName?: string;
}

/** The user half: the brief plus the level's instructions. */
export const explainUserPrompt = (pipeline: DiagramInput, opts: ExplainPromptOptions): string => {
  const brief = LEVELS[opts.level];
  return [
    `Reader: ${brief.audience}.`,
    `Length: ${brief.length}`,
    `Rules: ${brief.rules}`,
    `Language: ${opts.languageName ?? "English"}.`,
    "",
    "Brief:",
    explainBrief(pipeline, opts),
  ].join("\n");
};

export interface ExplainPrompt {
  system: string;
  user: string;
}

export const explainPrompt = (pipeline: DiagramInput, opts: ExplainPromptOptions): ExplainPrompt => ({
  system: EXPLAIN_SYSTEM_PROMPT,
  user: explainUserPrompt(pipeline, opts),
});

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface Explanation {
  pipeline: string;
  level: ExplainLevel;
  version: string;
  /** Markdown. */
  text: string;
}

/** The host's model call: given system and user text, return the model's text. */
export type ExplainGenerate = (prompt: ExplainPrompt) => Promise<string>;

/**
 * Explain a pipeline at one level through the host's model. Pure apart from
 * the port: the same inputs produce the same prompt, so a host can cache by
 * {@link explainCacheKey} and never ask twice for one version.
 */
export const explainPipeline = async (
  pipeline: DiagramInput,
  opts: ExplainPromptOptions,
  generate: ExplainGenerate,
): Promise<Explanation> => {
  const text = (await generate(explainPrompt(pipeline, opts))).trim();
  return { pipeline: pipeline.id, level: opts.level, version: explainVersion(pipeline), text };
};
