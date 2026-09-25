/**
 * Binding `eval` to Langfuse's own experiment model — a dataset and a dataset
 * run — so an arm comparison is a chart in the UI rather than two scratch
 * folders. This is the same shape `llm/eval-runs.ts` already uses for the #318
 * Jev question A/B; the pipeline layer just gives it a naming convention and a
 * metric that is guaranteed to match the online one.
 *
 * The run NAME is the arm. That is the whole trick: Langfuse's dataset-run
 * comparison view then IS the experiment readout, and `mode: "replay"` costs
 * nothing to evaluate.
 */

import type { DecisionPipeline } from "./define";
import type { DatasetRunRequest, PipelinePorts } from "./ports";
import { aggregateGateMetric, type RunLabel, type RunRecord } from "./record";

/** Deterministic, so re-running upserts instead of duplicating. Matches eval-runs.ts. */
export const evalItemId = (dataset: string, id: string): string =>
  `${dataset}/${id}`.slice(0, 255);

/**
 * `<pipeline>@<version>` for a plain eval, `<pipeline>:<experiment>=<arm>@<version>`
 * for an arm. Sorting run names in the UI then groups a pipeline's arms together.
 */
export const evalRunName = (args: {
  pipeline: string;
  version: string;
  experiment?: string;
  arm?: string;
}): string => {
  const head =
    args.experiment && args.arm
      ? `${args.pipeline}:${args.experiment}=${args.arm}`
      : args.pipeline;
  return `${head}@${args.version}`;
};

export interface PipelineEvalRun {
  /** One per record evaluated; `id` should be stable (a recipe point id, a fixture key). */
  rows: Array<{
    id: string;
    input: unknown;
    expectedOutput?: unknown;
    record: RunRecord;
    labels: readonly RunLabel[];
  }>;
  /** The harness's own root trace. Run items and the aggregate scores attach here. */
  traceId: string | null;
  experiment?: string;
  arm?: string;
  /** Extra aggregates beyond `eval.gateMetric`. */
  extraScores?: ReadonlyArray<readonly [name: string, value: number]>;
  metadata?: Record<string, unknown>;
}

export interface PipelineEvalResult {
  dataset: string;
  run: string;
  items: number;
  /** The manifest's `eval.gateMetric`, computed the ONE way. */
  gateMetric: { name: string; n: number; mean: number | null };
  submitted: boolean;
  warnings: string[];
}

/**
 * Computes `eval.gateMetric` through the registered extractor — never an
 * ad-hoc query — and registers the run in Langfuse through the dataset port.
 */
export const recordPipelineEvalRun = async <I, O>(
  pipeline: DecisionPipeline<I, O>,
  run: PipelineEvalRun,
  ports: PipelinePorts = {},
): Promise<PipelineEvalResult> => {
  const warnings: string[] = [];
  const version = run.rows[0]?.record.version ?? "unversioned";
  const name = evalRunName({
    pipeline: pipeline.id,
    version,
    experiment: run.experiment,
    arm: run.arm,
  });

  const versions = new Set(run.rows.map((r) => r.record.version));
  if (versions.size > 1) {
    // A run whose rows span versions cannot be compared against another run.
    warnings.push(
      `rows span ${versions.size} composite versions (${[...versions].join(", ")}) — the run name uses the first`,
    );
  }

  const gateMetric = aggregateGateMetric(
    pipeline.eval.gateMetric,
    run.rows.map((r) => ({ record: r.record, labels: r.labels })),
  );

  const scores: Array<readonly [string, number]> = [];
  if (gateMetric.mean !== null) scores.push([gateMetric.name, gateMetric.mean]);
  for (const s of run.extraScores ?? []) scores.push(s);

  const request: DatasetRunRequest = {
    dataset: pipeline.eval.dataset,
    run: name,
    runMetadata: {
      pipeline: pipeline.id,
      fact: pipeline.fact,
      version,
      experiment: run.experiment ?? null,
      arm: run.arm ?? null,
      gate_metric: gateMetric.name,
      n: gateMetric.n,
      ...run.metadata,
    },
    items: run.rows.map((r) => ({
      id: r.id,
      input: r.input,
      expectedOutput: r.expectedOutput,
      metadata: {
        run_id: r.record.run_id,
        route: r.record.fact_route,
        confidence: r.record.fact_confidence,
        arms: r.record.arms,
      },
    })),
    traceId: run.traceId,
    scores,
  };

  let submitted = false;
  if (!ports.dataset) {
    warnings.push("no `dataset` port supplied — the run was computed but not registered");
  } else {
    try {
      await ports.dataset(request);
      submitted = true;
    } catch (err) {
      warnings.push(
        `dataset run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    dataset: pipeline.eval.dataset,
    run: name,
    items: run.rows.length,
    gateMetric,
    submitted,
    warnings,
  };
};
