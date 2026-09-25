import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bindingProblems, bindingSources, parseInputRef, resolveInputs } from "./bindings";
import { definePipeline, validatePipeline, type PipelineSpec } from "./define";
import { runPipeline } from "./run";
import { testPorts } from "./testing";

describe("parseInputRef", () => {
  it("parses node, sub-path, index, $input and alternatives", () => {
    expect(parseInputRef("evidence")).toEqual([{ source: "evidence", path: [] }]);
    expect(parseInputRef("evidence.row.top[2].slug")).toEqual([{ source: "evidence", path: ["row", "top", 2, "slug"] }]);
    expect(parseInputRef("$input.factor")).toEqual([{ source: "$input", path: ["factor"] }]);
    expect(parseInputRef("maps | retry_maps.draft")).toEqual([
      { source: "maps", path: [] },
      { source: "retry_maps", path: ["draft"] },
    ]);
  });

  it("takes a JSON literal as the last alternative only", () => {
    expect(parseInputRef("decide.row | null")).toEqual([{ source: "decide", path: ["row"] }, { literal: null }]);
    expect(parseInputRef('a | b | "none"')).toEqual([{ source: "a", path: [] }, { source: "b", path: [] }, { literal: "none" }]);
    expect(parseInputRef("x | -0.5")).toEqual([{ source: "x", path: [] }, { literal: -0.5 }]);
    expect(parseInputRef("0")).toMatch(/only its default/);
    expect(parseInputRef("a | 0 | b")).toMatch(/must be the last/);
  });

  it("refuses anything that is not a plain path", () => {
    for (const bad of ["", "a..b", "a[x]", "$env.KEY", "a.b()", "1abc", "a | "]) {
      expect(typeof parseInputRef(bad)).toBe("string");
    }
  });
});

describe("bindingProblems", () => {
  it("allows only direct inbound nodes and $input", () => {
    const inbound = new Set(["evidence"]);
    expect(bindingProblems("n", { row: "evidence.row", f: "$input.factor" }, inbound)).toEqual([]);
    const problems = bindingProblems("n", { row: "taxonomy.rows", "bad-name": "evidence", x: "evidence..y" }, inbound);
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/no edge taxonomy -> n/);
    expect(problems.join("\n")).toMatch(/"bad-name" is not an identifier/);
  });

  it("lists the nodes a binding set reads", () => {
    expect(bindingSources({ a: "x.y", b: "$input", c: "y | z" }).sort()).toEqual(["x", "y", "z"]);
  });
});

describe("resolveInputs", () => {
  const from = { evidence: { row: null, cuisines: [{ slug: "thai" }] }, maps: { n: 1 } };

  it("binds null as a value, undefined falls through, a skipped node is absent", () => {
    expect(resolveInputs({ row: "evidence.row" }, from, {})).toEqual({ row: null });
    expect(resolveInputs({ first: "evidence.cuisines[0].slug" }, from, {})).toEqual({ first: "thai" });
    expect(resolveInputs({ d: "retry_maps | maps.n" }, from, {})).toEqual({ d: 1 });
    expect(resolveInputs({ d: "evidence.missing | maps" }, from, {})).toEqual({ d: { n: 1 } });
    expect(resolveInputs({ d: "retry_maps" }, from, {})).toEqual({ d: undefined });
    expect(resolveInputs({ f: "$input.factor" }, from, { factor: 2 })).toEqual({ f: 2 });
    expect(resolveInputs(undefined, from, {})).toEqual({});
    expect(resolveInputs({ s: "decide.jevShare | 0", r: "evidence.row | 1" }, from, {})).toEqual({ s: 0, r: null });
  });
});

// ---------------------------------------------------------------------------
// In a manifest and a run
// ---------------------------------------------------------------------------

const Input = z.object({ id: z.string(), factor: z.number() });
type In = z.infer<typeof Input>;
const Output = z.object({ text: z.string() });
type Out = z.infer<typeof Output>;

const spec = (inputs: Record<string, string>): PipelineSpec<In, Out> => ({
  id: "bind-demo",
  fact: "demo",
  input: Input,
  output: Output,
  trigger: ["on-demand"],
  group: (i) => `demo-${i.id}`,
  result: ["writer", "plain"],
  nodes: {
    evidence: { kind: "read", load: () => ({ row: { p: 0.8 }, label: "from evidence" }), version: "1" },
    gate: {
      kind: "code",
      role: "gate",
      inputs,
      run: (args) => ((args.in.p as number) >= args.thresholds.p! ? "writer" : "plain"),
      branches: ["writer", "plain"],
      thresholds: { p: 0.5 },
      version: "1",
    },
    writer: {
      kind: "generate",
      prompt: "demo-writer",
      route: "writer",
      inputs: { label: "gate.label", factor: "$input.factor" },
      version: "1",
    },
    plain: { kind: "code", role: "derive", run: () => ({ text: "plain" }), version: "1" },
    persist: { kind: "store", target: "memory", scope: "user", version: "1" },
  },
  edges: [
    { from: "evidence", to: "gate" },
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

describe("inputs in a manifest", () => {
  it("a binding to a node with no edge into this one does not load", () => {
    const problems = validatePipeline(spec({ p: "persist.p" }));
    expect(problems.join("\n")).toMatch(/node "gate": input "p" reads "persist", which has no edge persist -> gate/);
  });

  it("round-trips through toJSON", () => {
    expect(definePipeline(spec({ p: "evidence.row.p" })).toJSON().nodes.find((n) => n.id === "gate")?.inputs).toEqual({
      p: "evidence.row.p",
    });
  });

  it("bodies read args.in and ports receive request.in", async () => {
    const pipeline = definePipeline(spec({ p: "evidence.row.p" }));
    let seen: Readonly<Record<string, unknown>> | undefined;
    const ports = testPorts({
      generate: {
        writer: (req) => {
          seen = req.in;
          return { value: { text: "written" } };
        },
      },
    });
    const { output, record } = await runPipeline(pipeline, { id: "r1", factor: 2 }, ports);
    expect(output.text).toBe("written");
    expect(record.nodes.find((n) => n.id === "gate")?.branch).toBe("writer");
    // The gate passes its primary through, so `gate.label` is the evidence's label.
    expect(seen).toEqual({ label: "from evidence", factor: 2 });
  });
});
