/**
 * The verdict engine, tested against worlds where the answer is KNOWN.
 *
 * A verdict is only worth something if (a) with no real effect it claims one
 * about α of the time, and (b) with the planned effect it finds it about
 * `plan.power` of the time. These simulate both, plus the failure that
 * clustering causes when the unit is declared wrong. The bands are wide
 * enough for the simulation counts; a real bug (a 1 − α interval where 1 − 2α
 * belongs, a bootstrap that ignores clusters) lands far outside them.
 */

import { describe, expect, it } from "vitest";
import { compileHypothesis, evaluateHypothesis, planHypothesis, type HypothesisSpecInput } from "./hypothesis";
import type { ObservationRow } from "./metrics";
import { seededRandom } from "./stats";

const compile = (spec: HypothesisSpecInput) => {
  const r = compileHypothesis(spec);
  if (!r.ok) throw new Error(r.problems.join("\n"));
  return r.hypothesis;
};

const gaussian = (random: () => number) => () => {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
};

const rate = async (sims: number, one: (sim: number) => Promise<boolean>): Promise<number> => {
  let hits = 0;
  for (let s = 0; s < sims; s++) if (await one(s)) hits++;
  return hits / sims;
};

describe("calibration", { timeout: 120_000 }, () => {
  it("A/A, binary, unpaired: claims a difference about α of the time (Newcombe)", async () => {
    const h = compile({
      id: "aa-binary",
      claim: "Two identical arms differ in their success rate.",
      population: { describe: "simulated" },
      metric: { ref: "truthy@1" },
      estimand: { kind: "difference", treatment: "b", control: "a", paired: false },
      test: { kind: "different", from: 0 },
    });
    const random = seededRandom("aa-binary");
    const fp = await rate(400, async (s) => {
      const rows: ObservationRow[] = [];
      for (let i = 0; i < 120; i++) {
        rows.push({ id: `a${s}-${i}`, arm: "a", prediction: random() < 0.7 });
        rows.push({ id: `b${s}-${i}`, arm: "b", prediction: random() < 0.7 });
      }
      return (await evaluateHypothesis(h, rows)).status === "supported";
    });
    expect(fp).toBeGreaterThan(0.015);
    expect(fp).toBeLessThan(0.09);
  });

  it("one-sided coverage: a true rate exactly AT the bound is 'supported' about α of the time (Wilson)", async () => {
    const h = compile({
      id: "at-bound",
      claim: "The rate is above 0.9.",
      population: { describe: "simulated" },
      metric: { ref: "truthy@1" },
      estimand: { kind: "level" },
      test: { kind: "greater", than: 0.9 },
    });
    const random = seededRandom("at-bound");
    const fp = await rate(600, async (s) => {
      const rows = Array.from({ length: 150 }, (_, i) => ({ id: `${s}-${i}`, prediction: random() < 0.9 }));
      return (await evaluateHypothesis(h, rows)).status === "supported";
    });
    expect(fp).toBeGreaterThan(0.015);
    expect(fp).toBeLessThan(0.09);
  });

  it("a planted paired effect is found at about the planned power (bootstrap)", async () => {
    const spec: HypothesisSpecInput = {
      id: "planted",
      claim: "The challenger scores higher than the champion.",
      population: { describe: "simulated" },
      metric: { ref: "value@1" },
      estimand: { kind: "difference", treatment: "challenger", control: "champion" },
      test: { kind: "greater", than: 0 },
      bootstrap: { resamples: 400 },
      plan: { minEffect: 0.3, sd: 0.5, power: 0.8 },
    };
    const n = planHypothesis(compile(spec)).requiredN as number;
    expect(n).toBe(18);
    const h = compile({ ...spec, plan: { ...spec.plan, n } });
    const random = seededRandom("planted");
    const normal = gaussian(random);
    const power = await rate(200, async (s) => {
      const rows: ObservationRow[] = [];
      for (let i = 0; i < n; i++) {
        const item = normal();
        rows.push({ id: `${s}-${i}`, arm: "champion", prediction: item });
        rows.push({ id: `${s}-${i}`, arm: "challenger", prediction: item + 0.3 + 0.5 * normal() });
      }
      return (await evaluateHypothesis(h, rows)).status === "supported";
    });
    // Percentile bootstrap runs a little liberal at n=18; the band allows it.
    expect(power).toBeGreaterThan(0.65);
    expect(power).toBeLessThan(0.95);
  });

  it("shadow-like pairs, true difference AT the non-inferiority margin: Newcombe paired holds α where the bootstrap does not", async () => {
    // A shadow that shares its champion's answers agrees on most pairs, so
    // few are discordant. Here 1% favour the challenger and 6% the champion:
    // the true difference is exactly the −0.05 margin, so "supported" is a
    // false positive. The percentile bootstrap resamples almost no discordant
    // pairs at small n and its interval shrinks toward the point estimate.
    const spec = (interval: "auto" | "bootstrap"): HypothesisSpecInput => ({
      id: `margin-${interval}`,
      claim: "The challenger is at most 5 points worse.",
      population: { describe: "simulated" },
      metric: { ref: "truthy@1" },
      estimand: { kind: "difference", treatment: "challenger", control: "champion" },
      test: { kind: "greater", than: -0.05 },
      interval,
      bootstrap: { resamples: 500 },
    });
    const sim = async (interval: "auto" | "bootstrap") => {
      const h = compile(spec(interval));
      const random = seededRandom("margin");
      return rate(300, async (s) => {
        const rows: ObservationRow[] = [];
        for (let i = 0; i < 30; i++) {
          const u = random();
          const [t, c] = u < 0.01 ? [true, false] : u < 0.07 ? [false, true] : u < 0.87 ? [true, true] : [false, false];
          rows.push({ id: `${s}-${i}`, arm: "challenger", prediction: t }, { id: `${s}-${i}`, arm: "champion", prediction: c });
        }
        return (await evaluateHypothesis(h, rows)).status === "supported";
      });
    };
    const newcombe = await sim("auto");
    const bootstrap = await sim("bootstrap");
    expect(newcombe).toBeLessThan(0.09);
    expect(bootstrap).toBeGreaterThan(0.1);
  });

  it("zero discordant pairs at small n is not evidence: 12 identical pairs stay inconclusive", async () => {
    const h = compile({
      id: "zero-discordant",
      claim: "The challenger is at most 5 points worse.",
      population: { describe: "simulated" },
      metric: { ref: "truthy@1" },
      estimand: { kind: "difference", treatment: "challenger", control: "champion" },
      test: { kind: "greater", than: -0.05 },
    });
    const rows = Array.from({ length: 12 }, (_, i) => [
      { id: `${i}`, arm: "challenger", prediction: i < 10 },
      { id: `${i}`, arm: "champion", prediction: i < 10 },
    ]).flat();
    const v = await evaluateHypothesis(h, rows);
    expect(v.primary?.interval?.method).toBe("newcombe_paired");
    expect(v.status).toBe("inconclusive");
    expect(v.primary!.interval!.lo).toBeLessThan(-0.1);
  });

  it("clustered A/A: declaring the right unit keeps false positives near α; ignoring it does not", async () => {
    const base: HypothesisSpecInput = {
      id: "clustered",
      claim: "The two arms differ in their mean.",
      population: { describe: "simulated users, 10 rows each" },
      metric: { ref: "value@1" },
      estimand: { kind: "difference", treatment: "b", control: "a", paired: false },
      test: { kind: "different", from: 0 },
      interval: "normal",
    };
    const naive = compile(base);
    const clustered = compile({ ...base, population: { ...base.population, unit: "meta.user" } });
    const random = seededRandom("clustered");
    const normal = gaussian(random);
    let naiveFp = 0;
    let clusteredFp = 0;
    const sims = 300;
    for (let s = 0; s < sims; s++) {
      const rows: ObservationRow[] = [];
      for (const arm of ["a", "b"]) {
        for (let u = 0; u < 15; u++) {
          const userEffect = normal(); // strong per-user effect, no arm effect
          for (let k = 0; k < 10; k++) {
            rows.push({ id: `${s}-${arm}-${u}-${k}`, arm, prediction: userEffect + 0.3 * normal(), meta: { user: `${arm}${u}` } });
          }
        }
      }
      if ((await evaluateHypothesis(naive, rows)).status === "supported") naiveFp++;
      if ((await evaluateHypothesis(clustered, rows)).status === "supported") clusteredFp++;
    }
    expect(naiveFp / sims).toBeGreaterThan(0.3);
    expect(clusteredFp / sims).toBeLessThan(0.12);
  });
});
