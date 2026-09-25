/**
 * The proposer — a model writes a pipeline spec (./spec) toward a goal, and
 * the compiler's problem list drives its repair loop.
 *
 * The model is a port (`SpecAuthor`), so this file stays host-agnostic and
 * zod-only: the host decides which model, how it is traced and what it costs.
 * One round is: prompt -> reply -> parse JSON -> compile -> vocabulary and
 * base checks. A round with no problems ends the loop; otherwise the next
 * prompt carries the previous reply and EVERY problem, so a model can fix them
 * all at once.
 *
 * Beyond what `compilePipelineSpec` checks, a proposal against a `base` must
 *
 *   keep its contract   same `fact`, `input` and `output` — it will run beside
 *                       the base as an arm, so it must answer the same question
 *                       in the same shape.
 *   stay in vocabulary  prompts, routes, Jev question sets and store targets
 *                       name things the HOST's ports dispatch on. A spec can
 *                       compile against a route no port handles and fail only
 *                       mid-run, so an unknown name is a problem here. The
 *                       default vocabulary is the base's own.
 *   change something    a proposal identical to the base is a wasted arm.
 *
 * What it never does is RUN the proposal. A compiled spec is a candidate; the
 * shadow arm and the replay harness judge it.
 */

import { pipelineSpecJsonSchema, compilePipelineSpec, describeRegistry, type ExpressionEngine, type PipelineSpecJSON, type SpecRegistry } from "./spec";
import { stableStringify } from "./hash";
import type { DecisionPipeline } from "./define";

export interface AuthorRequest {
  /** The spec language, the catalog and the JSON Schema. Identical every round — cacheable. */
  system: string;
  /** Round 1: the goal and the base. Later rounds: the previous reply and its problems. */
  prompt: string;
  /** 1-based. */
  round: number;
  signal?: AbortSignal;
}

/** The model. Returns its reply — text with a JSON object in it, or the object itself. */
export type SpecAuthor = (request: AuthorRequest) => Promise<unknown>;

/** Names a spec may use that the host's ports dispatch on. */
export interface SpecVocabulary {
  prompts: string[];
  routes: string[];
  questions: string[];
  targets: string[];
}

export interface ProposeOptions {
  goal: string;
  registry: SpecRegistry;
  engine: ExpressionEngine;
  author: SpecAuthor;
  /** The spec being varied. Without one the model writes from scratch and only the compiler checks it. */
  base?: PipelineSpecJSON;
  /** Default: the base's own names (nothing, without a base: every name allowed). */
  vocabulary?: Partial<SpecVocabulary>;
  /** Default 3: one write and two repairs. */
  maxRounds?: number;
  signal?: AbortSignal;
}

export interface ProposalRound {
  round: number;
  /** The parsed spec, or null when the reply held no JSON object. */
  spec: unknown;
  problems: string[];
}

export interface SpecDiff {
  nodes: { added: string[]; removed: string[]; changed: string[] };
  edges: { added: string[]; removed: string[] };
  /** Top-level keys other than nodes and edges whose value changed. */
  fields: string[];
}

export interface Proposal<I = unknown, O = unknown> {
  /** Set only when the last round had no problems. */
  spec: PipelineSpecJSON | null;
  pipeline: DecisionPipeline<I, O> | null;
  rounds: ProposalRound[];
  /** The last round's problems — empty on success. */
  problems: string[];
  /** Against `base`, when there is one and the proposal compiled. */
  diff: SpecDiff | null;
}

// ---------------------------------------------------------------------------
// Vocabulary and diff
// ---------------------------------------------------------------------------

type NodeSpec = PipelineSpecJSON["nodes"][string];

/** The host-dispatched names a spec uses. */
export const specVocabulary = (spec: PipelineSpecJSON): SpecVocabulary => {
  const v: SpecVocabulary = { prompts: [], routes: [], questions: [], targets: [] };
  const add = (list: string[], name: string | undefined) => {
    if (name !== undefined && !list.includes(name)) list.push(name);
  };
  for (const n of Object.values(spec.nodes) as NodeSpec[]) {
    if (n.kind === "generate") {
      add(v.prompts, n.prompt);
      add(v.routes, n.route);
    } else if (n.kind === "decide") add(v.questions, n.questions);
    else if (n.kind === "store") add(v.targets, n.target);
  }
  return v;
};

const edgeKey = (e: PipelineSpecJSON["edges"][number]): string =>
  `${e.from} -> ${e.to}${e.when ? ` [${e.when.gate}=${e.when.branch}]` : ""}`;

