/**
 * In-memory ports.
 *
 * These are the point of the port layer: a pipeline's whole contract —
 * routing, skipping, tool selection, persistence metadata, the run record —
 * is testable with no Langfuse, no Qdrant, no model call and no network. They
 * ship from the package (not from a test file) so the APP's tests can use the
 * same fakes when the first pipeline is wired up.
 */

import type {
  CachePort,
  DatasetPort,
  DatasetRunRequest,
  DecidePort,
  DecideRequest,
  DecideResult,
  GeneratePort,
  GenerateRequest,
  GenerateResult,
  PipelinePorts,
  PromptResolution,
  PromptResolver,
  QueuePort,
  QueueRequest,
  RunRecordSink,
  ScopeResolver,
  ScorePort,
  ScoreRequest,
  SpanHandle,
  StorePort,
  StoreRequest,
  TracePort,
} from "./ports";
import type {
  NodeEndEvent,
  NodeStartEvent,
  RunEndEvent,
  RunObserver,
  RunStartEvent,
} from "./observers";
import type { RunRecord } from "./record";
import type { ScopeContextInput } from "./scope";
import type { ToolRegistry } from "./tools";
import type { ObservationRow } from "./metrics";
import type { TrialJudgement, TrialLock, TrialStore } from "./trial";

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

export interface RecordedSpan {
  name: string;
  /** 0 for the root. */
  depth: number;
  input: unknown;
  output?: unknown;
  metadata: Record<string, unknown>;
  /** Root spans only. Langfuse filters and compares on tags. */
  tags: string[];
  /** Root spans only. Who the run is attributed to. */
  userId?: string | null;
}

export interface RecordingTracer extends TracePort {
  readonly spans: RecordedSpan[];
  /** Roots opened. More than one means the "one run = one trace" rule is broken. */
  readonly roots: RecordedSpan[];
  span_(name: string): RecordedSpan | undefined;
}

