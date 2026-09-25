import { describe, expect, it } from "vitest";
import { hashToUnit } from "./hash";
import { jsonataEngine } from "./jsonata";
import {
  attachLearnedGate,
  discoverForSpec,
  fitLearnedModel,
  learnedExpression,
  learnedImportance,
  learnedQuestionSet,
  scoreLearned,
  type LearnedModel,
} from "./learned";
import { designMatrix, predictLinear, predictLogistic, questionId, type DiscoveredQuestion, type DiscoverRow } from "./discover";
import { runPipeline } from "./run";
import { compilePipelineSpec, pipelineFromSpec, type PipelineSpecJSON } from "./spec";
import { demoRegistry as registry, demoSpec, type DemoIn as In, type DemoOut as Out } from "./test-fixtures";
import { testPorts } from "./testing";

const engine = jsonataEngine();
const u = (s: string) => hashToUnit(s);

const QS: DiscoveredQuestion[] = [
  { name: "spicy", kind: "presence", question: "Is it spicy?", round: 1 },
  { name: "heat", kind: "intensity", question: "How much heat does the method use?", round: 2 },
];

const model = (target: "binary" | "numeric"): LearnedModel => ({
  target,
  columns: [
    { base: "p" },
    { question: "spicy", kind: "presence", encode: "p" },
    { question: "heat", kind: "intensity", encode: "mean" },
    { question: "heat", kind: "intensity", encode: "sd" },
  ],
  w: [0.7, 1.3, -0.4, 0.25],
  b: target === "binary" ? -0.2 : 88,
  mean: [0.5, 0.4, 2, 0.8],
  sd: [0.2, 0.3, 1.1, 0.4],
});

const evalExpr = async (m: LearnedModel, answers: Record<string, number[]>, base: Record<string, number>) =>
  ((await engine.compile(learnedExpression(m, { answers: "answers", base: "base" })).evaluate({ answers, base }, {})) as { score: number }).score;

describe("learnedExpression", () => {
  it.each(["binary", "numeric"] as const)("computes what scoreLearned computes (%s)", async (target) => {
    const m = model(target);
    for (let i = 0; i < 20; i++) {
      const heat = [u(`a${i}`), u(`b${i}`), u(`c${i}`), u(`d${i}`), u(`e${i}`)];
      const answers = { spicy: [u(`s${i}`)], heat };
      const base = { p: u(`p${i}`) };
      expect(await evalExpr(m, answers, base)).toBeCloseTo(scoreLearned(m, answers, base), 6);
    }
  });

  it("gives a missing answer or base column its training mean, so it moves nothing", async () => {
    const m = model("numeric");
    const atMeans = scoreLearned(m, { spicy: [0.4] }, { p: 0.5 });
    // heat missing: mean and sd both fall back; p at its mean; spicy at its mean.
    expect(atMeans).toBeCloseTo(88, 6);
    expect(await evalExpr(m, { spicy: [0.4] }, {})).toBeCloseTo(88, 6);
  });

  it("matches the learner it was fitted with", () => {
    const rows: DiscoverRow[] = Array.from({ length: 120 }, (_, i) => ({ id: `r${i}`, group: `r${i}`, label: u(`s${i}`) > 0.5 ? 1 : 0, base: [u(`p${i}`)], text: "" }));
    const answers: Record<string, number[][]> = {
      [questionId(QS[0]!)]: rows.map((_, i) => [u(`s${i}`)]),
      [questionId(QS[1]!)]: rows.map((_, i) => [0, 1, 2, 3, 4].map((k) => (k === Math.floor(u(`h${i}`) * 5) ? 1 : 0))),
    };
    for (const target of ["binary", "numeric"] as const) {
      const m = fitLearnedModel({ rows, baseNames: ["p"], questions: QS, answers, target });
      const { X } = designMatrix(rows, QS, answers);
      const predict = target === "binary" ? predictLogistic : predictLinear;
      rows.slice(0, 10).forEach((r, i) => {
        const got = scoreLearned(m, { spicy: answers[questionId(QS[0]!)]![i]!, heat: answers[questionId(QS[1]!)]![i]! }, { p: r.base[0]! });
        expect(got).toBeCloseTo(predict(m, X[i]!), 9);
      });
      const imp = learnedImportance(m);
      expect(Object.keys(imp).sort()).toEqual(["heat", "p", "spicy"]);
      expect(imp.spicy).toBeGreaterThan(imp.p!);
    }
  });
});

describe("learnedQuestionSet", () => {
  it("publishes the presence criteria the loop asked with", () => {
    const presence = { true: "The note says so", false: "It does not" };
    const a = attachLearnedGate(withoutGate(), model("binary"), QS, { ...attach, presence });
    const b = attachLearnedGate(withoutGate(), model("binary"), QS, attach);
    expect(learnedQuestionSet(QS, presence).spicy).toMatchObject({ criteria: presence });
    // Different wording is a different decide node version.
    expect(a.spec.nodes.disc_ask!.version).not.toBe(b.spec.nodes.disc_ask!.version);
  });

  it("asks presence as a Noul and intensity as a five-level Score", () => {
    const set = learnedQuestionSet(QS);
    expect(set.spicy).toMatchObject({ type: "noul", instructions: "Is it spicy?" });
    expect(set.heat).toMatchObject({ type: "score" });
    expect((set.heat as { criteria: string[] }).criteria).toHaveLength(5);
  });
});