export const diffSpecs = (base: PipelineSpecJSON, next: PipelineSpecJSON): SpecDiff => {
  const baseIds = Object.keys(base.nodes);
  const nextIds = Object.keys(next.nodes);
  const baseEdges = new Set(base.edges.map(edgeKey));
  const nextEdges = new Set(next.edges.map(edgeKey));
  const b = base as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  return {
    nodes: {
      added: nextIds.filter((id) => !(id in base.nodes)),
      removed: baseIds.filter((id) => !(id in next.nodes)),
      changed: nextIds.filter((id) => id in base.nodes && stableStringify(base.nodes[id]) !== stableStringify(next.nodes[id])),
    },
    edges: {
      added: [...nextEdges].filter((k) => !baseEdges.has(k)),
      removed: [...baseEdges].filter((k) => !nextEdges.has(k)),
    },
    fields: [...new Set([...Object.keys(b), ...Object.keys(n)])]
      .filter((k) => k !== "nodes" && k !== "edges")
      .filter((k) => stableStringify(b[k] ?? null) !== stableStringify(n[k] ?? null)),
  };
};

const isEmptyDiff = (d: SpecDiff): boolean =>
  d.nodes.added.length + d.nodes.removed.length + d.nodes.changed.length + d.edges.added.length + d.edges.removed.length + d.fields.length === 0;

// ---------------------------------------------------------------------------
// Checks beyond the compiler
// ---------------------------------------------------------------------------

const vocabularyProblems = (spec: PipelineSpecJSON, allowed: Partial<SpecVocabulary>): string[] => {
  const problems: string[] = [];
  const check = (where: string, what: string, name: string | undefined, list: string[] | undefined) => {
    if (name === undefined || list === undefined || list.includes(name)) return;
    problems.push(`${where}: unknown ${what} "${name}" — the host handles only ${list.map((x) => `"${x}"`).join(", ") || "none"}`);
  };
  for (const [id, n] of Object.entries(spec.nodes) as Array<[string, NodeSpec]>) {
    const where = `nodes.${id}`;
    if (n.kind === "generate") {
      check(where, "prompt", n.prompt, allowed.prompts);
      check(where, "route", n.route, allowed.routes);
    } else if (n.kind === "decide") check(where, "question set", n.questions, allowed.questions);
    else if (n.kind === "store") check(where, "store target", n.target, allowed.targets);
  }
  return problems;
};

const contractProblems = (spec: PipelineSpecJSON, base: PipelineSpecJSON): string[] =>
  (["fact", "input", "output"] as const)
    .filter((k) => spec[k] !== base[k])
    .map((k) => `${k}: must stay "${base[k]}" (was changed to "${spec[k]}") — a proposal runs beside the base and must decide the same fact in the same shape`);

// ---------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------

/** The JSON object in a reply: a fenced ```json block, else the outermost braces. */
export const extractSpecJson = (reply: unknown): { value: unknown } | { problem: string } => {
  if (reply !== null && typeof reply === "object") return { value: reply };
  if (typeof reply !== "string") return { problem: "the reply was neither text nor an object" };
  const fenced = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const candidates = fenced.length ? fenced : [reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1)];
  let lastError = "no JSON object found";
  // The last fenced block wins: a model that shows a fragment first ends with the whole spec.
  for (const c of candidates.reverse()) {
    if (!c.trim()) continue;
    try {
      const value: unknown = JSON.parse(c);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) return { value };
      lastError = "the JSON is not an object";
    } catch (err) {
      lastError = `the JSON does not parse: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { problem: `reply: ${lastError}. Reply with the whole spec as ONE \`\`\`json block.` };
};

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SPEC_LANGUAGE = `You write decision-pipeline specs: JSON describing a DAG of nodes that decides one fact.

Node kinds:
- read: loads data by calling a registered primitive (\`call\`: "id@version").
- decide: asks Jev (a probabilistic evaluator) a named question set (\`questions\`), or answers \`probes\` written upstream.
- generate: an LLM call; \`prompt\` and \`route\` name what the host runs.
- code: one of
    call   a registered primitive with \`args\` (each arg a JSONata expression), or with its \`inputs\` as args;
    rules  a gate (role "gate"): ordered { when, branch, reason?, confidence? }, first match wins, the LAST rule has no \`when\`; every branch needs a rule;
    expr   a pure JSONata expression (mapping, validation);
    assert [{ that, message }] — every \`that\` must be truthy;
    inputs alone: the node's output is its bindings.
- store: persists the result (\`target\`, \`scope\`).

Data flow:
- \`inputs\`: { name: "node.path | default" } — a ref names a node with an edge INTO this node. A default after \`|\` is JSON.
  "$input.x" reads the pipeline input.
- An expression's root is the node's \`inputs\` (when declared), else an object keyed by the ids of nodes with an edge into it.
- Expression bindings: $input, $t (the node's thresholds), $primary, $branches, $probes (never inside a gate), plus the registry's $functions.
- A gate passes its input through: downstream of gate "route", read what reached it as \`route.<name>\`.
- Edges: { from, to } or, out of a gate, { from, to, when: { gate, branch } }.
- \`result\` lists the pipeline's routes: the branches that end in its answer.
- \`thresholds\`: { name: number } or { name: { env, default } }.
- Every node has a \`version\` string. Keep a node's version when you keep its meaning; bump it when you change what it does.

Only use primitives, functions and schemas from the catalog. Reuse the base's prompts, routes, question sets and store targets; you cannot invent new ones.

Reply with a one-paragraph rationale, then the WHOLE spec as ONE \`\`\`json block.`;

