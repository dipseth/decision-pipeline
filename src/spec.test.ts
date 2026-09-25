import { describe, expect, it } from "vitest";
import { jsonataEngine } from "./jsonata";
import { runPipeline } from "./run";
import {
  compilePipelineSpec,
  defineRegistry,
  describeRegistry,
  mergeRegistries,
  pipelineFromSpec,
  pipelineSpecJsonSchema,
  type PipelineSpecJSON,
} from "./spec";
import { testPorts } from "./testing";

const engine = jsonataEngine();

import {
  DemoInput as Input,
  DemoOutput as Output,
  demoRegistry as registry,
  demoSpec as base,
  type DemoIn as In,
  type DemoOut as Out,
} from "./test-fixtures";

const INPUT: In = { id: "r1", title: "pad thai", factor: 4 };

describe("compilePipelineSpec — a spec runs like a TS manifest", () => {
  it("routes by rules, calls primitives, packs bindings, and records the gate's reason", async () => {
    const pipeline = pipelineFromSpec<In, Out>(base(), registry, engine);
    const ports = testPorts({});
    const run = await runPipeline(pipeline, INPUT, ports);
    expect(run.output).toEqual({ text: "PAD THAI", n: 2 });
    expect(run.route).toBe("loud");
    const gate = run.record.nodes.find((n) => n.id === "gate")!;
    expect(gate).toMatchObject({ branch: "loud", branch_reason: "p 0.8", thresholds: { p: 0.5 } });
    expect(ports.tracer.roots[0]!.name).toBe("pipeline:spec-demo");
    expect(run.record.group).toBe("demo-r1");
  });

  it("takes the catch-all branch when no earlier rule matches", async () => {
    const spec = base();
    (spec.nodes.gate as { thresholds: Record<string, number> }).thresholds = { p: 0.9 };
    const run = await runPipeline(pipelineFromSpec<In, Out>(spec, registry, engine), INPUT, testPorts({}));
    expect(run.route).toBe("plain");
    expect(run.output).toEqual({ text: "pad thai", n: 0 });
  });

  it("a node's version carries a hash of its body, so an edited expression is a new version", () => {
    const a = pipelineFromSpec(base(), registry, engine);
    const edited = base();
    (edited.nodes.plain as { expr: string }).expr = '{ "text": gate.title, "n": 1 }';
    const b = pipelineFromSpec(edited, registry, engine);
    expect(a.nodes.plain!.version).toMatch(/^1~[0-9a-f]{8}$/);
    expect(a.nodes.plain!.version).not.toBe(b.nodes.plain!.version);
    expect(a.nodes.gate!.version).toBe(b.nodes.gate!.version);
    expect(a.nodes.persist!.version).toBe("1");
  });

  it("args that miss the primitive's schema fail the node, and onFailure decides", async () => {
    const spec = base();
    const loud = spec.nodes.loud as { args: Record<string, string>; onFailure?: string; fallback?: unknown };
    loud.args.n = "'four'";
    await expect(runPipeline(pipelineFromSpec<In, Out>(spec, registry, engine), INPUT, testPorts({}))).rejects.toThrow(
      /args for demo.shout@1 do not match its schema — n:/,
    );
    loud.onFailure = "fallback";
    loud.fallback = { value: { text: "fallback", n: -1 } };
    const run = await runPipeline(pipelineFromSpec<In, Out>(spec, registry, engine), INPUT, testPorts({}));
    expect(run.output).toEqual({ text: "fallback", n: -1 });
  });

  it("an assert that fails names its message", async () => {
    const spec = base();
    (spec.nodes.plain as { expr: string }).expr = '{ "text": "", "n": 0 }';
    (spec.nodes.gate as { thresholds: Record<string, number> }).thresholds = { p: 0.9 };
    await expect(runPipeline(pipelineFromSpec<In, Out>(spec, registry, engine), INPUT, testPorts({}))).rejects.toThrow(/check: empty text/);
  });
});

