/**
 * `runPipeline` — the runtime.
 *
 * What it takes off every pipeline author's hands: topological order and the
 * skip rule, ONE root trace with one child span per node, the shared decide
 * runner, threshold resolution, the gate's branch bookkeeping, tool
 * resolution, onFailure, caching, the persistence contract, and the run
 * record. What it deliberately does NOT do: anything a node body does.
 */

import { applyManifestPatch } from "./patch";
import { assignArm, mergePatches, type ArmAssignment, type ManifestPatch } from "./experiments";
import { buildScopeContext, type ScopeRejection } from "./scope";
import { compositeVersion, nodeCacheKey } from "./version";
import { distributionFeatures } from "./features";
import {
  collectProbes,
  probeAnswers,
  probeFeatures,
  splitProbeDistributions,
  type ProbeRecord,
} from "./probes";
import { resolveInputs } from "./bindings";
import { resolveInbound } from "./graph";
import { resolveThresholds, thresholdValues, type ResolvedThreshold } from "./thresholds";
import { resolveTools, DEFAULT_TOOL_SELECT_THRESHOLD, type ResolvedTools } from "./tools";
import { shortHash } from "./hash";
import { MissingPortError, NodeFailedError, UnknownBranchError } from "./errors";
import { notifyObservers, recordSinkObserver, type RunObserver } from "./observers";
import type { DecisionPipeline } from "./define";
import type { PipelinePorts, RunOptions, SpanHandle, TracePort } from "./ports";
import type { RunRecord, RunRecordNode } from "./record";
import {
  hasThresholds,
  isGateNode,
  type BranchTaken,
  type NodeRunArgs,
  type OverrideRow,
  type PipelineNode,
  type ProbeAnswer,
  type Rank,
  type Scope,
  type ScopeContext,
} from "./types";

export interface RunResult<O> {
  output: O;
  /** `getTraceId(root)`. Null when the host runs untraced. */
  runId: string | null;
  /** The durable identity — `options.runKey`, or this attempt's id. */
  runKey: string;
  version: string;
  /** The branches taken, joined — what lands as `<fact>_route`. */
  route: string;
  confidence: number | null;
  decidedBy: Rank;
  arms: Record<string, string>;
  record: RunRecord;
  /** Node id -> why it did not run. Never silently missing. */
  skipped: Record<string, string>;
  /** Feedback rows the form x scope rule refused at read. */
  scopeRejections: ScopeRejection[];
  /** The arm/replay diff actually applied to the manifest. */
  patchApplied: string[];
}

/** What a gate sees in `args.probes`: nothing, ever. Frozen so a body cannot add to it. */
const NO_PROBES: Readonly<Record<string, readonly ProbeAnswer[]>> = Object.freeze({});

/** A tracer that does nothing, so a host without Langfuse still runs. */
const NULL_TRACER: TracePort = {
  async root(_opts, fn) {
    return fn({ traceId: null, setMetadata: () => {}, setOutput: () => {} });
  },
  async span(_opts, fn) {
    return fn({ traceId: null, setMetadata: () => {}, setOutput: () => {} });
  },
};

const normalizeGate = (
  result: unknown,
): { branch: string; reason?: string; confidence?: number } => {
  if (typeof result === "string") return { branch: result };
  if (result && typeof result === "object" && "branch" in result) {
    const r = result as { branch: unknown; reason?: unknown; confidence?: unknown };
    return {
      branch: String(r.branch),
      reason: typeof r.reason === "string" ? r.reason : undefined,
      confidence: typeof r.confidence === "number" ? r.confidence : undefined,
    };
  }
  return { branch: String(result) };
};

/**
 * The override, applied AT READ. The pipeline's own answer is untouched beside
 * it — that separability is what keeps the gate scorable on corrected runs and
 * makes the disagreement set a labeled training set.
 */
export const applyOverride = <I, O>(
  pipeline: DecisionPipeline<I, O>,
  output: O,
  ctx: ScopeContext,
): { value: unknown; override: OverrideRow | null } => {
  if (!pipeline.overridable) return { value: output, override: null };
  const key = pipeline.overridable.key(output);
  const row = ctx.override(key);
  return { value: row ? row.value : output, override: row };
};

