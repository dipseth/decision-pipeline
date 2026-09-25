/**
 * `definePipeline` — the manifest, and the contract check that makes it one.
 *
 * The seven clauses of the definition in docs/decision-pipelines.md are not
 * prose here; six of the seven are checked, and a manifest that fails any of
 * them will not load. Clause 7 (one run = one trace) is the runtime's.
 */

import type { ZodType } from "zod";
import { PipelineContractError } from "./errors";
import {
  widestDirectFeedbackScope,
  type ExperimentSpec,
  type ManifestPatch,
} from "./experiments";
import { bindingProblems } from "./bindings";
import { topologicalOrder } from "./graph";
import { hasGateMetric, gateMetricNames } from "./record";
import { hasLane, laneNames, REVIEW_QUEUE_BUDGET } from "./review";
import { pipelineDeclarationSchema, zodProblems } from "./schema";
import {
  DIRECT_FORM_MAX_SCOPE,
  hasThresholds,
  isGateNode,
  scopeAtMost,
  scopeIndex,
  type Edge,
  type FeedbackEdge,
  type PipelineNode,
  type Rank,
  type Scope,
  type ScopeContext,
  type Trigger,
} from "./types";

export interface PipelineSpec<I = unknown, O = unknown> {
  /** "scale" | "cuisine" | "breakdown" | ... */
  id: string;
  /** The persisted field name. Metadata is `${fact}_*`. */
  fact: string;
  input: ZodType<I>;
  output: ZodType<O>;
  trigger: Trigger[];
  /** Langfuse grouping key, e.g. `cook-${recipeId}`. Named `group`, not `session`. */
  group: (input: I) => string;
  nodes: Record<string, PipelineNode<I>>;
  edges: Edge[];
  feedback: FeedbackEdge[];
  /**
   * Which node's output IS the fact. A list when the producing node is
   * branch-dependent: the FIRST one that ran wins.
   *
   * Not in the draft schema — added because the graph's sink is usually the
   * `store` node, whose output is not the fact.
   */
  result: string | string[];
  /**
   * Absent = the output is final. Present = a human may layer over it at this
   * scope. The override is applied AT READ (`applyOverride`), never inside the
   * run — a pipeline with zero overrides recorded is not degraded.
   */
  overridable?: {
    scope: Scope;
    /** The authoritative read-time key. Canonical, never a point id. */
    key: (output: O) => string;
    /**
     * The same key when it is derivable from the INPUT, so the scope resolver
     * can query one key instead of every override row for the caller.
     */
    keyFromInput?: (input: I) => string;
  };
  /** Mandatory: a gate without a frozen eval cannot be tuned. */
  eval: { dataset: string; gateMetric: string };
  experiments?: ExperimentSpec[];
  /** Rank this pipeline writes at. Default `llm`; a code-only pipeline is `heuristic`. */
  decidedBy?: Rank;
  /** Two producers of one field must declare which wins. */
  precedence?: { over: string[] };
  /**
   * Domain features for the run record, merged over the pipeline-agnostic ones
   * (distribution margins and entropies). Flat, numeric, pipeline-named — the
   * shared layer between pipelines is these extractors and the record schema,
   * not any weights.
   */
  features?: (args: FeatureExtractionArgs<I>) => Record<string, number>;
  /** Folded into the composite version hash. */
  knowledgeVersion?: string;
}

export interface FeatureExtractionArgs<I = unknown> {
  input: I;
  /** Every node's output, by node id. A skipped node is absent. */
  outputs: ReadonlyMap<string, unknown>;
  /** Gate node id -> branch taken. */
  branches: ReadonlyMap<string, string>;
  ctx: ScopeContext;
}

export interface PipelineJSON {
  id: string;
  fact: string;
  trigger: Trigger[];
  result: string[];
  decidedBy: Rank;
  overridable: { scope: Scope } | null;
  eval: { dataset: string; gateMetric: string };
  precedence: { over: string[] } | null;
  nodes: Array<Record<string, unknown>>;
  edges: Edge[];
  feedback: Array<Omit<FeedbackEdge, "key"> & { key: boolean }>;
  experiments: Array<Omit<ExperimentSpec, "arms"> & { arms: Record<string, ManifestPatch> }>;
  order: string[];
}

export interface DecisionPipeline<I = unknown, O = unknown>
  extends PipelineSpec<I, O> {
  readonly result: string[];
  readonly decidedBy: Rank;
  /** Topological node order, tie-broken by declaration order. Computed once. */
  readonly order: readonly string[];
  /**
   * The declarative half as plain data — for diagrams, docs, the run record and
   * the training set. YAML is an EXPORT, never the source.
   */
  toJSON(): PipelineJSON;
}

