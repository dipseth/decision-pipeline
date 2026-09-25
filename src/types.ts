/**
 * The vocabulary of a decision pipeline (#321, docs/decision-pipelines.md).
 *
 * Nothing in this file imports anything: the type layer is the part that has
 * to survive being lifted out of this monorepo.
 */

// ---------------------------------------------------------------------------
// Scope and rank
// ---------------------------------------------------------------------------

/** Who a signal binds to. NARROWEST FIRST — the order is load-bearing. */
export const SCOPES = [
  "session",
  "device",
  "user",
  "associated",
  "tenant",
  "cohort",
  "global",
] as const;

export type Scope = (typeof SCOPES)[number];

/** Index of a scope in the narrowest-first chain; -1 for an unknown string. */
export const scopeIndex = (scope: Scope): number => SCOPES.indexOf(scope);

/** True when `a` is narrower than (or the same as) `b`. */
export const scopeAtMost = (a: Scope, b: Scope): boolean =>
  scopeIndex(a) <= scopeIndex(b);

/**
 * The widest scope at which `override` and `feature` forms are allowed.
 * At `tenant` and wider only `queue` / `derived` / `score` may be declared —
 * the form x scope rule, which is what keeps one tenant's content out of
 * another tenant's prompt and makes wide conflicts an adjudicated queue
 * rather than a last-write race.
 */
export const DIRECT_FORM_MAX_SCOPE: Scope = "associated";

/**
 * A property of the WRITER, never of the feedback edge. Never downgraded —
 * the rule `aisle-adjudicator.ts` already enforces. WEAKEST FIRST.
 */
export const RANKS = ["heuristic", "llm", "human", "admin"] as const;
export type Rank = (typeof RANKS)[number];

export const rankIndex = (rank: Rank): number => RANKS.indexOf(rank);

/** The stronger of two ranks. A write never lowers the rank of a fact. */
export const maxRank = (a: Rank, b: Rank): Rank =>
  rankIndex(a) >= rankIndex(b) ? a : b;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type NodeKind = "read" | "decide" | "generate" | "code" | "store";

/** `gate` is the only role allowed to branch, and only `code` nodes have roles. */
export type CodeRole = "transform" | "validate" | "derive" | "gate";

export type Trigger = "ingest" | "cron" | "on-demand";

/**
 * `fallback` — run the node's declared `fallback` body instead.
 * `skip`     — treat the node as skipped; downstream sees no output from it.
 * `revert`   — discard this node's work, pass its primary inbound payload through
 *              unchanged (what a model-verify guard wants).
 * `fail`     — abort the run. The default: a pipeline should say so when a
 *              failure is survivable.
 */
export type OnFailure = "fallback" | "skip" | "revert" | "fail";

/** Keyed `node_version + input_hash`, never per pipeline. */
export type CacheMode = "none" | "per-run" | "per-key-forever";

/**
 * A threshold is a literal, or a literal with a named runtime override —
 * exactly how `categoryConfidenceGate()` / `cuisineConfidenceGate()` already
 * behave. The resolved NUMBER lands on the run record so a replay can re-tune
 * it with no model calls.
 */
export type Threshold =
  | number
  | { env: string; default: number }
  | { promptConfig: string; default: number };

/**
 * What a `generate` node may be offered.
 * - `static`: always offered. `"prompt-config"` keeps today's behaviour
 *   (the Langfuse prompt's `config.tools` wins, #291).
 * - `selectable`: candidates a PRECEDING decide node switches on, one Noul per
 *   tool in its existing batched request, turned into a subset by a code gate.
 *   A decide node never attaches a tool itself — same rule as branching.
 * - `allow`: hard ceiling, validated when the manifest loads.
 */
export interface ToolSpec {
  static?: string[] | "prompt-config";
  selectable?: {
    candidates: string[];
    /** decide node id */
    from: string;
    /** code gate node id */
    gate: string;
    /** Noul/Choice value a candidate must clear to be offered. */
    threshold?: Threshold;
  };
  allow?: string[];
}

// ---------------------------------------------------------------------------
// Probes — Jev questions an LLM writes for one run (see ./probes)
// ---------------------------------------------------------------------------

/**
 * A question a `generate` node wrote for Jev. The same three shapes
 * `evaluate()` accepts; `why` is for the hand read and never sent.
 */
export type ProbeQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string }; why?: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string>; why?: string }
  | { type: "score"; instructions: string; criteria: string[]; why?: string };

/** What a decide node declares to ask probes. */
export interface ProbeSpec {
  /** The `generate` node that writes the probes. Must be a DIRECT inbound edge. */
  from: string;
  /** Probes asked per run, 1..MAX_PROBES. Extra ones are dropped, in order. */
  max: number;
  /**
   * State paths a probe may address. When set, a probe's instructions must
   * name at least one of them in backticks (`recipe.ingredients`, or a
   * sub-path of one) — Jev's rule that each question points at its part of
   * the state, enforced rather than hoped for.
   */
  paths?: string[];
  /** Per-probe text ceiling (instructions + criteria). Default 800. */
  maxChars?: number;
}

