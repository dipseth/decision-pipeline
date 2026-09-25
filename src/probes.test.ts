import { describe, expect, it } from "vitest";
import { z } from "zod";
import { definePipeline, validatePipeline, type PipelineSpec } from "./define";
import { PipelineContractError } from "./errors";
import { collectProbes, MAX_PROBES, probeAnswers, probeFeatures, splitProbeDistributions } from "./probes";
import { runPipeline } from "./run";
import { testPorts } from "./testing";
import type { DecideNode, GateNode, NodeRunArgs, ProbeAnswer } from "./types";

const noul = (instructions: string) => ({ type: "noul", instructions });

describe("collectProbes", () => {
  it("accepts the three shapes and assigns slot keys in order", () => {
    const set = collectProbes(
      [
        noul("Does `recipe.ingredients` include a chili paste?"),
        { type: "choice", instructions: "Which technique leads `recipe.steps`?", criteria: { wok: "stir-fry", braise: "braise" } },
        { type: "score", instructions: "How regional is `recipe.notes`?", criteria: ["generic", "national", "regional"] },
      ],
      { from: "w", max: 3, paths: ["recipe"] },
    );
    expect(Object.keys(set.asked)).toEqual(["probe_0", "probe_1", "probe_2"]);
    expect(set.dropped).toEqual([]);
  });

  it("drops invalid, off-state, duplicate, too-long and over-max probes with a reason each", () => {
    const set = collectProbes(
      {
        probes: [
          noul("Is `recipe.title` Peruvian?"),
          { type: "choice", instructions: "Pick `recipe.steps`", criteria: { only: "one option" } },
          noul("Is the weather nice?"),
          noul("is  `recipe.title`  PERUVIAN?"),
          noul(`Is \`recipe.notes\` ${"x".repeat(900)}?`),
          noul("Is `recipe.steps[0]` a marinade?"),
          noul("Is `recipe.ingredients` vegetarian?"),
        ],
      },
      { from: "w", max: 2, paths: ["recipe"] },
    );
    expect(Object.values(set.asked).map((q) => q.instructions)).toEqual([
      "Is `recipe.title` Peruvian?",
      "Is `recipe.steps[0]` a marinade?",
    ]);
    expect(set.dropped.map((d) => [d.index, d.reason.split(":")[0]])).toEqual([
      [1, "invalid"],
      [2, "addresses no state path (want one of"],
      [3, "duplicate"],
      [4, "too long"],
      [6, "over max (2)"],
    ]);
  });

  it("never throws on garbage, and never exceeds MAX_PROBES whatever the spec says", () => {
    expect(collectProbes("nope", { from: "w", max: 3 }).dropped[0]?.index).toBe(-1);
    const many = Array.from({ length: 20 }, (_, i) => noul(`question ${i}?`));
    expect(Object.keys(collectProbes(many, { from: "w", max: 99 }).asked)).toHaveLength(MAX_PROBES);
  });
});

describe("probe answers and features", () => {
  const asked = {
    probe_0: { type: "noul" as const, instructions: "a?" },
    probe_1: { type: "choice" as const, instructions: "b?", criteria: { x: "x", y: "y" } },
    probe_2: { type: "noul" as const, instructions: "c?" },
  };

  it("pairs answers with default option keys and lists the unanswered", () => {
    const { answers, unanswered } = probeAnswers(asked, { probe_0: [0.9], probe_1: [0.6, 0.4] }, undefined);
    expect(answers.map((a) => [a.key, a.options])).toEqual([
      ["probe_0", ["true"]],
      ["probe_1", ["x", "y"]],
    ]);
    expect(unanswered).toEqual(["probe_2"]);
  });

  it("emits aggregates only — no per-slot columns", () => {
    const { answers } = probeAnswers(asked, { probe_0: [0.9], probe_1: [0.6, 0.4] }, undefined);
    const f = probeFeatures("d", { from: "w", asked, dropped: [], unanswered: ["probe_2"] }, answers);
    expect(Object.keys(f).some((k) => k.includes("probe_"))).toBe(false);
    expect(f["d.probes.asked"]).toBe(3);
    expect(f["d.probes.answered"]).toBe(2);
    expect(f["d.probes.min_margin"]).toBeCloseTo(0.2);
  });

  it("splits probe distributions from the static questions", () => {
    expect(splitProbeDistributions({ dish: [0.9], probe_0: [0.2] })).toEqual({
      fixed: { dish: [0.9] },
      probes: { probe_0: [0.2] },
    });
  });
});