export const recordingTracer = (traceId = "trace-0001"): RecordingTracer => {
  const spans: RecordedSpan[] = [];
  const roots: RecordedSpan[] = [];
  let depth = -1;

  const open = async <T>(
    name: string,
    input: unknown,
    metadata: Record<string, unknown>,
    tags: string[],
    userId: string | null | undefined,
    isRoot: boolean,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> => {
    depth += 1;
    const recorded: RecordedSpan = { name, depth, input, metadata: { ...metadata }, tags: [...tags], userId };
    spans.push(recorded);
    if (isRoot) roots.push(recorded);
    const handle: SpanHandle = {
      traceId,
      setMetadata: (m) => Object.assign(recorded.metadata, m),
      setTags: (t) => {
        recorded.tags = [...new Set([...recorded.tags, ...t])];
      },
      setOutput: (o) => {
        recorded.output = o;
      },
    };
    try {
      return await fn(handle);
    } finally {
      depth -= 1;
    }
  };

  return {
    spans,
    roots,
    span_: (name: string) => spans.find((s) => s.name === name),
    root: (opts, fn) => open(opts.name, opts.input, opts.metadata, opts.tags, opts.userId, true, fn),
    span: (opts, fn) => open(opts.name, opts.input, opts.metadata, [], null, false, fn),
  };
};

// ---------------------------------------------------------------------------
// Decide / generate
// ---------------------------------------------------------------------------

export type DecideScript = Record<
  string,
  DecideResult | ((request: DecideRequest) => DecideResult | Promise<DecideResult>)
>;

export interface ScriptedDecide {
  port: DecidePort;
  calls: DecideRequest[];
}

export const scriptedDecide = (script: DecideScript): ScriptedDecide => {
  const calls: DecideRequest[] = [];
  const port: DecidePort = async (request) => {
    calls.push(request);
    const entry = script[request.nodeId];
    if (!entry) {
      throw new Error(
        `scriptedDecide: no script for node "${request.nodeId}" (have: ${Object.keys(script).join(", ") || "none"})`,
      );
    }
    return typeof entry === "function" ? entry(request) : entry;
  };
  return { port, calls };
};

export type GenerateScript = Record<
  string,
  GenerateResult | ((request: GenerateRequest) => GenerateResult | Promise<GenerateResult>)
>;

export interface ScriptedGenerate {
  port: GeneratePort;
  calls: GenerateRequest[];
}

export const scriptedGenerate = (script: GenerateScript): ScriptedGenerate => {
  const calls: GenerateRequest[] = [];
  const port: GeneratePort = async (request) => {
    calls.push(request);
    const entry = script[request.nodeId];
    if (!entry) {
      throw new Error(
        `scriptedGenerate: no script for node "${request.nodeId}" (have: ${Object.keys(script).join(", ") || "none"})`,
      );
    }
    return typeof entry === "function" ? entry(request) : entry;
  };
  return { port, calls };
};

// ---------------------------------------------------------------------------
// Store / cache / records / scope / prompts / registry
// ---------------------------------------------------------------------------

export interface CollectingStore {
  port: StorePort;
  writes: StoreRequest[];
}

export const collectingStore = (): CollectingStore => {
  const writes: StoreRequest[] = [];
  return {
    writes,
    port: async (request) => {
      writes.push(request);
    },
  };
};

export interface MemoryCache extends CachePort {
  readonly entries: Map<string, unknown>;
}

export const memoryCache = (): MemoryCache => {
  const entries = new Map<string, unknown>();
  return {
    entries,
    get: (key) => entries.get(key),
    set: (key, value) => {
      entries.set(key, value);
    },
  };
};

export interface CollectedRecords {
  sink: RunRecordSink;
  records: RunRecord[];
  last(): RunRecord | undefined;
}

export const collectingRecords = (): CollectedRecords => {
  const records: RunRecord[] = [];
  return {
    records,
    sink: (record) => {
      records.push(record);
    },
    last: () => records[records.length - 1],
  };
};

/** One entry per hook call, in the order the runtime made them. */
export type ObservedEvent =
  | { hook: "onRunStart"; event: RunStartEvent }
  | { hook: "onNodeStart"; event: NodeStartEvent }
  | { hook: "onNodeEnd"; event: NodeEndEvent }
  | { hook: "onRunEnd"; event: RunEndEvent };

export interface CollectingObserver {
  observer: RunObserver;
  events: ObservedEvent[];
  /** The hook names in order — what an "it fired in this sequence" assertion reads. */
  stream(): string[];
  /** `onNodeStart`/`onNodeEnd` narrowed to one node. */
  node(nodeId: string): ObservedEvent[];
}

/**
 * A watcher that records what it was told (#325). Asserting on THIS is the
 * point of the observer seam: a test that wanted to know a node ran used to
 * reach into `recordingTracer().spans`, which tested the tracer as much as the
 * runtime.
 */
export const collectingObserver = (name = "collecting"): CollectingObserver => {
  const events: ObservedEvent[] = [];
  return {
    events,
    stream: () => events.map((e) => e.hook),
    node: (nodeId) =>
      events.filter(
        (e) =>
          (e.hook === "onNodeStart" || e.hook === "onNodeEnd") &&
          e.event.nodeId === nodeId,
      ),
    observer: {
      name,
      onRunStart: (event) => {
        events.push({ hook: "onRunStart", event });
      },
      onNodeStart: (event) => {
        events.push({ hook: "onNodeStart", event });
      },
      onNodeEnd: (event) => {
        events.push({ hook: "onNodeEnd", event });
      },
      onRunEnd: (event) => {
        events.push({ hook: "onRunEnd", event });
      },
    },
  };
};

/** A watcher that fails on every hook — the "best-effort" contract's test double. */
export const throwingObserver = (name = "throwing"): RunObserver => {
  const boom = (): never => {
    throw new Error(`${name} exploded`);
  };
  return {
    name,
    onRunStart: boom,
    onNodeStart: boom,
    onNodeEnd: boom,
    onRunEnd: boom,
  };
};

export interface CollectingScores {
  port: ScorePort;
  scores: ScoreRequest[];
}

export const collectingScores = (): CollectingScores => {
  const scores: ScoreRequest[] = [];
  return {
    scores,
    port: (request) => {
      scores.push(request);
    },
  };
};

export interface CollectingQueue {
  port: QueuePort;
  items: QueueRequest[];
}

export const collectingQueue = (): CollectingQueue => {
  const items: QueueRequest[] = [];
  return {
    items,
    port: (request) => {
      items.push(request);
      return { queueId: `q-${request.queue}`, itemId: `item-${items.length}` };
    },
  };
};

export interface CollectingDataset {
  port: DatasetPort;
  runs: DatasetRunRequest[];
}

export const collectingDataset = (): CollectingDataset => {
  const runs: DatasetRunRequest[] = [];
  return {
    runs,
    port: (request) => {
      runs.push(request);
    },
  };
};

/** The reference `TrialStore`: everything in maps, copied in and out so a caller cannot edit the record. */
export const memoryTrialStore = (): TrialStore & {
  locks: Map<string, TrialLock>;
  rowsByTrial: Map<string, ObservationRow[]>;
  judgementsByTrial: Map<string, TrialJudgement[]>;
} => {
  const locks = new Map<string, TrialLock>();
  const rowsByTrial = new Map<string, ObservationRow[]>();
  const judgementsByTrial = new Map<string, TrialJudgement[]>();
  const copy = <T>(v: T): T => structuredClone(v);
  return {
    locks,
    rowsByTrial,
    judgementsByTrial,
    getLock: async (trial) => (locks.has(trial) ? copy(locks.get(trial)!) : null),
    putLock: async (lock) => {
      locks.set(lock.trial, copy(lock));
    },
    appendRows: async (trial, rows) => {
      rowsByTrial.set(trial, [...(rowsByTrial.get(trial) ?? []), ...copy(rows)]);
    },
    rows: async (trial) => copy(rowsByTrial.get(trial) ?? []),
    appendJudgement: async (trial, j) => {
      judgementsByTrial.set(trial, [...(judgementsByTrial.get(trial) ?? []), copy(j)]);
    },
    judgements: async (trial) => copy(judgementsByTrial.get(trial) ?? []),
  };
};

/** A scope resolver that always returns the same rows. */
export const staticScope = (resolved: ScopeContextInput = {}): ScopeResolver =>
  () => resolved;

/** Prompt versions keyed by ref; unknown refs resolve to null, as an unconfigured host would. */
export const staticPrompts = (
  map: Record<string, PromptResolution> = {},
): PromptResolver =>
  (ref) => map[ref] ?? { version: null };

/** A registry where every listed tool exists and needs the MCP scope given. */
export const staticRegistry = (
  tools: Record<string, string | null>,
): ToolRegistry => ({
  has: (name) => Object.prototype.hasOwnProperty.call(tools, name),
  scopeOf: (name) => tools[name] ?? null,
});

/** A clock that advances a fixed number of ms per read, so `ms` fields are deterministic. */
export const steppingClock = (startMs = 1_700_000_000_000, stepMs = 1): (() => number) => {
  let now = startMs;
  return () => {
    const value = now;
    now += stepMs;
    return value;
  };
};

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

export interface TestPorts extends PipelinePorts {
  tracer: RecordingTracer;
  /** The event stream `ports.observers[0]` saw. */
  observed: ObservedEvent[];
  storeWrites: StoreRequest[];
  records: RunRecordSink;
  recorded: RunRecord[];
  decideCalls: DecideRequest[];
  generateCalls: GenerateRequest[];
  scoresWritten: ScoreRequest[];
  queueItems: QueueRequest[];
  datasetRuns: DatasetRunRequest[];
}

export interface TestPortsInput {
  decide?: DecideScript;
  generate?: GenerateScript;
  scope?: ScopeContextInput;
  prompts?: Record<string, PromptResolution>;
  registry?: Record<string, string | null>;
  env?: Record<string, string>;
  promptConfig?: Record<string, number>;
  knowledgeVersion?: string;
  traceId?: string;
}

/** Everything a pipeline needs to run, with nothing real behind it. */
export const testPorts = (input: TestPortsInput = {}): TestPorts => {
  const tracer = recordingTracer(input.traceId);
  const decide = scriptedDecide(input.decide ?? {});
  const generate = scriptedGenerate(input.generate ?? {});
  const store = collectingStore();
  const records = collectingRecords();
  const scores = collectingScores();
  const queue = collectingQueue();
  const dataset = collectingDataset();
  const watcher = collectingObserver();

  return {
    tracer,
    observers: [watcher.observer],
    observed: watcher.events,
    decide: decide.port,
    generate: generate.port,
    store: store.port,
    scores: scores.port,
    queue: queue.port,
    dataset: dataset.port,
    scope: staticScope(input.scope),
    prompts: staticPrompts(input.prompts),
    toolRegistry: input.registry ? staticRegistry(input.registry) : undefined,
    thresholds: {
      env: (name) => input.env?.[name],
      promptConfig: (key) => input.promptConfig?.[key],
    },
    cache: memoryCache(),
    records: records.sink,
    clock: steppingClock(),
    knowledgeVersion: input.knowledgeVersion,
    storeWrites: store.writes,
    recorded: records.records,
    decideCalls: decide.calls,
    generateCalls: generate.calls,
    scoresWritten: scores.scores,
    queueItems: queue.items,
    datasetRuns: dataset.runs,
  };
};