const systemPrompt = (registry: SpecRegistry): string =>
  [
    SPEC_LANGUAGE,
    "## Catalog\n```json\n" + JSON.stringify(describeRegistry(registry), null, 2) + "\n```",
    "## Spec JSON Schema\n```json\n" + JSON.stringify(pipelineSpecJsonSchema()) + "\n```",
  ].join("\n\n");

const firstPrompt = (goal: string, base: PipelineSpecJSON | undefined, vocabulary: Partial<SpecVocabulary>): string => {
  const parts = [`## Goal\n${goal}`];
  if (base) parts.push("## Base spec (vary this)\n```json\n" + JSON.stringify(base, null, 2) + "\n```");
  const names = Object.entries(vocabulary).filter(([, v]) => v !== undefined);
  if (names.length) parts.push("## Host names you may use\n" + names.map(([k, v]) => `- ${k}: ${(v as string[]).join(", ") || "(none)"}`).join("\n"));
  return parts.join("\n\n");
};

const repairPrompt = (goal: string, previous: unknown, problems: string[]): string =>
  [
    `## Goal\n${goal}`,
    "## Your previous spec\n```json\n" + (previous === null ? "(none — the reply held no JSON object)" : JSON.stringify(previous, null, 2)) + "\n```",
    `## Problems (fix ALL of them)\n${problems.map((p) => `- ${p}`).join("\n")}`,
  ].join("\n\n");

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export const proposePipelineSpec = async <I = unknown, O = unknown>(opts: ProposeOptions): Promise<Proposal<I, O>> => {
  const { goal, registry, engine, author, base, signal } = opts;
  const maxRounds = Math.max(1, opts.maxRounds ?? 3);
  const vocabulary: Partial<SpecVocabulary> = { ...(base ? specVocabulary(base) : {}), ...opts.vocabulary };
  const system = systemPrompt(registry);
  const rounds: ProposalRound[] = [];

  let prompt = firstPrompt(goal, base, vocabulary);
  for (let round = 1; round <= maxRounds; round++) {
    signal?.throwIfAborted();
    const reply = await author({ system, prompt, round, ...(signal ? { signal } : {}) });
    const extracted = extractSpecJson(reply);
    if ("problem" in extracted) {
      rounds.push({ round, spec: null, problems: [extracted.problem] });
      prompt = repairPrompt(goal, null, [extracted.problem]);
      continue;
    }
    const compiled = compilePipelineSpec<I, O>(extracted.value, registry, engine);
    let problems = compiled.problems;
    // Only a spec that parsed has fields to hold against the base and the vocabulary.
    if (compiled.pipeline) {
      const spec = extracted.value as PipelineSpecJSON;
      problems = [...vocabularyProblems(spec, vocabulary), ...(base ? contractProblems(spec, base) : [])];
      const diff = base ? diffSpecs(base, spec) : null;
      if (diff && isEmptyDiff(diff)) problems.push("the proposal is identical to the base — change something toward the goal");
      if (problems.length === 0) {
        rounds.push({ round, spec, problems });
        return { spec, pipeline: compiled.pipeline, rounds, problems, diff };
      }
    }
    rounds.push({ round, spec: extracted.value, problems });
    prompt = repairPrompt(goal, extracted.value, problems);
  }
  return { spec: null, pipeline: null, rounds, problems: rounds[rounds.length - 1]!.problems, diff: null };
};
