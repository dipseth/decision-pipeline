/**
 * Ports — every side effect the runtime needs, as an interface the HOST
 * implements. Nothing in this package imports Langfuse, Qdrant, Turso, the AI
 * SDK or the tool registry; that is what keeps the core liftable and what
 * makes the whole thing testable with fakes (see ./testing).
 */

import type { ManifestPatch } from "./experiments";
import type { RunObserver } from "./observers";
import type { ResolvedTools, ToolRegistry } from "./tools";
import type { RunRecord } from "./record";
import type { ThresholdSource } from "./thresholds";
import type {
  BranchTaken,
  FeatureRow,
  OverrideRow,
  ProbeAnswer,
  ProbeQuestion,
  Rank,
  Scope,
  ScopeContext,
  ScoreConfigSpec,
  Trigger,
} from "./types";

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

export interface SpanHandle {
  /** `getTraceId(root)` is the RUN ID. Null when the host is running untraced. */
  readonly traceId: string | null;
  setMetadata(metadata: Record<string, unknown>): void;
  setOutput(output: unknown): void;
  /**
   * Add trace tags AFTER the root opened. Some tags are only knowable once the
   * run has happened — which branch it took, whether a prompt override was in
   * play — and a tag is the only thing Langfuse filters on cheaply. Optional:
   * a tracer that cannot amend tags simply does not implement it.
   */
  setTags?(tags: readonly string[]): void;
}

export interface RootSpanOpts {
  /** Always `pipeline:<id>`. */
  name: string;
  input: unknown;
  /** The manifest's `group(input)` — Langfuse `session.id`. */
  group: string;
  tags: string[];
  metadata: Record<string, unknown>;
  /**
   * Who the run is attributed to, from the scope context's `user` id. Without
   * it a trace cannot be filtered by person, which is most of what a hand read
   * does.
   */
  userId?: string | null;
}

export interface NodeSpanOpts {
  name: string;
  input: unknown;
  metadata: Record<string, unknown>;
}

/**
 * Callback-shaped on purpose: OTel needs an active-span callback for children
 * to nest, which is exactly what `withRecipesObservation` already does. An
 * imperative start/end port could not be adapted to it.
 */
