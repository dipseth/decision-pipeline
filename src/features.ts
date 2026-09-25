/**
 * Pipeline-agnostic feature extraction for the run record.
 *
 * The shared layer between pipelines is the record schema and THESE — not the
 * weights. Anything derivable from a run without knowing what the pipeline
 * does belongs here; anything that needs domain knowledge goes in the
 * manifest's own `features()`.
 */

/** Shannon entropy in nats, normalised to 0..1 against a uniform distribution. */
export const normalizedEntropy = (p: readonly number[]): number | null => {
  const values = p.filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
  if (values.length <= 1) return 0;
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let h = 0;
  for (const v of values) {
    const q = v / total;
    h -= q * Math.log(q);
  }
  return h / Math.log(values.length);
};

/** Gap between the top two probabilities — how nearly the gate could have gone the other way. */
export const topMargin = (p: readonly number[]): number | null => {
  const sorted = [...p].filter((v) => Number.isFinite(v)).sort((a, b) => b - a);
  if (sorted.length === 0) return null;
  const first = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  return first - second;
};

export interface DistributionFeatureInput {
  nodeId: string;
  distributions: Record<string, number[]>;
}

/**
 * `<nodeId>.<question>.margin` and `.entropy` for every distribution a decide
 * node produced. Flat keys, because the record's `features` is flat and the
 * training set is a join.
 */
export const distributionFeatures = (
  inputs: readonly DistributionFeatureInput[],
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const { nodeId, distributions } of inputs) {
    for (const [question, p] of Object.entries(distributions)) {
      const margin = topMargin(p);
      if (margin !== null) out[`${nodeId}.${question}.margin`] = margin;
      const entropy = normalizedEntropy(p);
      if (entropy !== null) out[`${nodeId}.${question}.entropy`] = entropy;
      const top = Math.max(...p.filter((v) => Number.isFinite(v)), Number.NEGATIVE_INFINITY);
      if (Number.isFinite(top)) out[`${nodeId}.${question}.top`] = top;
    }
  }
  return out;
};
