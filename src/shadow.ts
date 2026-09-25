/**
 * Shadow runs — a challenger PIPELINE beside the champion, on the same input.
 *
 * An experiment arm (./experiments) is a patch, so it cannot add a node. A
 * proposal from ./propose can, so it runs here instead: the champion runs and
 * ships exactly as it would alone, then the challenger runs with `shadow: true`
 * and its store captured, never handed to the host. One ships, both are
 * recorded, and `compareRuns` says where they parted.
 *
 * Model answers are SHARED by default. The champion's decide and generate
 * calls are memoized on what the model would be shown, and a challenger
 * request that would show the same thing gets the same answer. Two things
 * follow. The comparison measures the PIPELINE, not two samples of Jev (a
 * route near a gate flips between batches, #321 probes). And a challenger
 * that changes one branch costs one branch, not a second run. The fresh
 * calls, and their cost, are counted.
 *
 * A challenger that throws never fails the champion: its error is returned.
 */

import { stableStringify } from "./hash";
import { runPipeline, type RunResult } from "./run";
import type { DecisionPipeline } from "./define";
import type {
  DecideRequest,
  DecideResult,
  GenerateRequest,
  GenerateResult,
  PipelinePorts,
  RunOptions,
  StoreRequest,
} from "./ports";

export interface ShadowOptions<I, O> {
  champion: DecisionPipeline<I, O>;
  challenger: DecisionPipeline<I, O>;
  input: unknown;
  ports: PipelinePorts;
  options?: RunOptions;
  /** Names the challenger — a proposal id. Tagged `challenger:<label>` on its trace. */
  label: string;
  /** Default true: reuse the champion's model answers wherever the challenger would ask the same thing. */
  share?: boolean;
}

export interface ShadowCalls {
  /** Challenger model calls served from the champion's answers. */
  shared: number;
  /** Challenger model calls that went to the port. */
  fresh: number;
  /** What the fresh calls cost — the shadow's real price. */
  freshCostUsd: number;
}

export interface ShadowResult<O> {
  champion: RunResult<O>;
  challenger: RunResult<O> | null;
  challengerError: string | null;
  /** What the challenger would have written. The host store never sees it. */
  challengerStores: StoreRequest[];
  calls: ShadowCalls;
  comparison: RunComparison | null;
}

export interface RunSide {
  route: string;
  confidence: number | null;
  costUsd: number;
  ms: number;
  /** Nodes that ran (not skipped), in run order. */
  ran: string[];
}

export interface RunComparison {
  sameOutput: boolean;
  sameRoute: boolean;
  champion: RunSide;
  challenger: RunSide;
  onlyChampion: string[];
  onlyChallenger: string[];
  /** Gates both ran that chose differently. */
  branchChanged: Array<{ id: string; champion: string; challenger: string }>;
  /** challenger − champion, as each run's record states it (shared calls included). */
  costDeltaUsd: number;
}

const sideOf = (r: RunResult<unknown>): RunSide => ({
  route: r.route,
  confidence: r.confidence,
  costUsd: r.record.cost_usd,
  ms: r.record.ms,
  ran: r.record.nodes.filter((n) => n.skipped === undefined).map((n) => n.id),
});

export const compareRuns = <O>(champion: RunResult<O>, challenger: RunResult<O>): RunComparison => {
  const a = sideOf(champion as RunResult<unknown>);
  const b = sideOf(challenger as RunResult<unknown>);
  const branchOf = (r: RunResult<O>) =>
    new Map(r.record.nodes.filter((n) => n.branch !== undefined).map((n) => [n.id, n.branch as string]));
  const aBranch = branchOf(champion);
  const bBranch = branchOf(challenger);
  const branchChanged: RunComparison["branchChanged"] = [];
  for (const [id, branch] of aBranch) {
    const other = bBranch.get(id);
    if (other !== undefined && other !== branch) branchChanged.push({ id, champion: branch, challenger: other });
  }
  return {
    sameOutput: stableStringify(champion.output) === stableStringify(challenger.output),
    sameRoute: a.route === b.route,
    champion: a,
    challenger: b,
    onlyChampion: a.ran.filter((id) => !b.ran.includes(id)),
    onlyChallenger: b.ran.filter((id) => !a.ran.includes(id)),
    branchChanged,
    costDeltaUsd: b.costUsd - a.costUsd,
  };
};

