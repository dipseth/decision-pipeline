/**
 * Trials — a locked hypothesis tested on the pipelines it names.
 *
 * `hypothesis.ts` judges rows; this is where the rows come from. A trial pins
 * three things before any data exists: the claim (its hash), the champion and
 * the challenger (their fingerprints). Then it runs the challenger as a shadow
 * on the inputs the claim's split allows, asks the host for truth, keeps every
 * row in a store, and judges.
 *
 *   registerTrial   lock once; a changed claim under the same id is refused
 *   collectTrial    shadow runs → rows, appended as they finish (resumable)
 *   judgeTrial      evaluateHypothesis over the stored rows, recorded as a READ
 *
 * Every judgement is kept, and reads of the holdout are counted: the first is
 * the confirmatory one, a later read is a peek and says so.
 *
 * The store is a port, like everything else here: the core owns no disk and
 * no database. `memoryTrialStore` (./testing) is the reference.
 */

import { shortHash } from "./hash";
import {
  evaluateHypothesis,
  lockHypothesis,
  observationsFromShadow,
  splitOf,
  type CompiledHypothesis,
  type HypothesisLock,
  type HypothesisVerdict,
} from "./hypothesis";
import type { ObservationRow } from "./metrics";
import { runShadow, type ShadowResult } from "./shadow";
import type { DecisionPipeline } from "./define";
import type { PipelinePorts, RunOptions } from "./ports";

/**
 * What a pipeline IS, for pinning: its declarative graph, plus the live node
 * versions and edges (a pipeline copied with `{ ...base, nodes }` keeps the
 * base's `toJSON`). Code bodies are not in it: a compiled spec node's version
 * carries its body hash, a TypeScript node's declared version is the author's promise.
 */
export const pipelineFingerprint = <I, O>(p: DecisionPipeline<I, O>): string =>
  shortHash({
    json: p.toJSON(),
    nodes: Object.fromEntries(Object.entries(p.nodes).map(([id, n]) => [id, n.version])),
    edges: p.edges,
  });

export interface TrialArm {
  /** The arm name the hypothesis's estimand uses. */
  name: string;
  fingerprint: string;
}

export interface TrialLock {
  trial: string;
  hypothesis: HypothesisLock;
  champion: TrialArm;
  challenger: TrialArm;
  /** Over the claim's hash and both fingerprints. */
  hash: string;
  registered_at: string;
}

export interface TrialJudgement {
  verdict: HypothesisVerdict;
  /** 1 = the first read of this split. Only the first read of the holdout is confirmatory. */
  read: number;
  split: "holdout" | "dev" | "all";
  rows: number;
}

/** Where locks, rows and judgements live. Appends only. */
export interface TrialStore {
  getLock(trial: string): Promise<TrialLock | null>;
  putLock(lock: TrialLock): Promise<void>;
  appendRows(trial: string, rows: readonly ObservationRow[]): Promise<void>;
  rows(trial: string): Promise<ObservationRow[]>;
  appendJudgement(trial: string, judgement: TrialJudgement): Promise<void>;
  judgements(trial: string): Promise<TrialJudgement[]>;
}

export const lockTrial = <I, O>(
  h: CompiledHypothesis,
  arms: { champion: { name: string; pipeline: DecisionPipeline<I, O> }; challenger: { name: string; pipeline: DecisionPipeline<I, O> } },
  at: Date = new Date(),
): TrialLock => {
  const hypothesis = lockHypothesis(h, at);
  const champion = { name: arms.champion.name, fingerprint: pipelineFingerprint(arms.champion.pipeline) };
  const challenger = { name: arms.challenger.name, fingerprint: pipelineFingerprint(arms.challenger.pipeline) };
  return {
    trial: h.spec.id,
    hypothesis,
    champion,
    challenger,
    hash: shortHash({ hypothesis: h.hash, champion, challenger }),
    registered_at: hypothesis.registered_at,
  };
};

/**
 * Stores the lock, or returns the one already stored when it is the same
 * trial. A different claim or pipeline under a registered id throws: a
 * preregistration that can be edited is not one — give the new version a new id.
 */
export const registerTrial = async (store: TrialStore, lock: TrialLock): Promise<TrialLock> => {
  const existing = await store.getLock(lock.trial);
  if (existing) {
    if (existing.hash !== lock.hash) {
      throw new Error(
        `trial "${lock.trial}" is already locked (${existing.hash}, ${existing.registered_at}) with a different claim or pipeline (${lock.hash}) — register the change under a new id`,
      );
    }
    return existing;
  }
  await store.putLock(lock);
  return lock;
};

export interface TruthArgs<I> {
  input: I;
  id: string;
  champion: unknown;
  challenger: unknown;
}

export interface CollectTrialOptions<I, O> {
  hypothesis: CompiledHypothesis;
  store: TrialStore;
  champion: DecisionPipeline<I, O>;
  challenger: DecisionPipeline<I, O>;
  inputs: readonly I[];
  /** The ITEM id — a row's `id`, and how a resumed collection knows what it already has. */
  id: (input: I) => string;
  /**
   * The independent unit (a recipe, a user). Default: the id. Decides the
   * split BEFORE anything runs, and becomes `row.unit` — so a hypothesis that
   * names `population.unit` must name one this agrees with.
   */
  unit?: (input: I) => string;
  ports: PipelinePorts;
  options?: RunOptions;
  /** Ground truth for one pair, or undefined when there is none. Sees both outputs so a judge can be blind to arms. */
  truth?: (args: TruthArgs<I>) => Promise<unknown>;
  /** Extra `meta` per row (the arm's answer, a title) — for metrics, segments, and reading the rows later. */
  meta?: (args: TruthArgs<I> & { shadow: ShadowResult<O>; arm: string; output: unknown }) => Record<string, unknown>;
  concurrency?: number;
  /** Called as each pair lands. */
  onPair?: (e: { id: string; shadow: ShadowResult<O>; rows: ObservationRow[]; truthError: string | null }) => void;
}