// ---------------------------------------------------------------------------
// In a run
// ---------------------------------------------------------------------------

const Input = z.object({ id: z.string(), title: z.string() });
type In = z.infer<typeof Input>;
const Output = z.object({ text: z.string() });
type Out = z.infer<typeof Output>;

const spec = (seen: { gate?: NodeRunArgs<In>["probes"]; interpret?: Record<string, number[]> } = {}): PipelineSpec<In, Out> => ({
  id: "probe-demo",
  fact: "demo",
  input: Input,
  output: Output,
  trigger: ["on-demand"],
  group: (i) => `demo-${i.id}`,
  result: ["writer", "plain"],
  nodes: {
    evidence: { kind: "read", load: ({ input }) => ({ recipe: { title: input.title } }), version: "1" },
    probe_gen: { kind: "generate", prompt: "demo-probes", route: "cheap", onFailure: "skip", version: "1" },
    classify: {
      kind: "decide",
      questions: "jev-demo",
      probes: { from: "probe_gen", max: 2, paths: ["recipe"] },
      interpret: (d) => {
        seen.interpret = d;
        return { dish: d.dish?.[0] ?? 0 };
      },
      version: "1",
    },
    gate: {
      kind: "code",
      role: "gate",
      run: (args) => {
        seen.gate = args.probes;
        return (args.primary as { dish: number }).dish >= 0.5 ? "writer" : "plain";
      },
      branches: ["writer", "plain"],
      thresholds: { dish: 0.5 },
      version: "1",
    },
    writer: { kind: "generate", prompt: "demo-writer", route: "writer", version: "1" },
    plain: { kind: "code", role: "derive", run: () => ({ text: "plain" }), version: "1" },
    persist: { kind: "store", target: "memory", scope: "user", version: "1" },
  },
  edges: [
    { from: "evidence", to: "probe_gen" },
    { from: "evidence", to: "classify" },
    { from: "probe_gen", to: "classify" },
    { from: "classify", to: "gate" },
    { from: "gate", to: "writer", when: { gate: "gate", branch: "writer" } },
    { from: "gate", to: "plain", when: { gate: "gate", branch: "plain" } },
    { from: "writer", to: "persist" },
    { from: "plain", to: "persist" },
  ],
  feedback: [
    {
      id: "rating",
      from: "surface:demo",
      to: "gate",
      source: "explicit",
      scope: "user",
      form: "score",
      latency: "deferred",
      score: { name: "demo_feedback", dataType: "NUMERIC" },
    },
  ],
  eval: { dataset: "demo-eval", gateMetric: "score_positive" },
});

const PROBES = [
  noul("Is `recipe.title` a fusion dish?"),
  noul("Is the moon full?"),
  { type: "choice", instructions: "Which tradition does `recipe.title` lean to?", criteria: { peru: "Peru", china: "China" } },
];