describe("compilePipelineSpec — every problem at once, for a repair loop", () => {
  it("lists registry, expression, rule and contract problems together", () => {
    const spec = base();
    (spec.nodes.loud as { call: string }).call = "demo.whisper@1";
    (spec.nodes.plain as { expr: string }).expr = "{ unclosed";
    const gate = spec.nodes.gate as { rules: Array<{ when?: string; branch: string }> };
    gate.rules = [{ branch: "loud" }, { when: "true", branch: "quiet" }];
    const { pipeline, problems } = compilePipelineSpec(spec, registry, engine);
    expect(pipeline).toBeNull();
    const text = problems.join("\n");
    expect(text).toMatch(/nodes.loud: unknown primitive "demo.whisper@1"/);
    expect(text).toMatch(/nodes.plain: expression does not parse/);
    expect(text).toMatch(/rules\[1\]: branch "quiet" is not one of loud, plain/);
    expect(text).toMatch(/rules\[0\]: only the last rule may omit `when`/);
    expect(text).toMatch(/the last rule must have no `when`/);
    expect(text).toMatch(/no rule produces branch "plain"/);
  });

  it("refuses an expression that reads something not flowing into the node, and says why", () => {
    const spec = base();
    (spec.nodes.plain as { expr: string }).expr = '{ "text": bundle.title, "n": $count(items[p > 0].slug) }';
    const text = compilePipelineSpec(spec, registry, engine).problems.join("\n");
    expect(text).toMatch(/nodes.plain: reads `bundle`, which is not a node with an edge into it \(gate\) — a gate passes its input through/);
    expect(text).toMatch(/reads `items`/);
    // Fields after the first step and names inside the filter are not roots.
    expect(text).not.toMatch(/reads `(title|p|slug)`/);
  });

  it("runs the definePipeline contract once the spec itself is sound", () => {
    const spec = base();
    spec.feedback = [];
    spec.nodes.bundle = { ...spec.nodes.bundle, inputs: { p: "persist.p" } } as PipelineSpecJSON["nodes"][string];
    const { problems } = compilePipelineSpec(spec, registry, engine);
    expect(problems.join("\n")).toMatch(/no feedback edge/);
    expect(problems.join("\n")).toMatch(/input "p" reads "persist", which has no edge persist -> bundle/);
  });

  it("rejects unknown fields instead of ignoring them", () => {
    const spec = base() as unknown as { nodes: Record<string, Record<string, unknown>> };
    spec.nodes.plain!.run = "() => 1";
    expect(compilePipelineSpec(spec, registry, engine).problems.join("\n")).toMatch(/nodes.plain/);
  });
});

describe("registry and catalog", () => {
  it("describes itself for a model, and the spec has a JSON Schema", () => {
    const d = describeRegistry(registry);
    expect(d.primitives.map((p) => p.ref)).toEqual(["demo.load@1", "demo.shout@1"]);
    expect(d.primitives[1]!.args).toMatchObject({ type: "object", properties: { title: { type: "string" } } });
    expect(d.functions).toEqual([{ name: "$half", describe: "x / 2" }]);
    expect(pipelineSpecJsonSchema()).toMatchObject({ type: "object" });
  });

  it("refuses a double registration and a shadowed binding", () => {
    expect(() => mergeRegistries(registry, registry)).toThrow(/defined twice/);
    expect(() => defineRegistry({ functions: { t: { describe: "", fn: (() => 1) as never } } })).toThrow(/shadow/);
  });
});

describe("jsonataEngine", () => {
  it("returns plain arrays and wraps JSONata errors as Errors", async () => {
    const out = await engine.compile("[1,2,3].($ * 2)").evaluate({}, {});
    expect(out).toEqual([2, 4, 6]);
    expect(Object.keys(out as object)).toEqual(["0", "1", "2"]);
    await expect(engine.compile("$nope()").evaluate({}, {})).rejects.toBeInstanceOf(Error);
    expect(() => engine.compile("(")).toThrow(Error);
  });

  it("timeboxes runaway recursion, by depth and by time", async () => {
    // Not a tail call — JSONata optimises those into a loop that never deepens.
    const deep = jsonataEngine({ maxDepth: 50 }).compile("( $f := function($n) { 1 + $f($n + 1) }; $f(0) )");
    await expect(deep.evaluate({}, {})).rejects.toThrow(/exceeded depth 50/);
    const loop = jsonataEngine({ timeoutMs: 50 }).compile("( $f := function($n) { $f($n + 1) }; $f(0) )");
    await expect(loop.evaluate({}, {})).rejects.toThrow(/exceeded 50 ms/);
  });
});
