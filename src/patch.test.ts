import { describe, expect, it } from "vitest";
import { applyManifestPatch } from "./patch";
import { isGateNode, type Edge, type PipelineNode } from "./types";

const nodes = (): Record<string, PipelineNode> => ({
  classify: { kind: "decide", questions: "jev-v1", version: "1" },
  gate: {
    kind: "code", role: "gate", run: () => "a",
    branches: ["a", "b"], thresholds: { category: 0.7 }, version: "1",
  },
  writer: { kind: "generate", prompt: "p1", route: "r1", version: "1" },
});

const edges = (): Edge[] => [
  { from: "classify", to: "gate" },
  { from: "gate", to: "writer", when: { gate: "gate", branch: "b" } },
];

describe("applyManifestPatch", () => {
  it("returns a copy when there is nothing to apply", () => {
    const original = nodes();
    const result = applyManifestPatch(original, edges(), undefined);
    expect(result.applied).toEqual([]);
    expect(result.nodes).not.toBe(original);
  });

  it("never mutates the manifest it patches", () => {
    const original = nodes();
    applyManifestPatch(original, edges(), { thresholds: { gate: { category: 0.6 } } });
    const gate = original.gate;
    expect(gate && isGateNode(gate) ? gate.thresholds.category : null).toBe(0.7);
  });

  it("overrides a gate threshold and reports the diff", () => {
    const result = applyManifestPatch(nodes(), edges(), {
      thresholds: { gate: { category: 0.6 } },
    });
    const gate = result.nodes.gate;
    expect(gate && isGateNode(gate) ? gate.thresholds.category : null).toBe(0.6);
    expect(result.applied).toEqual(["gate.thresholds.category=0.6"]);
  });

  it("swaps a prompt, a route and a Jev question name", () => {
    const result = applyManifestPatch(nodes(), edges(), {
      prompts: { writer: "p2" },
      routes: { writer: "r2" },
      questions: { classify: "jev-v2" },
    });
    const writer = result.nodes.writer;
    const classify = result.nodes.classify;
    expect(writer?.kind === "generate" ? writer.prompt : null).toBe("p2");
    expect(writer?.kind === "generate" ? writer.route : null).toBe("r2");
    expect(classify?.kind === "decide" ? classify.questions : null).toBe("jev-v2");
  });

  it("rewrites and removes an edge guard", () => {
    const rewritten = applyManifestPatch(nodes(), edges(), {
      guards: [{ from: "gate", to: "writer", when: { gate: "gate", branch: "a" } }],
    });
    expect(rewritten.edges[1]?.when).toEqual({ gate: "gate", branch: "a" });

    const removed = applyManifestPatch(nodes(), edges(), {
      guards: [{ from: "gate", to: "writer", when: null }],
    });
    expect(removed.edges[1]?.when).toBeUndefined();
    expect(removed.applied).toEqual(["gate->writer.when=none"]);
  });

  it("ignores a patch aimed at the wrong node kind rather than corrupting it", () => {
    const result = applyManifestPatch(nodes(), edges(), { prompts: { gate: "p2" } });
    expect(result.applied).toEqual([]);
  });
});