/** A probe beside its answer — what downstream non-gate nodes see. */
export interface ProbeAnswer {
  /** Slot key, `probe_<n>`. Means nothing across runs. */
  key: string;
  question: ProbeQuestion;
  distribution: number[];
  options: string[];
}

/** A gate's verdict, as later nodes and the record see it. */
export interface BranchTaken {
  branch: string;
  reason?: string;
  confidence?: number;
}

/** What every node body receives. Deliberately uniform — it is what makes a runtime possible. */
export interface NodeRunArgs<I = unknown> {
  /** The pipeline's validated input. */
  input: I;
  /** Outputs of inbound nodes, by node id. A skipped inbound node is ABSENT. */
  from: Record<string, unknown>;
  /**
   * The node's declared `inputs`, resolved (./bindings). Empty when the node
   * declares none. Prefer this over `from.<id>`: a binding is checked when the
   * manifest loads, a `from` read breaks silently when a node is renamed.
   */
  in: Readonly<Record<string, unknown>>;
  /** The output of the node's primary (first declared) inbound edge, or the input at a root. */
  primary: unknown;
  /** Scoped features and overrides. The pipeline never reads a user id. */
  ctx: ScopeContext;
  /** Resolved threshold VALUES for this node — gate bodies read these, never env. */
  thresholds: Record<string, number>;
  node: { id: string; version: string };
  /**
   * Gate id -> the verdict it reached, for gates that have already run.
   * A node never ROUTES on this — only `code` gates branch — but a node that
   * has to RECORD why it was reached (the writer's `direct_skipped_reason`)
   * would otherwise have to recompute the gate, which is how two copies of one
   * decision start disagreeing.
   */
  branches: Readonly<Record<string, BranchTaken>>;
  /**
   * Decide node id -> its answered probes, for decide nodes that already ran.
   * ALWAYS EMPTY for a gate: a threshold must only ever be tuned against
   * questions that exist on every run, so a gate never sees a probe.
   */
  probes: Readonly<Record<string, readonly ProbeAnswer[]>>;
  /** Abort signal for the run, when the host supplied one. */
  signal?: AbortSignal;
}

export type NodeBody<I = unknown> = (
  args: NodeRunArgs<I>,
) => unknown | Promise<unknown>;

/** A gate body returns a branch name, or a branch with the numbers that chose it. */
export type GateResult =
  | string
  | { branch: string; reason?: string; confidence?: number };

export type GateBody<I = unknown> = (
  args: NodeRunArgs<I>,
) => GateResult | Promise<GateResult>;

interface NodeCommon<I> {
  version: string;
  /**
   * Named inputs: binding name -> ref (`"evidence.row"`, `"$input.factor"`,
   * `"maps | retry_maps"`). Resolved into `args.in` and onto decide/generate
   * requests. Refs may only name DIRECT inbound nodes (./bindings).
   */
  inputs?: Record<string, string>;
  onFailure?: OnFailure;
  cache?: CacheMode;
  /** Used only when `onFailure: "fallback"`. */
  fallback?: NodeBody<I>;
  /** Free-form notes that ride onto the span and the JSON export. */
  describe?: string;
}

export interface ReadNode<I = unknown> extends NodeCommon<I> {
  kind: "read";
  load: NodeBody<I>;
  /** Hand this node's scoped features to a downstream decide node. */
  providesFeatures?: boolean;
}

export interface DecideNode<I = unknown> extends NodeCommon<I> {
  kind: "decide";
  /**
   * Jev question prompt name — wording lives in Langfuse (#318), not here.
   * Optional only when `probes` is declared: a probe-only decide node asks
   * nothing but what its writer wrote.
   */
  questions?: string;
  /**
   * Questions an upstream `generate` node writes for this run, asked in the
   * same Jev request as `questions`. Evidence only: gates and `interpret`
   * never see them (./probes).
   */
  probes?: ProbeSpec;
  /** Named state blocks the host resolves and hands to the decide port. */
  state?: string[];
  acceptsFeatures?: boolean;
  /**
   * Turns the port's raw distributions into the value downstream nodes consume.
   * `distributions` are recorded whatever this returns — replay depends on them.
   */
  interpret?: (
    distributions: Record<string, number[]>,
    args: NodeRunArgs<I>,
  ) => unknown;
  /** Batched calls (cuisine sends <=12 recipes) get their own trace; the run stays per-recipe. */
  batched?: boolean;
}

export interface GenerateNode<I = unknown> extends NodeCommon<I> {
  kind: "generate";
  prompt: string;
  route: string;
  submit?: string;
  tools?: ToolSpec;
}

export interface CodeNode<I = unknown> extends NodeCommon<I> {
  kind: "code";
  role: Exclude<CodeRole, "gate">;
  run: NodeBody<I>;
  /**
   * A transform that APPLIES a decision without branching on it — Break it
   * down's `apply` turns Jev's Nouls into cuts at seven thresholds — owns
   * numbers exactly as a gate does: resolved once, handed in as
   * `args.thresholds`, recorded on the node, patchable by an arm or a replay.
   * Making such a node a gate just to reach this would force a branch it
   * does not have.
   */
  thresholds?: Record<string, Threshold>;
}