/**
 * What the model would be shown. Node ids, versions and gate verdicts are
 * left out, and `from` is keyed by VALUE: a challenger that renames a node or
 * inserts a gate (which passes its input through) upstream of a model call
 * still asks the same question, and must get the same answer.
 */
const fromValues = (from: Record<string, unknown>): string[] =>
  [...new Set(Object.values(from).map(stableStringify))].sort();

const decideKey = (r: DecideRequest): string =>
  stableStringify({
    d: r.questions,
    probes: r.probes,
    state: r.state,
    features: r.features,
    input: r.input,
    from: fromValues(r.from),
    in: r.in,
    batched: r.batched,
  });

const generateKey = (r: GenerateRequest): string =>
  stableStringify({
    g: r.prompt,
    route: r.route,
    submit: r.submit ?? null,
    tools: r.tools,
    input: r.input,
    from: fromValues(r.from),
    in: r.in,
    primary: r.primary,
    probes: r.probes,
  });

export const runShadow = async <I, O>(opts: ShadowOptions<I, O>): Promise<ShadowResult<O>> => {
  const { ports, options = {} } = opts;
  const share = opts.share !== false;
  const memo = new Map<string, Promise<DecideResult | GenerateResult>>();
  const calls: ShadowCalls = { shared: 0, fresh: 0, freshCostUsd: 0 };

  const championPorts: PipelinePorts = share
    ? {
        ...ports,
        ...(ports.decide && {
          decide: (r) => {
            const p = ports.decide!(r);
            memo.set(decideKey(r), p);
            return p;
          },
        }),
        ...(ports.generate && {
          generate: (r) => {
            const p = ports.generate!(r);
            memo.set(generateKey(r), p);
            return p;
          },
        }),
      }
    : ports;

  const champion = await runPipeline(opts.champion, opts.input, championPorts, options);

  const replay = async <R extends DecideResult | GenerateResult>(key: string, call: () => Promise<R>): Promise<R> => {
    const hit = share ? memo.get(key) : undefined;
    if (hit) {
      // A champion call that failed is a miss, not an answer: the challenger
      // must not inherit an error its own call might not hit.
      const value = await hit.then((v) => v, () => undefined);
      if (value !== undefined) {
        calls.shared += 1;
        return value as R;
      }
    }
    const value = await call();
    calls.fresh += 1;
    calls.freshCostUsd += value.costUsd ?? 0;
    return value;
  };

  const challengerStores: StoreRequest[] = [];
  const challengerPorts: PipelinePorts = {
    ...ports,
    ...(ports.decide && { decide: (r) => replay(decideKey(r), () => ports.decide!(r)) }),
    ...(ports.generate && { generate: (r) => replay(generateKey(r), () => ports.generate!(r)) }),
    // Belt and braces with `shadow: true`: the host's store is never reached.
    store: async (r) => {
      challengerStores.push(r);
    },
  };

  let challenger: RunResult<O> | null = null;
  let challengerError: string | null = null;
  try {
    challenger = await runPipeline(opts.challenger, opts.input, challengerPorts, {
      ...options,
      shadow: true,
      // Same work, but not the same record: a join on run_key must not find two facts.
      runKey: `${champion.runKey}:shadow:${opts.label}`,
      tags: [...(options.tags ?? []), `challenger:${opts.label}`],
      metadata: { ...options.metadata, shadow_of: champion.runId, challenger: opts.label },
    });
  } catch (err) {
    challengerError = err instanceof Error ? err.message : String(err);
  }

  return {
    champion,
    challenger,
    challengerError,
    challengerStores,
    calls,
    comparison: challenger ? compareRuns(champion, challenger) : null,
  };
};