// ---------------------------------------------------------------------------
// Contract validation
// ---------------------------------------------------------------------------

/** Every node id reachable backwards from `nodeId` along flow edges. */
export const ancestorsOf = (edges: readonly Edge[], nodeId: string): Set<string> => {
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    for (const edge of edges) {
      if (edge.to !== current || seen.has(edge.from)) continue;
      seen.add(edge.from);
      stack.push(edge.from);
    }
  }
  return seen;
};

const asArray = (value: string | string[]): string[] =>
  Array.isArray(value) ? value : [value];

/**
 * Returns every contract violation, rather than the first — a manifest author
 * should see the whole list, not play whack-a-mole.
 */
export const validatePipeline = <I, O>(spec: PipelineSpec<I, O>): string[] => {
  const problems: string[] = [];

  // --- the declarative half, through zod
  const declaration = pipelineDeclarationSchema.safeParse({
    id: spec.id,
    fact: spec.fact,
    trigger: spec.trigger,
    nodes: spec.nodes,
    edges: spec.edges,
    feedback: spec.feedback,
    result: spec.result,
    overridable: spec.overridable ? { scope: spec.overridable.scope } : undefined,
    eval: spec.eval,
    experiments: spec.experiments,
    decidedBy: spec.decidedBy,
    precedence: spec.precedence,
    knowledgeVersion: spec.knowledgeVersion,
  });
  if (!declaration.success) problems.push(...zodProblems(declaration.error));

  const nodeIds = Object.keys(spec.nodes);
  const node = (id: string): PipelineNode<I> | undefined => spec.nodes[id];

  if (nodeIds.length === 0) problems.push("no nodes declared");
  if (typeof spec.group !== "function") problems.push("`group(input)` is required");
  if (typeof (spec.input as { parse?: unknown })?.parse !== "function") {
    problems.push("`input` must be a zod schema");
  }
  if (typeof (spec.output as { parse?: unknown })?.parse !== "function") {
    problems.push("`output` must be a zod schema");
  }

  // --- edges reference real nodes, and the graph is a DAG
  for (const edge of spec.edges) {
    if (!node(edge.from)) problems.push(`edge ${edge.from} -> ${edge.to}: unknown node "${edge.from}"`);
    if (!node(edge.to)) problems.push(`edge ${edge.from} -> ${edge.to}: unknown node "${edge.to}"`);
  }
  const { cycle } = topologicalOrder(nodeIds, spec.edges);
  if (cycle.length > 0) {
    problems.push(`flow edges form a cycle through: ${cycle.join(", ")}`);
  }

  // --- clause 2: at least one gate, and only `code` branches
  const gates = nodeIds.filter((id) => {
    const n = node(id);
    return n !== undefined && isGateNode(n);
  });
  if (gates.length === 0) {
    problems.push(
      "no gate node: a DAG without a code gate is a chain, not a decision pipeline",
    );
  }

  for (const edge of spec.edges) {
    if (!edge.when) continue;
    const gate = node(edge.when.gate);
    if (!gate) {
      problems.push(`edge ${edge.from} -> ${edge.to}: guard names unknown node "${edge.when.gate}"`);
      continue;
    }
    if (!isGateNode(gate)) {
      problems.push(
        `edge ${edge.from} -> ${edge.to}: guard names "${edge.when.gate}", which is a ${gate.kind} node — only a code gate may branch`,
      );
      continue;
    }
    if (!gate.branches.includes(edge.when.branch)) {
      problems.push(
        `edge ${edge.from} -> ${edge.to}: gate "${edge.when.gate}" has no branch "${edge.when.branch}" (has: ${gate.branches.join(", ")})`,
      );
    }
  }

  // --- clause 3: every branch has somewhere to go
  for (const gateId of gates) {
    const gate = node(gateId);
    if (!gate || !isGateNode(gate)) continue;
    for (const branch of gate.branches) {
      const taken = spec.edges.some(
        (e) => e.when?.gate === gateId && e.when.branch === branch,
      );
      if (!taken) {
        problems.push(
          `gate "${gateId}" declares branch "${branch}" with no outbound edge — every branch needs a deterministic destination`,
        );
      }
    }
  }

  // --- clause 4: at least one feedback edge, landing on a real node
  if (spec.feedback.length === 0) {
    problems.push(
      "no feedback edge: a DAG with no human signal connected to it is a chain, not a decision pipeline",
    );
  }
  const feedbackIds = new Set<string>();
  for (const edge of spec.feedback) {
    if (feedbackIds.has(edge.id)) problems.push(`duplicate feedback edge id "${edge.id}"`);
    feedbackIds.add(edge.id);

    if (!node(edge.to)) {
      problems.push(`feedback "${edge.id}": lands on unknown node "${edge.to}"`);
    }
    // The form x scope rule.
    if (
      (edge.form === "override" || edge.form === "feature") &&
      !scopeAtMost(edge.scope, DIRECT_FORM_MAX_SCOPE)
    ) {
      problems.push(
        `feedback "${edge.id}": form "${edge.form}" is not allowed at scope "${edge.scope}" — at "${DIRECT_FORM_MAX_SCOPE}" and wider, only queue / derived / score`,
      );
    }
    // A structural change is always reviewable and revertable, never silent drift.
    if (edge.form === "derived" && !edge.promoteVia) {
      problems.push(
        `feedback "${edge.id}": form "derived" changes the pipeline's questions, so it needs a \`promoteVia\` review queue`,
      );
    }
    if (edge.form === "queue" && !edge.promoteVia) {
      problems.push(`feedback "${edge.id}": form "queue" needs a \`promoteVia\` lane`);
    }

    // A `score` edge that never names its Langfuse score has no landing spot,
    // which is the one thing clause 4 does not allow.
    if (edge.form === "score" && !edge.score) {
      problems.push(
        `feedback "${edge.id}": form "score" must declare a \`score\` config — otherwise the signal has no Langfuse score to land on`,
      );
    }
    if (edge.score) {
      if (edge.score.dataType === "CATEGORICAL" && !edge.score.categories?.length) {
        problems.push(
          `feedback "${edge.id}": score "${edge.score.name}" is CATEGORICAL but declares no categories`,
        );
      }
      if (edge.score.dataType !== "CATEGORICAL" && edge.score.categories?.length) {
        problems.push(
          `feedback "${edge.id}": score "${edge.score.name}" declares categories but is ${edge.score.dataType}`,
        );
      }
    }

    // A lane, NOT a queue: Langfuse caps annotation queues per project, so a
    // queue per pipeline does not scale. An unregistered lane is a load error
    // rather than a console warning in production with nothing enqueued.
    if (edge.promoteVia && !hasLane(edge.promoteVia)) {
      problems.push(
        `feedback "${edge.id}": lane "${edge.promoteVia}" is not registered — call defineReviewLane({ lane, queue }) (registered: ${laneNames().join(", ") || "none"}; queues are capped at ${REVIEW_QUEUE_BUDGET} per Langfuse project, lanes are free)`,
      );
    }
  }

  // --- clause 6: separability needs the pipeline's own answer persisted
  const stores = nodeIds.filter((id) => node(id)?.kind === "store");
  if (spec.overridable && stores.length === 0) {
    problems.push(
      "`overridable` is declared but no store node persists the pipeline's own answer — an override that mutates is not separable",
    );
  }

  // --- the fact has a producer
  for (const id of asArray(spec.result)) {
    if (!node(id)) problems.push(`result: unknown node "${id}"`);
    else if (node(id)?.kind === "store") {
      problems.push(
        `result: "${id}" is a store node — result must name the node that PRODUCES the fact, not the one that writes it`,
      );
    }
  }

  // --- eval binding: a named extractor, not an ad-hoc query
  if (spec.eval?.gateMetric && !hasGateMetric(spec.eval.gateMetric)) {
    problems.push(
      `eval.gateMetric "${spec.eval.gateMetric}" is not a registered gate metric (known: ${gateMetricNames().join(", ") || "none"}) — define it with defineGateMetric() so the offline eval and an online split compute the same number`,
    );
  }

  // --- per-node checks
  for (const id of nodeIds) {
    const n = node(id);
    if (!n) continue;

    if (n.inputs) {
      const directInbound = new Set(spec.edges.filter((e) => e.to === id).map((e) => e.from));
      problems.push(...bindingProblems(id, n.inputs, directInbound));
    }

    if (n.onFailure === "fallback" && typeof n.fallback !== "function") {
      problems.push(`node "${id}": onFailure "fallback" needs a \`fallback\` body`);
    }
    if (n.kind === "store" && n.cache && n.cache !== "none") {
      problems.push(`node "${id}": a store node may not be cached — a cached write is a missing write`);
    }
    if (n.onFailure === "revert") {
      const inbound = spec.edges.filter((e) => e.to === id);
      if (inbound.length === 0) {
        problems.push(`node "${id}": onFailure "revert" needs an inbound edge to revert to`);
      }
    }

    if (n.kind === "decide") {
      if (!n.questions && !n.probes) {
        problems.push(`node "${id}": a decide node needs \`questions\`, \`probes\`, or both`);
      }
      if (n.probes) {
        // A DIRECT inbound edge, not merely upstream: the runtime reads the
        // probes out of `from`, which only carries direct inbound outputs.
        const writer = node(n.probes.from);
        if (!writer) {
          problems.push(`node "${id}": probes.from names unknown node "${n.probes.from}"`);
        } else if (writer.kind !== "generate") {
          problems.push(
            `node "${id}": probes.from must be a generate node — probes are written by a model — but "${n.probes.from}" is ${writer.kind}`,
          );
        } else if (!spec.edges.some((e) => e.from === n.probes?.from && e.to === id)) {
          problems.push(
            `node "${id}": probes.from "${n.probes.from}" needs a direct edge ${n.probes.from} -> ${id}`,
          );
        }
        // A cache hit restores the node's value but not the answers beside it,
        // which downstream nodes read through `args.probes`.
        if (n.cache && n.cache !== "none") {
          problems.push(`node "${id}": a decide node with probes may not be cached — its probe answers would not be restored`);
        }
      }
    }

    if (n.kind === "generate" && n.tools) {
      const tools = n.tools;
      const allow = tools.allow ? new Set(tools.allow) : null;
      if (allow && Array.isArray(tools.static)) {
        for (const name of tools.static) {
          if (!allow.has(name)) {
            problems.push(`node "${id}": static tool "${name}" is outside \`allow\``);
          }
        }
      }
      const selectable = tools.selectable;
      if (selectable) {
        if (allow) {
          for (const name of selectable.candidates) {
            if (!allow.has(name)) {
              problems.push(`node "${id}": selectable candidate "${name}" is outside \`allow\``);
            }
          }
        }
        const upstream = ancestorsOf(spec.edges, id);
        const source = node(selectable.from);
        if (!source) {
          problems.push(`node "${id}": tools.selectable.from names unknown node "${selectable.from}"`);
        } else if (source.kind !== "decide") {
          problems.push(
            `node "${id}": tools.selectable.from must be a decide node, but "${selectable.from}" is ${source.kind}`,
          );
        } else if (!upstream.has(selectable.from)) {
          problems.push(
            `node "${id}": tools.selectable.from "${selectable.from}" is not upstream — selection has to be decided before the writer runs`,
          );
        }
        const gate = node(selectable.gate);
        if (!gate) {
          problems.push(`node "${id}": tools.selectable.gate names unknown node "${selectable.gate}"`);
        } else if (!isGateNode(gate)) {
          problems.push(
            `node "${id}": tools.selectable.gate must be a code gate, but "${selectable.gate}" is ${gate.kind}`,
          );
        } else if (!upstream.has(selectable.gate)) {
          problems.push(`node "${id}": tools.selectable.gate "${selectable.gate}" is not upstream`);
        }
      }
    }
  }

  // --- experiments
  const widest = widestDirectFeedbackScope(spec.feedback);
  const experimentIds = new Set<string>();
  for (const exp of spec.experiments ?? []) {
    if (experimentIds.has(exp.id)) problems.push(`duplicate experiment id "${exp.id}"`);
    experimentIds.add(exp.id);

    if (!Object.prototype.hasOwnProperty.call(exp.arms, exp.champion)) {
      problems.push(`experiment "${exp.id}": champion "${exp.champion}" is not one of its arms`);
    }
    if (Object.keys(exp.arms).length < 2) {
      problems.push(`experiment "${exp.id}": needs at least two arms`);
    }
    if (widest !== null && scopeIndex(exp.unit) < scopeIndex(widest)) {
      problems.push(
        `experiment "${exp.id}": assignment unit "${exp.unit}" is narrower than "${widest}", the widest scope a feedback edge writes to — arms would contaminate each other`,
      );
    }
    for (const [armName, patch] of Object.entries(exp.arms)) {
      problems.push(
        ...validatePatch(spec, patch).map((p) => `experiment "${exp.id}" arm "${armName}": ${p}`),
      );
    }
  }

  return problems;
};