/** Any code node that declares thresholds — a gate always does, a transform may. */
export const hasThresholds = <I>(
  node: PipelineNode<I>,
): node is GateNode<I> | (CodeNode<I> & { thresholds: Record<string, Threshold> }) =>
  node.kind === "code" && node.thresholds !== undefined;

export interface GateNode<I = unknown> extends NodeCommon<I> {
  kind: "code";
  role: "gate";
  run: GateBody<I>;
  thresholds: Record<string, Threshold>;
  /** Every branch needs an outbound edge — that is the deterministic-fallback rule, checked. */
  branches: string[];
}

export interface StoreNode<I = unknown> extends NodeCommon<I> {
  kind: "store";
  target: "qdrant" | "turso" | "redis" | string;
  scope: Scope;
  ttl?: string;
}

export type PipelineNode<I = unknown> =
  | ReadNode<I>
  | DecideNode<I>
  | GenerateNode<I>
  | CodeNode<I>
  | GateNode<I>
  | StoreNode<I>;

export const isGateNode = <I>(node: PipelineNode<I>): node is GateNode<I> =>
  node.kind === "code" && node.role === "gate";

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export interface Edge {
  from: string;
  to: string;
  /** A node whose EVERY inbound guard is false is skipped, with the reason recorded. */
  when?: { gate: string; branch: string };
}

export type FeedbackSource = "explicit" | "implicit";
export type FeedbackForm =
  | "override"
  | "feature"
  | "queue"
  | "derived"
  | "score";
export type FeedbackLatency = "immediate" | "next-run" | "deferred";

/**
 * A Langfuse score config. Configs are NOT capped per project (queues are), so
 * a lane or a score edge may declare its own categories freely.
 *
 * Both shapes are already in use: `scale_feedback` is NUMERIC (bad 0 / okay
 * 0.5 / good 1) while `step_knowledge_read` is CATEGORICAL with labels, so the
 * contract has to carry a label beside the number.
 */
export interface ScoreConfigSpec {
  name: string;
  dataType: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  /** CATEGORICAL only. */
  categories?: Array<{ label: string; value: number }>;
  description?: string;
}

export interface FeedbackEdge {
  id: string;
  /** A user-facing surface id or a review queue — NOT a node. */
  from: string;
  /** An EARLIER node id. Required even when the effect lands months later. */
  to: string;
  source: FeedbackSource;
  scope: Scope;
  form: FeedbackForm;
  latency: FeedbackLatency;
  /**
   * The Langfuse score this edge writes, on the run's trace. REQUIRED for
   * `form: "score"`; optional elsewhere, because the doc's rule is that the
   * other four forms write a durable row and, where a score is meaningful, a
   * score too — a score is not state.
   */
  score?: ScoreConfigSpec;
  /**
   * Review **lane** (see review.ts), not a queue name. Required to widen a
   * scope, and always for `derived`. Lanes are unlimited and resolve to one of
   * the at-most-three physical annotation queues a Langfuse project allows.
   */
  promoteVia?: string;
  /** What an override/feature binds to — canonical, never a point id. */
  key?: (input: never) => string;
}

// ---------------------------------------------------------------------------
// Scope context
// ---------------------------------------------------------------------------

/** A `feature`-form row addressed to a node, as the runtime hands it to a decide port. */
export interface FeatureRow {
  id: string;
  /** Target node id. */
  nodeId: string;
  scope: Scope;
  rank: Rank;
  value: unknown;
  /** The arm the row was written under, when it was (belt and braces on assignment). */
  arm?: string | null;
  createdAt?: string;
}

/** An `override`-form row. NARROWEST WINS; applied at read, never inside the run. */
export interface OverrideRow {
  id: string;
  key: string;
  scope: Scope;
  rank: Rank;
  value: unknown;
  arm?: string | null;
  createdAt?: string;
}

/**
 * Built by the runtime BEFORE node 0, from whatever ids the request carries.
 * The pipeline's own code never sees a user id.
 */
export interface ScopeContext {
  /** Resolved ids per scope, narrowest first. Absent scopes are simply missing. */
  readonly ids: Readonly<Partial<Record<Scope, string>>>;
  /** MCP scopes this run was granted. A tool needing more is dropped and recorded. */
  readonly grants: readonly string[];
  /** Every feature row addressed to `nodeId`, all scopes concatenated. */
  features(nodeId: string): FeatureRow[];
  /** The SINGLE narrowest override row for a key, or null. */
  override(key: string): OverrideRow | null;
  /** Ids of every feedback row this run actually read — provenance, both ways. */
  consumed(): string[];
}

// ---------------------------------------------------------------------------
// The shared why-panel row
// ---------------------------------------------------------------------------

/**
 * Why panels derive from a code-built change list, never from a model.
 * `ScalingChange` and `ReformulateChange` both fit; `nodeId` is what links a
 * why row back to the span that produced it.
 */
export interface ChangeRow {
  kind: string;
  subject: string;
  before: unknown;
  after: unknown;
  reason: string;
  nodeId: string;
}