export interface CollectTrialResult {
  collected: number;
  skipped: { otherSplit: number; alreadyCollected: number };
  challengerErrors: number;
  truthErrors: number;
  calls: { shared: number; fresh: number; freshCostUsd: number };
  costUsd: Record<string, number>;
}

const requireLock = async (h: CompiledHypothesis, store: TrialStore): Promise<TrialLock> => {
  const lock = await store.getLock(h.spec.id);
  if (!lock) throw new Error(`trial "${h.spec.id}" is not registered — lock it before collecting`);
  if (lock.hypothesis.hash !== h.hash) {
    throw new Error(`trial "${h.spec.id}": the hypothesis changed since it was locked (${lock.hypothesis.hash} → ${h.hash})`);
  }
  return lock;
};

/** Runs the shadows the lock allows, and appends each pair's rows as it lands. */
export const collectTrial = async <I, O>(opts: CollectTrialOptions<I, O>): Promise<CollectTrialResult> => {
  const lock = await requireLock(opts.hypothesis, opts.store);
  for (const [side, p] of [["champion", opts.champion], ["challenger", opts.challenger]] as const) {
    const now = pipelineFingerprint(p);
    if (now !== lock[side].fingerprint) {
      throw new Error(`trial "${lock.trial}": the ${side} is not the pipeline that was locked (${lock[side].fingerprint} → ${now})`);
    }
  }

  const split = opts.hypothesis.spec.population.split;
  const unitOf = opts.unit ?? opts.id;
  const have = new Set((await opts.store.rows(lock.trial)).map((r) => r.id));
  const out: CollectTrialResult = {
    collected: 0,
    skipped: { otherSplit: 0, alreadyCollected: 0 },
    challengerErrors: 0,
    truthErrors: 0,
    calls: { shared: 0, fresh: 0, freshCostUsd: 0 },
    costUsd: { [lock.champion.name]: 0, [lock.challenger.name]: 0 },
  };

  const queue: I[] = [];
  for (const input of opts.inputs) {
    if (split && splitOf(unitOf(input), split) !== split.use) out.skipped.otherSplit++;
    else if (have.has(opts.id(input))) out.skipped.alreadyCollected++;
    else queue.push(input);
  }

  const one = async (input: I): Promise<void> => {
    const id = opts.id(input);
    const shadow = await runShadow({
      champion: opts.champion,
      challenger: opts.challenger,
      input,
      ports: opts.ports,
      options: { ...opts.options, tags: [...(opts.options?.tags ?? []), `trial:${lock.trial}`] },
      label: lock.challenger.name,
    });
    out.calls.shared += shadow.calls.shared;
    out.calls.fresh += shadow.calls.fresh;
    out.calls.freshCostUsd += shadow.calls.freshCostUsd;
    if (shadow.challengerError) out.challengerErrors++;

    const args: TruthArgs<I> = { input, id, champion: shadow.champion.output, challenger: shadow.challenger?.output ?? null };
    let truth: unknown;
    let truthError: string | null = null;
    if (opts.truth) {
      try {
        truth = await opts.truth(args);
      } catch (err) {
        truthError = err instanceof Error ? err.message : String(err);
        out.truthErrors++;
      }
    }
    const rows = observationsFromShadow(shadow, {
      id,
      unit: unitOf(input),
      truth,
      champion: lock.champion.name,
      challenger: lock.challenger.name,
    }).map((r) => (opts.meta ? { ...r, meta: { ...r.meta, ...opts.meta({ ...args, shadow, arm: r.arm!, output: r.prediction }) } } : r));
    for (const r of rows) out.costUsd[r.arm!] = (out.costUsd[r.arm!] ?? 0) + Number(r.meta?.cost_usd ?? 0);
    await opts.store.appendRows(lock.trial, rows);
    out.collected++;
    opts.onPair?.({ id, shadow, rows, truthError });
  };

  const width = Math.max(1, opts.concurrency ?? 1);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, queue.length) }, async () => {
      while (next < queue.length) await one(queue[next++]!);
    }),
  );
  return out;
};

/**
 * Judges the stored rows and records the read. A judgement of a split that was
 * already read says so: the first holdout read is the confirmatory verdict.
 */
export const judgeTrial = async (
  hypothesis: CompiledHypothesis,
  store: TrialStore,
  opts: { now?: Date } = {},
): Promise<TrialJudgement> => {
  const lock = await requireLock(hypothesis, store);
  const rows = await store.rows(lock.trial);
  const verdict = await evaluateHypothesis(hypothesis, rows, { lock: lock.hypothesis, now: opts.now });
  const split = hypothesis.spec.population.split?.use ?? "all";
  const read = (await store.judgements(lock.trial)).filter((j) => j.split === split).length + 1;
  if (read > 1 && split === "holdout") {
    verdict.warnings.push(`holdout read ${read}: only read 1 is confirmatory — this one is a re-read`);
  }
  const judgement: TrialJudgement = { verdict, read, split, rows: rows.length };
  await store.appendJudgement(lock.trial, judgement);
  return judgement;
};
