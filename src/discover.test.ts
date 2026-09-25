import { describe, expect, it } from "vitest";
import { auc, crossValidate, discoverFeatures, encodeAnswer, fitLogistic, fitRidge, groupFolds, predictLinear, predictLogistic, spearman, type DiscoverAction, type DiscoverRow } from "./discover";
import { hashToUnit } from "./hash";

// Deterministic pseudo-random in [0,1) from a string.
const u = (s: string) => hashToUnit(s);

/** Rows whose label depends on a hidden "signal" only the right question can see. */
const plantedRows = (n: number): Array<DiscoverRow & { signal: number }> =>
  Array.from({ length: n }, (_, i) => {
    const signal = u(`s${i}`);
    const noise = u(`n${i}`);
    return { id: `r${i}`, group: `g${Math.floor(i / 2)}`, label: (signal + 0.3 * noise > 0.65 ? 1 : 0) as 0 | 1, base: [u(`b${i}`)], text: `row ${i}`, signal };
  });

describe("logistic learner", () => {
  it("recovers a planted direction and predicts better than chance", () => {
    const X = Array.from({ length: 400 }, (_, i) => [u(`x${i}`), u(`z${i}`)]);
    const y = X.map(([a]) => (a! > 0.5 ? 1 : 0));
    const m = fitLogistic(X, y, 0.1);
    expect(m.w[0]!).toBeGreaterThan(Math.abs(m.w[1]!) * 5);
    expect(auc(y, X.map((x) => predictLogistic(m, x)))).toBeGreaterThan(0.95);
  });

  it("encodes intensity as mean level + spread, presence as p", () => {
    expect(encodeAnswer("presence", [0.8])).toEqual([0.8]);
    const [mean, sd] = encodeAnswer("intensity", [0, 0, 1, 0, 0]);
    expect(mean).toBeCloseTo(2);
    expect(sd).toBeCloseTo(0);
  });
});

describe("grouped folds", () => {
  it("never splits a group across folds", () => {
    const groups = Array.from({ length: 300 }, (_, i) => `g${i % 40}`);
    const f = groupFolds(groups, 5, 0);
    const seen = new Map<string, number>();
    groups.forEach((g, i) => { if (seen.has(g)) expect(f[i]).toBe(seen.get(g)); seen.set(g, f[i]!); });
    expect(new Set(f).size).toBe(5);
  });

  it("CV of a label-leaking column beats base", () => {
    const rows = plantedRows(300);
    const y = rows.map((r) => r.label);
    const base = crossValidate(rows.map((r) => r.base), y, rows.map((r) => r.group)).score;
    const withSignal = crossValidate(rows.map((r) => [...r.base, r.signal]), y, rows.map((r) => r.group)).score;
    expect(withSignal.loss).toBeLessThan(base.loss);
    expect(withSignal.auc).toBeGreaterThan(0.85);
  });
});

describe("discoverFeatures", () => {
  it("keeps the informative question, drops the flat one, and rejects a worse revision", async () => {
    const rows = plantedRows(240);
    const scripted: DiscoverAction[][] = [
      [
        { op: "add", target: "", name: "Signal", kind: "presence", question: "Does it show the signal?" },
        { op: "add", target: "", name: "Flat", kind: "presence", question: "Is it a row?" },
        { op: "add", target: "", name: "Noise", kind: "intensity", question: "How noisy is it?" },
      ],
      [{ op: "revise", target: "signal", name: "signal", kind: "presence", question: "A worse wording" }],
    ];
    const requests: number[] = [];
    const out = await discoverFeatures({
      rows,
      baseNames: ["base0"],
      rounds: 2,
      ports: {
        author: async (req) => { requests.push(req.round); if (req.round === 2) expect(req.feedback).toContain("signal"); return scripted[req.round - 1] ?? []; },
        answer: async (rs, qs) => {
          const out: Record<string, number[][]> = {};
          for (const q of qs) {
            out[q.name] = rs.map((r, i) => {
              const s = (r as (typeof rows)[number]).signal;
              if (q.name === "flat") return [0.5];
              if (q.name === "noise") { const l = Math.floor(u(`q${i}`) * 5); return [0, 1, 2, 3, 4].map((k) => (k === l ? 1 : 0)); }
              return q.round === 2 ? [u(`w${i}`)] : [s];
            });
          }
          return out;
        },
      },
    });
    expect(requests).toEqual([1, 2]);
    const names = out.accepted.map((q) => q.name);
    expect(names).toContain("signal");
    expect(names).not.toContain("flat");
    expect(out.accepted.find((q) => q.name === "signal")!.round).toBe(1);
    expect(out.journal.some((j) => j.what === "reject" && j.name === "signal")).toBe(true);
    expect(out.history[0]!.loss).toBeLessThan(out.baseCv.loss);
  });
});

describe("numeric target", () => {
  /** A critic-style score: 80 + 12 × a hidden quality only the right question can see, plus noise. */
  const scored = (n: number): Array<DiscoverRow & { quality: number }> =>
    Array.from({ length: n }, (_, i) => {
      const quality = u(`q${i}`);
      return { id: `w${i}`, group: `w${i}`, label: 80 + 12 * quality + 2 * (u(`e${i}`) - 0.5), base: [u(`b${i}`)], text: `note ${i}`, quality };
    });

  it("ridge recovers a planted slope", () => {
    const X = Array.from({ length: 300 }, (_, i) => [u(`x${i}`), u(`z${i}`)]);
    const y = X.map(([a]) => 3 + 5 * a!);
    const m = fitRidge(X, y, 1e-6);
    expect(predictLinear(m, [0.5, 0.9])).toBeCloseTo(5.5, 3);
    expect(Math.abs(m.w[1]!)).toBeLessThan(1e-3);
  });

  it("spearman is 1 for a monotone map and -1 for a reversed one", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 45])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
  });

  it("scores rounds in RMSE, shows the author the label range, and keeps the question that sees quality", async () => {
    const rows = scored(200);
    let firstExamples = "";
    const out = await discoverFeatures({
      rows,
      baseNames: ["base0"],
      target: "numeric",
      rounds: 1,
      examples: 5,
      ports: {
        author: async (req) => {
          firstExamples = req.examples;
          return [
            { op: "add", target: "", name: "quality", kind: "intensity", question: "How good does it sound?" },
            { op: "add", target: "", name: "noise", kind: "presence", question: "Is it odd?" },
          ];
        },
        answer: async (rs, qs) =>
          Object.fromEntries(qs.map((q) => [q.name, rs.map((r, i) => {
            if (q.name === "noise") return [u(`o${i}`)];
            const level = Math.min(4, Math.floor((r as (typeof rows)[number]).quality * 5));
            return [0, 1, 2, 3, 4].map((k) => (k === level ? 1 : 0));
          })])),
      },
    });
    expect(out.baseCv.rmse).toBeGreaterThan(3);
    expect(out.history[0]!.rmse).toBeLessThan(1.5);
    expect(out.history[0]!.spearman).toBeGreaterThan(0.9);
    expect(out.history[0]!.logLoss).toBeUndefined();
    // Round 1 spans the range: lowest and highest label both shown.
    const labels = rows.map((r) => r.label);
    expect(firstExamples).toContain(`label ${Math.round(Math.min(...labels) * 100) / 100}`);
    expect(firstExamples).toContain(`label ${Math.round(Math.max(...labels) * 100) / 100}`);
  });

  it("refuses non-0/1 labels on a binary target", async () => {
    await expect(discoverFeatures({ rows: scored(10), baseNames: ["b"], ports: { author: async () => [], answer: async () => ({}) } })).rejects.toThrow(/numeric/);
  });
});