describe("runPipeline with probes", () => {
  it("asks validated probes in the same decide call and records their text", async () => {
    const seen: Parameters<typeof spec>[0] = {};
    const pipeline = definePipeline(spec(seen));
    let writerProbes: readonly ProbeAnswer[] | undefined;
    const ports = testPorts({
      generate: {
        probe_gen: { value: { probes: PROBES }, costUsd: 0.001 },
        writer: (req) => {
          writerProbes = req.probes.classify;
          return { value: { text: "written" }, costUsd: 0.01 };
        },
      },
      decide: {
        classify: (req) => ({
          distributions: { dish: [0.8], ...Object.fromEntries(Object.keys(req.probes).map((k, i) => [k, i === 0 ? [0.9] : [0.55, 0.45]])) },
          distributionOptions: { probe_1: ["peru", "china"] },
          costUsd: 0,
        }),
      },
    });

    const { output, record } = await runPipeline(pipeline, { id: "r1", title: "Chifa lomo saltado" }, ports);
    expect(output.text).toBe("written");

    const call = ports.decideCalls[0]!;
    expect(call.questions).toBe("jev-demo");
    expect(Object.keys(call.probes)).toEqual(["probe_0", "probe_1"]);

    const node = record.nodes.find((n) => n.id === "classify")!;
    expect(node.probes?.asked.probe_1?.instructions).toContain("tradition");
    expect(node.probes?.dropped).toEqual([{ index: 1, reason: expect.stringContaining("addresses no state path") }]);
    expect(Object.keys(node.distributions ?? {})).toEqual(["dish", "probe_0", "probe_1"]);

    // Evidence for the writer…
    expect(writerProbes?.map((a) => [a.key, a.options])).toEqual([
      ["probe_0", ["true"]],
      ["probe_1", ["peru", "china"]],
    ]);
    // …and never for a gate or `interpret`.
    expect(seen.gate).toEqual({});
    expect(Object.isFrozen(seen.gate)).toBe(true);
    expect(Object.keys(seen.interpret ?? {})).toEqual(["dish"]);

    // Aggregates beside the static question's own features, no per-slot keys.
    expect(record.features["classify.probes.asked"]).toBe(2);
    expect(record.features["classify.probes.dropped"]).toBe(1);
    expect(record.features["classify.dish.top"]).toBe(0.8);
    expect(Object.keys(record.features).some((k) => k.includes("probe_"))).toBe(false);
  });

  it("still asks the static questions when the writer fails", async () => {
    const pipeline = definePipeline(spec());
    const ports = testPorts({
      generate: {
        probe_gen: () => {
          throw new Error("model down");
        },
        writer: { value: { text: "w" } },
      },
      decide: { classify: { distributions: { dish: [0.9] } } },
    });
    const { record } = await runPipeline(pipeline, { id: "r1", title: "t" }, ports);
    expect(ports.decideCalls[0]?.probes).toEqual({});
    expect(record.nodes.find((n) => n.id === "classify")?.probes?.dropped[0]?.reason).toBe("probe_gen did not run");
  });

  it("a probe-only decide node with nothing valid to ask fails through its onFailure, with the drops recorded", async () => {
    const base = spec();
    const pipeline = definePipeline({
      ...base,
      nodes: {
        ...base.nodes,
        classify: { kind: "decide", probes: { from: "probe_gen", max: 2, paths: ["recipe"] }, onFailure: "skip", version: "1" },
        gate: { ...base.nodes.gate, run: () => "plain" } as GateNode<In>,
      },
      edges: [...base.edges, { from: "evidence", to: "gate" }],
    });
    const ports = testPorts({
      generate: { probe_gen: { value: [noul("Is it sunny?")] } },
      decide: {},
    });
    const { record, skipped } = await runPipeline(pipeline, { id: "r1", title: "t" }, ports);
    expect(ports.decideCalls).toHaveLength(0);
    expect(skipped.classify).toMatch(/no probes to ask \(1 dropped/);
    expect(record.nodes.find((n) => n.id === "classify")?.probes?.dropped).toHaveLength(1);
  });
});

describe("probe contract", () => {
  const problems = (patch: (s: PipelineSpec<In, Out>) => void): string[] => {
    const s = spec();
    patch(s);
    return validatePipeline(s);
  };

  it("loads the demo manifest and exports probes in toJSON", () => {
    const json = definePipeline(spec()).toJSON();
    expect(json.nodes.find((n) => n.id === "classify")?.probes).toEqual({ from: "probe_gen", max: 2, paths: ["recipe"] });
  });

  it("requires a generate writer on a direct edge", () => {
    expect(
      problems((s) => {
        s.nodes.classify = { ...s.nodes.classify, probes: { from: "evidence", max: 2 } } as DecideNode<In>;
      }),
    ).toContainEqual(expect.stringContaining("probes.from must be a generate node"));
    expect(
      problems((s) => {
        s.edges = s.edges.filter((e) => !(e.from === "probe_gen" && e.to === "classify"));
      }),
    ).toContainEqual(expect.stringContaining("needs a direct edge probe_gen -> classify"));
  });

  it("refuses a decide node with neither questions nor probes, a cached probe node, and an out-of-range max", () => {
    expect(
      problems((s) => {
        s.nodes.classify = { kind: "decide", version: "1" };
      }),
    ).toContainEqual(expect.stringContaining("needs `questions`, `probes`, or both"));
    expect(
      problems((s) => {
        s.nodes.classify = { ...s.nodes.classify, cache: "per-run" } as DecideNode<In>;
      }),
    ).toContainEqual(expect.stringContaining("may not be cached"));
    expect(() =>
      definePipeline({
        ...spec(),
        nodes: { ...spec().nodes, classify: { kind: "decide", questions: "q", probes: { from: "probe_gen", max: 50 }, version: "1" } },
      }),
    ).toThrow(PipelineContractError);
  });
});