/** A patch may only touch the declarative half, and only fields the node kind has. */
export const validatePatch = <I, O>(
  spec: PipelineSpec<I, O>,
  patch: ManifestPatch,
): string[] => {
  const problems: string[] = [];
  const expect = (
    nodeId: string,
    field: string,
    predicate: (n: PipelineNode<I>) => boolean,
    want: string,
  ): void => {
    const n = spec.nodes[nodeId];
    if (!n) problems.push(`${field} patches unknown node "${nodeId}"`);
    else if (!predicate(n)) problems.push(`${field} patches "${nodeId}", which is not ${want}`);
  };

  for (const [nodeId, values] of Object.entries(patch.thresholds ?? {})) {
    expect(nodeId, "thresholds", (n) => hasThresholds(n), "a code node that declares thresholds");
    const n = spec.nodes[nodeId];
    if (n && hasThresholds(n)) {
      for (const name of Object.keys(values)) {
        if (!Object.prototype.hasOwnProperty.call(n.thresholds, name)) {
          problems.push(`thresholds patch "${nodeId}.${name}" is not a threshold the node declares`);
        }
      }
    }
  }
  for (const nodeId of Object.keys(patch.prompts ?? {})) {
    expect(nodeId, "prompts", (n) => n.kind === "generate", "a generate node");
  }
  for (const nodeId of Object.keys(patch.routes ?? {})) {
    expect(nodeId, "routes", (n) => n.kind === "generate", "a generate node");
  }
  for (const nodeId of Object.keys(patch.tools ?? {})) {
    expect(nodeId, "tools", (n) => n.kind === "generate", "a generate node");
  }
  for (const nodeId of Object.keys(patch.questions ?? {})) {
    expect(nodeId, "questions", (n) => n.kind === "decide", "a decide node");
  }
  for (const guard of patch.guards ?? []) {
    const exists = spec.edges.some((e) => e.from === guard.from && e.to === guard.to);
    if (!exists) {
      problems.push(
        `guards patch ${guard.from} -> ${guard.to}: no such edge — a variant patches guards, it does not add edges`,
      );
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------
// definePipeline
// ---------------------------------------------------------------------------

const nodeToJSON = (id: string, n: PipelineNode<unknown>): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    id,
    kind: n.kind,
    version: n.version,
    onFailure: n.onFailure ?? "fail",
    cache: n.cache ?? "none",
  };
  if (n.describe) base.describe = n.describe;
  if (n.inputs) base.inputs = { ...n.inputs };
  switch (n.kind) {
    case "read":
      if (n.providesFeatures) base.providesFeatures = true;
      break;
    case "decide":
      if (n.questions) base.questions = n.questions;
      if (n.probes) base.probes = { ...n.probes };
      if (n.state) base.state = n.state;
      if (n.acceptsFeatures) base.acceptsFeatures = true;
      if (n.batched) base.batched = true;
      break;
    case "generate":
      base.prompt = n.prompt;
      base.route = n.route;
      if (n.submit) base.submit = n.submit;
      if (n.tools) base.tools = n.tools;
      break;
    case "code":
      base.role = n.role;
      if (n.thresholds) base.thresholds = n.thresholds;
      if (isGateNode(n)) base.branches = n.branches;
      break;
    case "store":
      base.target = n.target;
      base.scope = n.scope;
      if (n.ttl) base.ttl = n.ttl;
      break;
  }
  return base;
};

export const definePipeline = <I, O>(
  spec: PipelineSpec<I, O>,
): DecisionPipeline<I, O> => {
  const problems = validatePipeline(spec);
  if (problems.length > 0) throw new PipelineContractError(spec.id, problems);

  const result = asArray(spec.result);
  const decidedBy: Rank = spec.decidedBy ?? "llm";
  const { order } = topologicalOrder(Object.keys(spec.nodes), spec.edges);

  const pipeline: DecisionPipeline<I, O> = {
    ...spec,
    result,
    decidedBy,
    order: Object.freeze(order),
    toJSON(): PipelineJSON {
      return {
        id: spec.id,
        fact: spec.fact,
        trigger: [...spec.trigger],
        result: [...result],
        decidedBy,
        overridable: spec.overridable ? { scope: spec.overridable.scope } : null,
        eval: { ...spec.eval },
        precedence: spec.precedence ? { over: [...spec.precedence.over] } : null,
        nodes: Object.entries(spec.nodes).map(([id, n]) =>
          nodeToJSON(id, n as PipelineNode<unknown>),
        ),
        edges: spec.edges.map((e) => ({ ...e })),
        feedback: spec.feedback.map(({ key, ...rest }) => ({
          ...rest,
          key: typeof key === "function",
        })),
        experiments: (spec.experiments ?? []).map((e) => ({ ...e })),
        order: [...order],
      };
    },
  };

  return Object.freeze(pipeline);
};
