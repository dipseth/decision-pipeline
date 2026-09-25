/**
 * Run observers — the watchers (#325).
 *
 * The line this draws, and the whole reason this file is not `ports.ts`:
 *
 *   A **port** returns a value the run consumes.
 *   An **observer** consumes events and returns nothing the run reads.
 *
 * By that rule `tracer` is NOT an observer, however much it looks like one: it
 * produces the run's identity (`rootSpan.traceId` IS the run id, which every
 * feedback row and every training join keys on), so removing it would change
 * what the run persists. `cache` is not one either — it returns a resumed value
 * that skips a node. Both stay ports. What IS an observer is anything that only
 * watches: the run record sink, a cost meter, a debug recorder, a gate-student
 * sampler.
 *
 * Two consequences follow from "returns nothing the run reads", and both are
 * contract, not implementation detail:
 *
 *   1. An observer that throws MUST NOT fail the run. The run already happened;
 *      a watcher's failure is a lost measurement, not a lost answer.
 *   2. An observer must not be load-bearing. If removing one changes an output,
 *      a persisted fact or an id, it was a port wearing an observer's clothes.
 *
 * Shape borrowed from Burr's lifecycle hooks (Apache-2.0) — the idea that a
 * small fixed set of hook points lets anything watch a run without the core
 * knowing it exists. The shape only; no code was copied, so no attribution is
 * owed.
 */

import type { RunRecord } from "./record";
import type { Rank, Trigger } from "./types";

export interface RunStartEvent {
  pipeline: string;
  /** The root trace id. Null when the host runs untraced. */
  runId: string | null;
  /** The durable identity — `options.runKey`, or this attempt's id. Never null. */
  runKey: string;
  /** The composite version hash: nodes + prompts + thresholds + knowledge + arms. */
  version: string;
  input: unknown;
  group: string;
  arms: Record<string, string>;
  trigger: Trigger;
  /** FALSE for a shadow challenger — a watcher must not bill a run that ships nothing. */
  writesFact: boolean;
}

export interface NodeStartEvent {
  pipeline: string;
  runId: string | null;
  nodeId: string;
  kind: string;
  nodeVersion: string;
  /** `shortHash({ primary, from })`. Empty for a node skipped before it ran. */
  inputHash: string;
  /** True when the node's output came from `cache`, so nothing was spent. */
  cacheHit: boolean;
}

export interface NodeEndEvent extends NodeStartEvent {
  ms: number;
  costUsd: number;
  /** A gate's verdict. */
  branch?: string;
  /** A generate node's route. */
  route?: string;
  /** The node's output, as the runtime recorded it. Undefined when it did not run. */
  output?: unknown;
  /** The failure message, whatever `onFailure` then did about it. */
  error?: string;
  /** Why it did not run — an unopened edge, or `error: <message>` under `onFailure: "skip"`. */
  skipped?: string;
}

export interface RunEndEvent {
  pipeline: string;
  runId: string | null;
  runKey: string;
  version: string;
  record: RunRecord;
  output: unknown;
  /** The branches taken, joined — what lands as `<fact>_route`. */
  route: string;
  confidence: number | null;
  decidedBy: Rank;
  writesFact: boolean;
}

/**
 * Every node the runtime CONSIDERED gets exactly one `onNodeStart` and exactly
 * one `onNodeEnd`, skips included — a watcher that pairs them can rely on that
 * rather than reconstructing which halves are missing.
 *
 * `onRunEnd` fires on success only. A run that throws has no `RunRecord` to
 * hand over: the record is assembled after the producing node resolves, so
 * there is nothing to report but the exception the caller already receives.
 * A watcher that needs failed-run cost needs a `RunRecord` built on the error
 * path first — deliberately not done here.
 */
export interface RunObserver {
  /** For logs. Also what a warning names when this observer throws. */
  readonly name?: string;
  onRunStart?(event: RunStartEvent): void | Promise<void>;
  onNodeStart?(event: NodeStartEvent): void | Promise<void>;
  onNodeEnd?(event: NodeEndEvent): void | Promise<void>;
  onRunEnd?(event: RunEndEvent): void | Promise<void>;
}

/**
 * Call one hook on every observer, in registration order, swallowing failures.
 *
 * Sequential rather than `Promise.all` on purpose: a debug recorder's event
 * stream is only readable if it arrives in order, and a watcher doing real
 * work per event is a watcher doing it wrong.
 */
export async function notifyObservers(
  observers: readonly RunObserver[] | undefined,
  hook: "onRunStart",
  event: RunStartEvent,
): Promise<void>;
export async function notifyObservers(
  observers: readonly RunObserver[] | undefined,
  hook: "onNodeStart",
  event: NodeStartEvent,
): Promise<void>;
export async function notifyObservers(
  observers: readonly RunObserver[] | undefined,
  hook: "onNodeEnd",
  event: NodeEndEvent,
): Promise<void>;
export async function notifyObservers(
  observers: readonly RunObserver[] | undefined,
  hook: "onRunEnd",
  event: RunEndEvent,
): Promise<void>;
export async function notifyObservers(
  observers: readonly RunObserver[] | undefined,
  hook: "onRunStart" | "onNodeStart" | "onNodeEnd" | "onRunEnd",
  event: RunStartEvent | NodeStartEvent | NodeEndEvent | RunEndEvent,
): Promise<void> {
  if (!observers || observers.length === 0) return;
  for (const observer of observers) {
    const fn = observer[hook];
    if (typeof fn !== "function") continue;
    try {
      await (fn as (e: unknown) => void | Promise<void>).call(observer, event);
    } catch (err) {
      // The run already happened. A watcher failing is a lost measurement.
      console.warn(
        `[pipeline/observers] ${observer.name ?? "anonymous"}.${hook} threw (ignored):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * `ports.records` as an observer, so there is ONE notification path rather than
 * a sink beside a list. Note the contract change this carries: a record sink
 * that throws no longer fails the run. It used to, which meant a run whose
 * answer was already computed could still fail on the way to the training
 * table — an outcome nothing wanted.
 */
export const recordSinkObserver = (
  sink: (record: RunRecord) => Promise<void> | void,
): RunObserver => ({
  name: "records",
  onRunEnd: (event) => sink(event.record),
});