/** The demo pipeline with its hand-written gate removed, so a learned one can take its place. */
const withoutGate = (): PipelineSpecJSON => {
  const spec = demoSpec();
  delete spec.nodes.gate;
  spec.edges = spec.edges.filter((e) => e.from !== "gate" && e.to !== "gate");
  spec.nodes.loud = { kind: "code", role: "derive", call: "demo.shout@1", args: { title: "$input.title", n: "$half($input.factor)" }, version: "1" };
  spec.nodes.plain = { kind: "code", role: "derive", expr: '{ "text": $input.title, "n": 0 }', version: "1" };
  spec.feedback = spec.feedback.map((f) => ({ ...f, to: "bundle" }));
  return spec;
};

const attach = {
  prefix: "disc",
  after: "bundle",
  base: "bundle",
  questionsName: "jev-demo-disc",
  gate: { cut: 0.5, above: "loud", below: "plain", routes: { loud: ["loud"], plain: ["plain"] } },
};

describe("attachLearnedGate", () => {
  it("adds decide → derive → gate, and the patched spec compiles and runs", async () => {
    const m = model("binary");
    const { spec, ids, applied } = attachLearnedGate(withoutGate(), m, QS, attach);
    expect(ids).toEqual({ ask: "disc_ask", score: "disc_score", gate: "disc_gate" });
    expect(applied).toHaveLength(3);
    expect(spec.nodes.disc_ask).toMatchObject({ kind: "decide", questions: "jev-demo-disc" });
    expect(compilePipelineSpec(spec, registry, engine).problems).toEqual([]);

    const answers = { spicy: [0.9], heat: [0, 0, 0.2, 0.5, 0.3] };
    const expected = scoreLearned(m, answers, { p: 0.8 });
    const ports = testPorts({ decide: { disc_ask: { distributions: answers } } });
    const run = await runPipeline(pipelineFromSpec<In, Out>(spec, registry, engine), { id: "r1", title: "pad thai", factor: 4 }, ports);
    expect(expected).toBeGreaterThan(0.5);
    expect(run.route).toBe("loud");
    expect(run.output).toEqual({ text: "PAD THAI", n: 2 });
    const gate = run.record.nodes.find((n) => n.id === "disc_gate")!;
    expect(gate.branch_reason).toContain(`score ${Number(expected.toPrecision(6)).toString().slice(0, 6)}`);
    expect(ports.decideCalls[0]).toMatchObject({ nodeId: "disc_ask", questions: "jev-demo-disc" });
  });

  it("replaces its own fragment on a refit, and the score node's version moves", () => {
    const first = attachLearnedGate(withoutGate(), model("binary"), QS, attach);
    const refit = { ...model("binary"), w: [0.1, 0.2, 0.3, 0.4] };
    const second = attachLearnedGate(first.spec, refit, QS, attach);
    expect(second.applied[0]).toMatch(/^replaced disc_ask, disc_score, disc_gate/);
    expect(second.spec.edges.filter((e) => e.to === "disc_ask")).toHaveLength(1);
    const v = (s: PipelineSpecJSON) => pipelineFromSpec(s, registry, engine).nodes.disc_score!.version;
    expect(v(second.spec)).not.toBe(v(first.spec));
  });

  it("refuses a model that reads base columns when no base is given", () => {
    expect(() => attachLearnedGate(withoutGate(), model("binary"), QS, { ...attach, base: undefined })).toThrow(/base/);
  });
});

describe("discoverForSpec", () => {
  it("runs the loop, fits the final model, and returns a challenger spec that compiles", async () => {
    const rows: DiscoverRow[] = Array.from({ length: 160 }, (_, i) => ({ id: `r${i}`, group: `r${i}`, label: u(`s${i}`) + 0.2 * u(`n${i}`) > 0.6 ? 1 : 0, base: [u(`p${i}`)], text: `row ${i}` }));
    const out = await discoverForSpec({
      rows,
      baseNames: ["p"],
      rounds: 1,
      spec: withoutGate(),
      attach,
      check: { registry, engine },
      ports: {
        author: async () => [{ op: "add", target: "", name: "spicy", kind: "presence", question: "Is it spicy?" }],
        answer: async (rs, qs) => Object.fromEntries(qs.map((q) => [q.name, rs.map((r) => [u(`s${r.id.slice(1)}`)])])),
      },
    });
    expect(out.problems).toEqual([]);
    expect(out.discovery.accepted.map((q) => q.name)).toEqual(["spicy"]);
    expect(out.questionSet.spicy).toMatchObject({ type: "noul" });
    expect(out.model.columns).toEqual([{ base: "p" }, { question: "spicy", kind: "presence", encode: "p" }]);
    expect(out.model.w[1]!).toBeGreaterThan(Math.abs(out.model.w[0]!));
  });
});
