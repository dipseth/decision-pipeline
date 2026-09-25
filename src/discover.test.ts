import { describe, expect, it } from "vitest";
import { auc, crossValidate, discoverFeatures, encodeAnswer, fitLogistic, groupFolds, predictLogistic, type DiscoverAction, type DiscoverRow } from "./discover";
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
    expect(withSignal.logLoss).toBeLessThan(base.logLoss);
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
    expect(out.history[0]!.logLoss).toBeLessThan(out.baseCv.logLoss);
  });
});