export interface TracePort {
  root<T>(opts: RootSpanOpts, fn: (span: SpanHandle) => Promise<T>): Promise<T>;
  span<T>(opts: NodeSpanOpts, fn: (span: SpanHandle) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Decide (Jev)
// ---------------------------------------------------------------------------

export interface DecideRequest {
  nodeId: string;
  nodeVersion: string;
  /**
   * Jev question prompt name (#318). Wording lives in Langfuse, not in the
   * manifest. Null on a probe-only node.
   */
  questions: string | null;
  /**
   * Probes to ask in the SAME request, keyed by slot (`probe_0`, …) — already
   * validated, capped and de-duplicated. Return a distribution under each
   * slot key (and its option keys in `distributionOptions`); a slot with no
   * distribution is recorded as unanswered. Empty when the node has none.
   */
  probes: Record<string, ProbeQuestion>;
  /** Named state blocks the host resolves. */
  state: string[];
  /** Scoped `feature` rows addressed to this node, when `acceptsFeatures`. */
  features: FeatureRow[];
  input: unknown;
  from: Record<string, unknown>;
  /** The node's resolved `inputs` (./bindings); empty when it declares none. */
  in: Readonly<Record<string, unknown>>;
  batched: boolean;
  signal?: AbortSignal;
}

export interface DecideResult {
  /** MANDATORY. Offline replay is impossible without it. */
  distributions: Record<string, number[]>;
  /** Option keys per distribution, in the same order as its numbers. */
  distributionOptions?: Record<string, string[]>;
  /** What downstream nodes consume, when the node has no `interpret`. */
  value?: unknown;
  costUsd?: number;
  /** A batched call gets its own trace; each run records the id and a pro-rata cost. */
  batchTraceId?: string;
}

export type DecidePort = (request: DecideRequest) => Promise<DecideResult>;

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

export interface GenerateRequest {
  nodeId: string;
  nodeVersion: string;
  prompt: string;
  route: string;
  submit?: string;
  tools: ResolvedTools;
  input: unknown;
  from: Record<string, unknown>;
  /** The node's resolved `inputs` (./bindings); empty when it declares none. */
  in: Readonly<Record<string, unknown>>;
  primary: unknown;
  ctx: ScopeContext;
  /** Gate verdicts already reached — for metadata, never for routing. */
  branches: Readonly<Record<string, BranchTaken>>;
  /** Answered probes from decide nodes that already ran — evidence for the writer. */
  probes: Readonly<Record<string, readonly ProbeAnswer[]>>;
  signal?: AbortSignal;
}

export interface GenerateResult {
  value: unknown;
  costUsd?: number;
  toolsCalled?: string[];
  /** Feeds the composite version hash. */
  promptVersion?: string;
  /** Root-trace tags this node earned, e.g. `prompt-override`. */
  tags?: readonly string[];
}

export type GeneratePort = (request: GenerateRequest) => Promise<GenerateResult>;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StoreRequest {
  nodeId: string;
  target: string;
  scope: Scope;
  ttl?: string;
  /** The persisted field name. Metadata is `${fact}_*`. */
  fact: string;
  value: unknown;
  route: string;
  confidence: number | null;
  version: string;
  runId: string | null;
  decidedBy: Rank;
  /**
   * FALSE for a shadow challenger. Without this the first shadow test silently
   * overwrites production facts with challenger output.
   */
  writesFact: boolean;
  ctx: ScopeContext;
}

export type StorePort = (request: StoreRequest) => Promise<void>;

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export interface ScopeResolveRequest {
  pipeline: string;
  /** Node ids that accept features, so a resolver can query narrowly. */
  featureNodes: string[];
  /** The manifest's override key for this run's output, when overridable. */
  overrideKey: string | null;
  input: unknown;
}

export interface ScopeResolveResult {
  ids?: Partial<Record<Scope, string>>;
  /** MCP scopes this run was granted. */
  grants?: readonly string[];
  features?: readonly FeatureRow[];
  overrides?: readonly OverrideRow[];
}

export type ScopeResolver = (
  request: ScopeResolveRequest,
) => Promise<ScopeResolveResult> | ScopeResolveResult;

// ---------------------------------------------------------------------------
// Prompts, cache, records
// ---------------------------------------------------------------------------

export interface PromptResolution {
  version: string | null;
  /** What `tools.static: "prompt-config"` resolves to — Langfuse wins, as today. */
  tools?: readonly string[];
}

/** Resolved once per run, before node 0, so the version hash can include it. */
export type PromptResolver = (
  ref: string,
) => Promise<PromptResolution> | PromptResolution;

export interface CachePort {
  /** Key is `${pipeline}:${nodeId}:${nodeVersion}:${inputHash}`. */
  get(key: string): Promise<unknown | undefined> | unknown | undefined;
  set(key: string, value: unknown): Promise<void> | void;
}

/**
 * Sugar for the one observer every host wants. Implemented AS an observer
 * (`recordSinkObserver`), so there is one notification path — which also means
 * a sink that throws no longer fails the run. See ./observers for the rule
 * that keeps `tracer` and `cache` ports while this became a watcher (#325).
 */
export type RunRecordSink = (record: RunRecord) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Human signal — scores, review queues, datasets
// ---------------------------------------------------------------------------

export interface ScoreRequest {
  /** The run's trace id. Scores attach HERE, which is why the run id is the trace id. */
  runId: string;
  /** Langfuse score name; also the score config's name. */
  name: string;
  value: number;
  /** CATEGORICAL only. */
  label?: string;
  dataType: ScoreConfigSpec["dataType"];
  /** What a hand read sees next to the number. */
  comment?: string;
  /** The config to create-if-missing, so a name never lands without its categories. */
  config?: ScoreConfigSpec;
  /** Attributes the score, when the host tracks one. */
  userId?: string | null;
}

/** Best-effort by contract: Langfuse being down must never block a feedback row. */
export type ScorePort = (request: ScoreRequest) => Promise<void> | void;

export interface QueueRequest {
  /** The run's trace id — the queue item's object. */
  runId: string;
  /** The PHYSICAL Langfuse queue, already resolved from the lane. */
  queue: string;
  /** The lane the manifest named, carried into the item so one queue serves many. */
  lane: string;
  pipeline: string;
  /** The feedback edge that sent it. */
  edgeId: string;
  /** `derived` proposes a change to the pipeline itself; a reviewer needs to know. */
  form: "queue" | "derived";
  scoreConfig?: ScoreConfigSpec;
  metadata?: Record<string, unknown>;
}

export interface QueueResult {
  queueId: string;
  itemId: string;
  url?: string;
}

export type QueuePort = (
  request: QueueRequest,
) => Promise<QueueResult | null> | QueueResult | null;

export interface DatasetRunRequest {
  /** The manifest's `eval.dataset`. */
  dataset: string;
  /**
   * One run per evaluation. For an experiment this is the ARM — which makes a
   * Langfuse dataset-run comparison the arm comparison, for free.
   */
  run: string;
  runMetadata?: Record<string, unknown>;
  items: Array<{ id: string; input: unknown; expectedOutput?: unknown; metadata?: Record<string, unknown> }>;
  /** The eval's root trace; run items and the gate metric attach here. */
  traceId: string | null;
  /** Aggregate metrics, normally `eval.gateMetric` plus whatever else the harness computed. */
  scores?: ReadonlyArray<readonly [name: string, value: number]>;
}

export type DatasetPort = (request: DatasetRunRequest) => Promise<void> | void;

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

export interface PipelinePorts {
  tracer?: TracePort;
  decide?: DecidePort;
  generate?: GeneratePort;
  store?: StorePort;
  scope?: ScopeResolver;
  scores?: ScorePort;
  queue?: QueuePort;
  dataset?: DatasetPort;
  prompts?: PromptResolver;
  thresholds?: ThresholdSource;
  toolRegistry?: ToolRegistry;
  cache?: CachePort;
  records?: RunRecordSink;
  /**
   * Watchers (#325). Notified in order, after `records`, and BEST-EFFORT: one
   * that throws is logged and skipped, never allowed to fail a run that already
   * produced its answer. Add the next cost meter / debug recorder / sampler
   * here rather than widening a port interface.
   */
  observers?: readonly RunObserver[];
  clock?: () => number;
  /** Bumped into the composite version hash. */
  knowledgeVersion?: string;
}

export interface RunOptions {
  trigger?: Trigger;
  /**
   * A stable identity for the WORK, surviving retries and resumes — LangGraph's
   * `thread_id` to the trace id's `checkpoint_id`. Content-derived is ideal
   * (scale passes `scaleJobId`, a hash of recipe + factor + notes + subs +
   * language). Omitted, the run's own trace id stands in.
   */
  runKey?: string;
  /** An arm rides down into a sub-pipeline; this attributes an outer label to an inner arm. */
  parentRunId?: string | null;
  /** Force an arm — how a shadow challenger and an offline replay are run. */
  forceArm?: Record<string, string>;
  /**
   * Run as a shadow challenger (./shadow): recorded and tagged `shadow`, but
   * `writesFact` is false whatever the arms say.
   */
  shadow?: boolean;
  /** Extra patches applied after the arm patch. Replay uses this. */
  patch?: ManifestPatch;
  signal?: AbortSignal;
  /** Merged into the root span metadata. Never into the version hash. */
  metadata?: Record<string, unknown>;
  /**
   * Extra root-trace TAGS, appended to the ones the runtime derives. The host
   * knows things the manifest cannot — which tenant this run belongs to, that a
   * prompt override was in play — and Langfuse filters on tags, not metadata.
   */
  tags?: readonly string[];
}