export const runPipeline = async <I, O>(
  pipeline: DecisionPipeline<I, O>,
  rawInput: unknown,
  ports: PipelinePorts = {},
  options: RunOptions = {},
): Promise<RunResult<O>> => {
  const clock = ports.clock ?? (() => Date.now());
  const tracer = ports.tracer ?? NULL_TRACER;
  // `records` is just the first watcher, kept in its old position so a host
  // that wires both still sees the record land before anything else reads it.
  const observers: readonly RunObserver[] = [
    ...(ports.records ? [recordSinkObserver(ports.records)] : []),
    ...(ports.observers ?? []),
  ];
  const startedAt = clock();

  const input = pipeline.input.parse(rawInput) as I;
  const trigger = options.trigger ?? pipeline.trigger[0] ?? "on-demand";
  const group = pipeline.group(input);

  // --- 1. Scope, before node 0. The pipeline never reads a user id.
  const featureNodes = Object.entries(pipeline.nodes)
    .filter(([, n]) => n.kind === "decide" && n.acceptsFeatures === true)
    .map(([id]) => id);
  const overrideKey =
    pipeline.overridable?.keyFromInput?.(input) ?? null;

  const resolved = ports.scope
    ? await ports.scope({
        pipeline: pipeline.id,
        featureNodes,
        overrideKey,
        input,
      })
    : {};
  const { ctx, rejected } = buildScopeContext(resolved);

  // --- 2. Arms, in the same place and for the same reason as scope.
  const arms: Record<string, string> = {};
  const assignments: ArmAssignment[] = [];
  const armPatches: ManifestPatch[] = [];
  for (const experiment of pipeline.experiments ?? []) {
    const forced = options.forceArm?.[experiment.id];
    const assignment: ArmAssignment = forced
      ? {
          experiment: experiment.id,
          arm: forced,
          unit: experiment.unit,
          hash: null,
          ships: experiment.mode !== "shadow" || forced === experiment.champion,
          reason: "assigned",
        }
      : assignArm(experiment, ctx.ids[experiment.unit]);
    assignments.push(assignment);
    arms[experiment.id] = assignment.arm;
    const patch = experiment.arms[assignment.arm];
    if (patch) armPatches.push(patch);
  }
  /** A shadow challenger must NOT write the fact, or it overwrites production. */
  const writesFact = options.shadow !== true && assignments.every((a) => a.ships);
  const assignmentUnit: Scope | null = assignments[0]?.unit ?? null;
  const assignmentHash = assignments[0]?.hash ?? null;

  const patch = mergePatches([...armPatches, ...(options.patch ? [options.patch] : [])]);
  const { nodes, edges, applied: patchApplied } = applyManifestPatch(
    pipeline.nodes,
    pipeline.edges,
    patch,
  );

  // --- 3. Resolve everything the version hash needs, once, before the run.
  const promptVersions: Record<string, string | null> = {};
  const promptTools: Record<string, readonly string[]> = {};
  for (const [id, n] of Object.entries(nodes)) {
    const ref = n.kind === "generate" ? n.prompt : n.kind === "decide" ? n.questions : null;
    if (!ref) continue;
    const resolution = ports.prompts ? await ports.prompts(ref) : { version: null };
    promptVersions[id] = resolution.version;
    if (resolution.tools) promptTools[id] = resolution.tools;
  }

  const gateThresholds: Record<string, Record<string, ResolvedThreshold>> = {};
  for (const [id, n] of Object.entries(nodes)) {
    if (!hasThresholds(n)) continue;
    gateThresholds[id] = await resolveThresholds(n.thresholds, ports.thresholds);
  }
  const thresholdNumbers: Record<string, Record<string, number>> = {};
  for (const [id, resolvedSet] of Object.entries(gateThresholds)) {
    thresholdNumbers[id] = thresholdValues(resolvedSet);
  }

  const nodeVersions: Record<string, string> = {};
  for (const [id, n] of Object.entries(nodes)) nodeVersions[id] = n.version;

  const version = compositeVersion({
    pipeline: pipeline.id,
    nodeVersions,
    promptVersions,
    thresholds: thresholdNumbers,
    knowledgeVersion: pipeline.knowledgeVersion ?? ports.knowledgeVersion,
    arms,
  });

  const inputHash = shortHash(input);

  // --- 4. One root observation. Every node is a child span.
  return tracer.root(
    {
      name: `pipeline:${pipeline.id}`,
      input,
      group,
      // Arms as TAGS, not only metadata: Langfuse filters and compares on
      // tags, so without these an arm is invisible in the UI.
      tags: [
        `pipeline:${pipeline.id}`,
        `fact:${pipeline.fact}`,
        ...Object.entries(arms).map(([id, arm]) => `arm:${id}=${arm}`),
        ...(writesFact ? [] : ["shadow"]),
        ...(options.tags ?? []),
      ],
      userId: ctx.ids.user ?? null,
      metadata: {
        pipeline: pipeline.id,
        fact: pipeline.fact,
        pipeline_version: version,
        trigger,
        arms,
        parent_run_id: options.parentRunId ?? null,
        assignment_unit: assignmentUnit,
        writes_fact: writesFact,
        ...options.metadata,
      },
    },
    async (rootSpan: SpanHandle) => {
      const runId = rootSpan.traceId;
      // Resolved HERE rather than beside the record, because a watcher that
      // fires at run start still has to name the same run the record will.
      const attemptId =
        runId ?? `local-${shortHash({ pipeline: pipeline.id, inputHash, startedAt })}`;
      // No host key means this attempt IS the identity. Never null: a training
      // join keyed on an optional column is a join that silently drops rows.
      const runKey = options.runKey ?? attemptId;

      await notifyObservers(observers, "onRunStart", {
        pipeline: pipeline.id,
        runId,
        runKey,
        version,
        input,
        group,
        arms,
        trigger,
        writesFact,
      });

      const outputs = new Map<string, unknown>();
      const ran = new Set<string>();
      const branches = new Map<string, string>();
      /** The same verdicts, with the reason, for nodes that must record it. */
      const verdicts: Record<string, BranchTaken> = {};
      const skipped: Record<string, string> = {};
      const recordNodes: RunRecordNode[] = [];
      const decideDistributions: Array<{ nodeId: string; distributions: Record<string, number[]> }> = [];
      const perRunCache = new Map<string, unknown>();
      /** Decide node id -> its answered probes. Never handed to a gate. */
      const probesByNode: Record<string, readonly ProbeAnswer[]> = {};
      const probeFeatureValues: Record<string, number> = {};
      let costUsd = 0;
      let lastGateConfidence: number | null = null;
      /** Tags earned during the run, applied to the root once at the end. */
      const earnedTags = new Set<string>();

      /** Every node the runtime considered gets a start and an end, skips included. */
      const notifyNode = async (
        hook: "onNodeStart" | "onNodeEnd",
        entry: RunRecordNode,
        rest: { cacheHit: boolean; output?: unknown } = { cacheHit: false },
      ): Promise<void> => {
        const base = {
          pipeline: pipeline.id,
          runId,
          nodeId: entry.id,
          kind: entry.kind,
          nodeVersion: entry.version,
          inputHash: entry.input_hash,
          cacheHit: rest.cacheHit,
        };
        if (hook === "onNodeStart") {
          await notifyObservers(observers, "onNodeStart", base);
          return;
        }
        await notifyObservers(observers, "onNodeEnd", {
          ...base,
          ms: entry.ms,
          costUsd: entry.cost_usd,
          ...(entry.branch === undefined ? {} : { branch: entry.branch }),
          ...(entry.route === undefined ? {} : { route: entry.route }),
          ...(rest.output === undefined ? {} : { output: rest.output }),
          ...(entry.error === undefined ? {} : { error: entry.error }),
          ...(entry.skipped === undefined ? {} : { skipped: entry.skipped }),
        });
      };

      const noteSkip = async (
        id: string,
        n: PipelineNode<I>,
        reason: string,
      ): Promise<void> => {
        skipped[id] = reason;
        const entry: RunRecordNode = {
          id,
          kind: n.kind,
          version: n.version,
          input_hash: "",
          ms: 0,
          cost_usd: 0,
          skipped: reason,
        };
        recordNodes.push(entry);
        await notifyNode("onNodeStart", entry);
        await notifyNode("onNodeEnd", entry);
      };

      for (const id of pipeline.order) {
        const n = nodes[id];
        if (!n) continue;

        const inbound = resolveInbound(edges, id, ran, (gateId) => branches.get(gateId));
        if (inbound.skipReason !== null) {
          await noteSkip(id, n, inbound.skipReason);
          continue;
        }

        const from: Record<string, unknown> = {};
        for (const edge of inbound.open) from[edge.from] = outputs.get(edge.from);
        const primary = inbound.open.length > 0 ? outputs.get(inbound.open[0]!.from) : input;

        const bound = Object.freeze(resolveInputs(n.inputs, from, input));

        const nodeInputHash = shortHash({ primary, from });
        const thresholds = thresholdNumbers[id] ?? {};
        const args: NodeRunArgs<I> = {
          input,
          from,
          in: bound,
          primary,
          ctx,
          thresholds,
          node: { id, version: n.version },
          branches: verdicts,
          probes: isGateNode(n) ? NO_PROBES : probesByNode,
          signal: options.signal,
        };

        const cacheMode = n.cache ?? "none";
        const cacheKey = nodeCacheKey(pipeline.id, id, n.version, nodeInputHash);
        let cached: unknown = undefined;
        let cacheHit = false;
        if (cacheMode === "per-run" && perRunCache.has(cacheKey)) {
          cached = perRunCache.get(cacheKey);
          cacheHit = true;
        } else if (cacheMode === "per-key-forever" && ports.cache) {
          const hit = await ports.cache.get(cacheKey);
          if (hit !== undefined) {
            cached = hit;
            cacheHit = true;
          }
        }

        const nodeStart = clock();
        const entry: RunRecordNode = {
          id,
          kind: n.kind,
          version: n.version,
          input_hash: nodeInputHash,
          ms: 0,
          cost_usd: 0,
        };

        await notifyNode("onNodeStart", entry, { cacheHit });

        const finish = (value: unknown, span: SpanHandle): void => {
          entry.ms = clock() - nodeStart;
          outputs.set(id, value);
          ran.add(id);
          span.setMetadata({
            step_id: id,
            kind: n.kind,
            node_version: n.version,
            input_hash: nodeInputHash,
            cost_usd: entry.cost_usd,
            ...(entry.branch ? { branch: entry.branch } : {}),
            ...(entry.route ? { route: entry.route } : {}),
            ...(cacheHit ? { cache: "hit" } : {}),
          });
          span.setOutput(value);
        };

        try {
          await tracer.span(
            {
              name: `${id}`,
              input: { primary, from: Object.keys(from) },
              metadata: { step_id: id, kind: n.kind, node_version: n.version },
            },
            async (span) => {
              if (cacheHit) {
                entry.cached = true;
                finish(cached, span);
                return;
              }

              switch (n.kind) {
                case "read": {
                  finish(await n.load(args), span);
                  return;
                }

                case "decide": {
                  if (!ports.decide) throw new MissingPortError("decide", id, "decide");
                  // Probes first: validated before any port call, recorded
                  // even when there are none to ask, so the record says what
                  // the writer tried and why it was refused.
                  let probeRecord: ProbeRecord | null = null;
                  if (n.probes) {
                    const set = n.probes.from in from
                      ? collectProbes(from[n.probes.from], n.probes)
                      : { asked: {}, dropped: [{ index: -1, reason: `${n.probes.from} did not run` }] };
                    probeRecord = { from: n.probes.from, asked: set.asked, dropped: set.dropped, unanswered: [] };
                    entry.probes = probeRecord;
                    span.setMetadata({
                      probes_asked: Object.keys(set.asked).length,
                      probes_dropped: set.dropped.length,
                    });
                    if (!n.questions && Object.keys(set.asked).length === 0) {
                      throw new Error(
                        `no probes to ask (${set.dropped.length} dropped: ${set.dropped.map((d) => d.reason).join("; ") || "none written"})`,
                      );
                    }
                  }
                  const result = await ports.decide({
                    nodeId: id,
                    nodeVersion: n.version,
                    questions: n.questions ?? null,
                    probes: probeRecord?.asked ?? {},
                    state: n.state ?? [],
                    features: n.acceptsFeatures ? ctx.features(id) : [],
                    input,
                    from,
                    in: bound,
                    batched: n.batched === true,
                    signal: options.signal,
                  });
                  // The record keeps EVERY distribution (replay needs the
                  // probes too); gates, `interpret` and the per-question
                  // features see only the static questions.
                  entry.distributions = result.distributions;
                  if (result.distributionOptions) {
                    entry.distribution_options = result.distributionOptions;
                  }
                  if (result.batchTraceId) entry.batch_trace_id = result.batchTraceId;
                  entry.cost_reported = result.costUsd !== undefined;
                  entry.cost_usd = result.costUsd ?? 0;
                  costUsd += entry.cost_usd;
                  const { fixed } = splitProbeDistributions(result.distributions);
                  decideDistributions.push({ nodeId: id, distributions: fixed });
                  if (probeRecord) {
                    const { answers, unanswered } = probeAnswers(
                      probeRecord.asked,
                      result.distributions,
                      result.distributionOptions,
                    );
                    probeRecord.unanswered = unanswered;
                    probesByNode[id] = answers;
                    Object.assign(probeFeatureValues, probeFeatures(id, probeRecord, answers));
                  }
                  const value = n.interpret
                    ? n.interpret(fixed, args)
                    : (result.value ?? fixed);
                  finish(value, span);
                  return;
                }

                case "generate": {
                  if (!ports.generate) throw new MissingPortError("generate", id, "generate");
                  const tools = resolveToolsForNode(n, id, {
                    promptConfigTools: promptTools[id],
                    distributions: n.tools?.selectable
                      ? recordedDistributions(recordNodes, n.tools.selectable.from)
                      : undefined,
                    selectThreshold: toolSelectThreshold(n, thresholdNumbers),
                    grants: ctx.grants,
                    registry: ports.toolRegistry,
                  });
                  const result = await ports.generate({
                    nodeId: id,
                    nodeVersion: n.version,
                    prompt: n.prompt,
                    route: n.route,
                    submit: n.submit,
                    tools,
                    input,
                    from,
                    in: bound,
                    primary,
                    ctx,
                    branches: verdicts,
                    probes: probesByNode,
                    signal: options.signal,
                  });
                  entry.route = n.route;
                  entry.tools = {
                    offered: tools.offered,
                    selected: tools.selected,
                    called: result.toolsCalled ?? [],
                    dropped_for_scope: tools.dropped_for_scope,
                  };
                  entry.cost_reported = result.costUsd !== undefined;
                  entry.cost_usd = result.costUsd ?? 0;
                  costUsd += entry.cost_usd;
                  for (const tag of result.tags ?? []) earnedTags.add(tag);
                  finish(result.value, span);
                  return;
                }

                case "code": {
                  if (isGateNode(n)) {
                    const gate = normalizeGate(await n.run(args));
                    if (!n.branches.includes(gate.branch)) {
                      throw new UnknownBranchError(id, gate.branch, n.branches);
                    }
                    branches.set(id, gate.branch);
                    verdicts[id] = {
                      branch: gate.branch,
                      ...(gate.reason === undefined ? {} : { reason: gate.reason }),
                      ...(gate.confidence === undefined ? {} : { confidence: gate.confidence }),
                    };
                    entry.branch = gate.branch;
                    if (gate.reason !== undefined) entry.branch_reason = gate.reason;
                    entry.thresholds = thresholds;
                    if (gate.confidence !== undefined) lastGateConfidence = gate.confidence;
                    span.setMetadata({
                      gate: id,
                      branch: gate.branch,
                      ...(gate.reason === undefined ? {} : { branch_reason: gate.reason }),
                      thresholds,
                    });
                    // A gate routes; it does not transform. Downstream sees what came in.
                    finish(primary, span);
                    return;
                  }
                  // A transform that applies thresholds records them like a gate
                  // does, so a replay can see which numbers produced the output.
                  if (n.thresholds) {
                    entry.thresholds = thresholds;
                    span.setMetadata({ thresholds });
                  }
                  finish(await n.run(args), span);
                  return;
                }

                case "store": {
                  if (!ports.store) throw new MissingPortError("store", id, "store");
                  await ports.store({
                    nodeId: id,
                    target: n.target,
                    scope: n.scope,
                    ttl: n.ttl,
                    fact: pipeline.fact,
                    value: primary,
                    route: routeOf(branches, pipeline.order),
                    confidence: lastGateConfidence,
                    version,
                    runId,
                    decidedBy: pipeline.decidedBy,
                    writesFact,
                    ctx,
                  });
                  finish(primary, span);
                  return;
                }
              }
            },
          );

          if (!cacheHit && cacheMode !== "none") {
            const value = outputs.get(id);
            if (cacheMode === "per-run") perRunCache.set(cacheKey, value);
            else if (ports.cache) await ports.cache.set(cacheKey, value);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          entry.error = message;
          entry.ms = clock() - nodeStart;

          // A missing port is the HOST being misconfigured, not the node
          // failing. `onFailure: "skip"` must never swallow it, or a pipeline
          // wired up wrong looks like a pipeline that simply chose to skip.
          // The node still gets its end event first — every node the runtime
          // opened gets one, or a watcher cannot pair them (#325).
          if (err instanceof MissingPortError) {
            await notifyNode("onNodeEnd", entry, { cacheHit });
            throw err;
          }
          const onFailure = n.onFailure ?? "fail";

          if (onFailure === "fail") {
            recordNodes.push(entry);
            // Before the throw: a watcher that never hears the end of the node
            // that killed the run is a watcher blind to exactly the run worth
            // looking at. (The RUN's own end still does not fire — see
            // ./observers on why a failed run has no record to hand over.)
            await notifyNode("onNodeEnd", entry, { cacheHit });
            throw err instanceof NodeFailedError ? err : new NodeFailedError(id, err);
          }
          if (onFailure === "skip") {
            entry.skipped = `error: ${message}`;
            recordNodes.push(entry);
            skipped[id] = entry.skipped;
            await notifyNode("onNodeEnd", entry, { cacheHit });
            continue;
          }
          if (onFailure === "revert") {
            // Discard this node's work; the inbound payload passes through.
            outputs.set(id, primary);
            ran.add(id);
            entry.branch = "reverted";
            recordNodes.push(entry);
            await notifyNode("onNodeEnd", entry, { cacheHit, output: primary });
            continue;
          }
          // fallback
          const value = n.fallback ? await n.fallback(args) : primary;
          outputs.set(id, value);
          ran.add(id);
          recordNodes.push(entry);
          await notifyNode("onNodeEnd", entry, { cacheHit, output: value });
          continue;
        }

        recordNodes.push(entry);
        await notifyNode("onNodeEnd", entry, { cacheHit, output: outputs.get(id) });
      }

      // --- 5. The fact: the first `result` node that actually ran.
      const producer = pipeline.result.find((id) => ran.has(id));
      if (producer === undefined) {
        throw new Error(
          `Pipeline "${pipeline.id}" produced no fact: none of [${pipeline.result.join(", ")}] ran.`,
        );
      }
      const output = pipeline.output.parse(outputs.get(producer)) as O;
      const route = routeOf(branches, pipeline.order);

      const record: RunRecord = {
        pipeline: pipeline.id,
        version,
        run_id: attemptId,
        run_key: runKey,
        group,
        tenant: ctx.ids.tenant ?? null,
        user: ctx.ids.user ?? null,
        trigger,
        input_hash: inputHash,
        cost_usd: costUsd,
        ms: clock() - startedAt,
        nodes: recordNodes,
        features: {
          ...distributionFeatures(decideDistributions),
          ...probeFeatureValues,
          ...(pipeline.features?.({ input, outputs, branches, ctx }) ?? {}),
          nodes_ran: ran.size,
          nodes_skipped: Object.keys(skipped).length,
          cost_usd: costUsd,
        },
        fact: pipeline.fact,
        fact_route: route,
        fact_confidence: lastGateConfidence,
        consumed_feedback_ids: ctx.consumed(),
        arms,
        parent_run_id: options.parentRunId ?? null,
        assignment_unit: assignmentUnit,
        assignment_hash: assignmentHash,
        created_at: new Date(startedAt).toISOString(),
      };

      // A route is `direct` or `writer/quick`; each SEGMENT is its own tag, so
      // the plain branch names stay filterable the way they were when each
      // branch had a trace of its own.
      for (const segment of route.split("/")) {
        if (segment && segment !== "no_gate") earnedTags.add(segment);
      }
      earnedTags.add(`route:${route}`);
      if (earnedTags.size > 0) rootSpan.setTags?.([...earnedTags]);

      rootSpan.setMetadata({
        [`${pipeline.fact}_route`]: route,
        [`${pipeline.fact}_version`]: version,
        [`${pipeline.fact}_run_id`]: record.run_id,
        // Every attempt at one piece of work carries the same key, so a hand
        // read can find the retries of a run rather than three unrelated traces.
        run_key: record.run_key,
        decided_by: pipeline.decidedBy,
        cost_usd: costUsd,
        skipped: Object.keys(skipped),
      });
      rootSpan.setOutput(output);

      // `records` is the first entry in `observers`, so this one call is both
      // the record sink and every watcher behind it.
      await notifyObservers(observers, "onRunEnd", {
        pipeline: pipeline.id,
        runId,
        runKey,
        version,
        record,
        output,
        route,
        confidence: lastGateConfidence,
        decidedBy: pipeline.decidedBy,
        writesFact,
      });

      return {
        output,
        runId,
        runKey: record.run_key,
        version,
        route,
        confidence: lastGateConfidence,
        decidedBy: pipeline.decidedBy,
        arms,
        record,
        skipped,
        scopeRejections: rejected,
        patchApplied,
      };
    },
  );
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Branches taken, in topological order — what lands as `<fact>_route`. */
const routeOf = (
  branches: ReadonlyMap<string, string>,
  order: readonly string[],
): string => {
  const taken = order.map((id) => branches.get(id)).filter((b): b is string => b !== undefined);
  return taken.length > 0 ? taken.join("/") : "no_gate";
};

/** The distributions a preceding decide node recorded, for tool selection. */
const recordedDistributions = (
  recordNodes: readonly RunRecordNode[],
  decideNodeId: string,
): Record<string, number[]> | undefined =>
  recordNodes.find((r) => r.id === decideNodeId && !r.skipped)?.distributions;

/**
 * The threshold a candidate tool's Noul must clear. `selectable.threshold`
 * wins; otherwise the named gate's `tools` threshold; otherwise the default.
 */
const toolSelectThreshold = <I>(
  node: Extract<PipelineNode<I>, { kind: "generate" }>,
  thresholdNumbers: Record<string, Record<string, number>>,
): number => {
  const selectable = node.tools?.selectable;
  if (!selectable) return DEFAULT_TOOL_SELECT_THRESHOLD;
  const declared = selectable.threshold;
  if (typeof declared === "number") return declared;
  if (declared && "default" in declared) return declared.default;
  return thresholdNumbers[selectable.gate]?.tools ?? DEFAULT_TOOL_SELECT_THRESHOLD;
};

const resolveToolsForNode = <I>(
  node: Extract<PipelineNode<I>, { kind: "generate" }>,
  _id: string,
  rest: {
    promptConfigTools?: readonly string[];
    distributions?: Record<string, number[]>;
    selectThreshold: number;
    grants: readonly string[];
    registry?: PipelinePorts["toolRegistry"];
  },
): ResolvedTools =>
  resolveTools({
    spec: node.tools,
    promptConfigTools: rest.promptConfigTools,
    distributions: rest.distributions,
    selectThreshold: rest.selectThreshold,
    grants: rest.grants,
    registry: rest.registry,
  });

