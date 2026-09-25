/**
 * The statistics a hypothesis verdict needs — intervals, paired tests, power —
 * written out rather than imported, so the package keeps zod as its only
 * runtime dependency.
 *
 * Everything that draws randomness takes a SEEDED generator: a verdict is
 * replayable, and a bootstrap that moves on every re-run is not.
 */

import { sha256Hex } from "./hash";

/** Bumped whenever an estimator changes. Recorded on every verdict. */
export const STATS_VERSION = "3";

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

/** mulberry32, seeded from a string via sha256. Uniform on [0, 1). */
export const seededRandom = (seed: string): (() => number) => {
  let a = parseInt(sha256Hex(seed).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ---------------------------------------------------------------------------
// The normal distribution
// ---------------------------------------------------------------------------

/** Φ(x). Abramowitz & Stegun 7.1.26 on erf — absolute error < 1.5e-7. */
export const normalCdf = (x: number): number => {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
};

/** Φ⁻¹(p). Acklam's rational approximation — relative error < 1.2e-9. */
export const normalQuantile = (p: number): number => {
  if (!(p > 0 && p < 1)) throw new RangeError(`normalQuantile: p must be in (0, 1), got ${p}`);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  const [a0, a1, a2, a3, a4, a5] = a as [number, number, number, number, number, number];
  const [b0, b1, b2, b3, b4] = b as [number, number, number, number, number];
  const [c0, c1, c2, c3, c4, c5] = c as [number, number, number, number, number, number];
  const [d0, d1, d2, d3] = d as [number, number, number, number];
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
    (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1);
};

/** The two-sided critical value for a `confidence` interval (0.95 → 1.96). */
export const zFor = (confidence: number): number => normalQuantile(1 - (1 - confidence) / 2);

// ---------------------------------------------------------------------------
// Descriptives
// ---------------------------------------------------------------------------

export const mean = (xs: readonly number[]): number => {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
};

/** Sample variance (n − 1). 0 for fewer than two values. */
export const variance = (xs: readonly number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - 1);
};

/** Type-7 (linear interpolation) quantile of an ascending-sorted array. */
export const quantileSorted = (sorted: readonly number[], q: number): number => {
  if (sorted.length === 0) return Number.NaN;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (h - lo) * (b - a);
};

/**
 * Standard error of the mean of `values`, where rows sharing a cluster are NOT
 * independent (one user's twenty recipes are not twenty draws). The CR1
 * cluster-robust variance of a ratio estimator; with one row per cluster it is
 * the ordinary `sd / √n` up to the n/(n−1) factor.
 */
export const clusterRobustSe = (values: readonly number[], clusters: readonly string[]): number => {
  const n = values.length;
  if (n < 2) return Number.NaN;
  const m = mean(values);
  const totals = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = clusters[i] as string;
    totals.set(key, (totals.get(key) ?? 0) + ((values[i] as number) - m));
  }
  const g = totals.size;
  if (g < 2) return Number.NaN;
  let s = 0;
  for (const t of totals.values()) s += t * t;
  return Math.sqrt((g / (g - 1)) * s) / n;
};

// ---------------------------------------------------------------------------
// Intervals for proportions
// ---------------------------------------------------------------------------

export interface Interval {
  lo: number;
  hi: number;
}

/**
 * Wilson score interval. Unlike `p̂ ± z·se` it stays inside [0, 1] and does not
 * collapse to zero width at 0/n or n/n — 40/40 is [0.91, 1], not [1, 1].
 */
export const wilsonInterval = (successes: number, n: number, confidence: number): Interval => {
  if (n <= 0) return { lo: 0, hi: 1 };
  const z = zFor(confidence);
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
};

/** Newcombe's hybrid score interval for p1 − p2 (independent samples; his method 10). */
export const newcombeInterval = (x1: number, n1: number, x2: number, n2: number, confidence: number): Interval => {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const a = wilsonInterval(x1, n1, confidence);
  const b = wilsonInterval(x2, n2, confidence);
  const d = p1 - p2;
  return {
    lo: d - Math.sqrt((p1 - a.lo) ** 2 + (b.hi - p2) ** 2),
    hi: d + Math.sqrt((a.hi - p1) ** 2 + (p2 - b.lo) ** 2),
  };
};

/**
 * Newcombe's hybrid score interval for p1 − p2 on PAIRED binary data (his
 * 1998 method 10). Counts: a both 1, b only the first, c only the second, d
 * both 0. The percentile bootstrap collapses to [0, 0] when no pair is
 * discordant, which is the usual state of a shadow sharing its champion's
 * answers; this does not — 0 discordant of 12 is still a wide interval.
 */
export const newcombePairedInterval = (a: number, b: number, c: number, d: number, confidence: number): Interval => {
  const n = a + b + c + d;
  if (n <= 0) return { lo: -1, hi: 1 };
  const p1 = (a + b) / n;
  const p2 = (a + c) / n;
  const w1 = wilsonInterval(a + b, n, confidence);
  const w2 = wilsonInterval(a + c, n, confidence);
  const denom = (a + b) * (c + d) * (a + c) * (b + d);
  const phi = denom > 0 ? (a * d - b * c) / Math.sqrt(denom) : 0;
  const dl1 = p1 - w1.lo;
  const du1 = w1.hi - p1;
  const dl2 = p2 - w2.lo;
  const du2 = w2.hi - p2;
  const theta = p1 - p2;
  return {
    lo: Math.max(-1, theta - Math.sqrt(Math.max(0, dl1 ** 2 - 2 * phi * dl1 * du2 + du2 ** 2))),
    hi: Math.min(1, theta + Math.sqrt(Math.max(0, du1 ** 2 - 2 * phi * du1 * dl2 + dl2 ** 2))),
  };
};

// ---------------------------------------------------------------------------
// Exact tests
// ---------------------------------------------------------------------------

const logFactorial = (() => {
  const cache: number[] = [0];
  return (n: number): number => {
    for (let i = cache.length; i <= n; i++) cache[i] = (cache[i - 1] as number) + Math.log(i);
    return cache[n] as number;
  };
})();

/** P(X ≤ k) for X ~ Binomial(n, p). */
export const binomialCdf = (k: number, n: number, p: number): number => {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let s = 0;
  for (let i = 0; i <= k; i++) {
    s += Math.exp(logFactorial(n) - logFactorial(i) - logFactorial(n - i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, s);
};

/**
 * Exact McNemar test for paired binary outcomes. `b` = pairs where only the
 * treatment succeeded, `c` = only the control. Two-sided p. Ties (both or
 * neither) carry no information about the difference and do not enter.
 */
export const mcnemarExact = (b: number, c: number): number => {
  const n = b + c;
  if (n === 0) return 1;
  return Math.min(1, 2 * binomialCdf(Math.min(b, c), n, 0.5));
};

// ---------------------------------------------------------------------------
// The bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  /** Draws where the statistic was defined, ascending. */
  draws: number[];
  /** Draws where it was not (e.g. an AUC over a resample with one class). */
  undefinedDraws: number;
}

/**
 * Cluster bootstrap, stratified by group. `groups[g][c]` is the rows of
 * cluster `c` in group `g`; each resample redraws clusters with replacement
 * INSIDE each group (so an unpaired two-arm comparison keeps both arm sizes)
 * and hands `stat` each group's rows flattened.
 */
export const clusterBootstrap = <R>(
  groups: ReadonlyArray<ReadonlyArray<ReadonlyArray<R>>>,
  stat: (sample: R[][]) => number | null,
  opts: { resamples: number; random: () => number },
): BootstrapResult => {
  const draws: number[] = [];
  let undefinedDraws = 0;
  for (let b = 0; b < opts.resamples; b++) {
    const sample: R[][] = groups.map((clusters) => {
      const rows: R[] = [];
      for (let i = 0; i < clusters.length; i++) {
        const pick = clusters[Math.floor(opts.random() * clusters.length)] as ReadonlyArray<R>;
        for (const r of pick) rows.push(r);
      }
      return rows;
    });
    const v = stat(sample);
    if (v === null || !Number.isFinite(v)) undefinedDraws++;
    else draws.push(v);
  }
  draws.sort((x, y) => x - y);
  return { draws, undefinedDraws };
};

export const percentileInterval = (sortedDraws: readonly number[], confidence: number): Interval => {
  const tail = (1 - confidence) / 2;
  return { lo: quantileSorted(sortedDraws, tail), hi: quantileSorted(sortedDraws, 1 - tail) };
};

// ---------------------------------------------------------------------------
// p-values and power
// ---------------------------------------------------------------------------

/** One-sided upper-tail p for a z statistic. */
export const pUpper = (z: number): number => 1 - normalCdf(z);

/**
 * The smallest true effect a design with standard error `se` detects with
 * probability `power`, testing at `alpha` (already per-side).
 */
export const detectableEffect = (se: number, alphaPerSide: number, power: number): number =>
  (normalQuantile(1 - alphaPerSide) + normalQuantile(power)) * se;

export type SampleDesign = "one-sample" | "two-sample" | "paired";

/**
 * Units needed (PER ARM for `two-sample`) to detect `effect` given the per-unit
 * standard deviation `sd` — of the metric for one-/two-sample, of the per-pair
 * DIFFERENCE for `paired`. Normal approximation.
 */
export const requiredSampleSize = (args: {
  sd: number;
  effect: number;
  alphaPerSide: number;
  power: number;
  design: SampleDesign;
}): number => {
  const z = normalQuantile(1 - args.alphaPerSide) + normalQuantile(args.power);
  const base = ((z * args.sd) / Math.abs(args.effect)) ** 2;
  return Math.ceil(args.design === "two-sample" ? 2 * base : base);
};
