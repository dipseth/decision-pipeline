import { describe, expect, it } from "vitest";
import { resolveInbound, sinkNodes, topologicalOrder } from "./graph";
import type { Edge } from "./types";

const edges: Edge[] = [
  { from: "classify", to: "table" },
  { from: "table", to: "gate" },
  { from: "gate", to: "direct", when: { gate: "gate", branch: "direct" } },
  { from: "gate", to: "writer", when: { gate: "gate", branch: "writer" } },
  { from: "direct", to: "changes" },
  { from: "writer", to: "changes" },
];
const ids = ["classify", "table", "gate", "direct", "writer", "changes"];

describe("topologicalOrder", () => {
  it("orders parents before children", () => {
    const { order, cycle } = topologicalOrder(ids, edges);
    expect(cycle).toEqual([]);
    expect(order.indexOf("classify")).toBeLessThan(order.indexOf("table"));
    expect(order.indexOf("gate")).toBeLessThan(order.indexOf("direct"));
    expect(order.indexOf("writer")).toBeLessThan(order.indexOf("changes"));
  });

  it("tie-breaks by declaration order, so a run's node order is stable", () => {
    const { order } = topologicalOrder(ids, edges);
    expect(order.indexOf("direct")).toBeLessThan(order.indexOf("writer"));
    expect(topologicalOrder(ids, edges).order).toEqual(order);
  });

  it("reports the nodes in a cycle instead of hanging", () => {
    const { order, cycle } = topologicalOrder(
      ["a", "b", "c"],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
      ],
    );
    expect(order).toEqual([]);
    expect(cycle.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("resolveInbound", () => {
  const ran = new Set(["classify", "table", "gate"]);

  it("runs a root node unconditionally", () => {
    expect(resolveInbound(edges, "classify", new Set(), () => undefined).skipReason).toBeNull();
  });

  it("opens the edge whose guard matches the branch taken", () => {
    const decision = resolveInbound(edges, "direct", ran, () => "direct");
    expect(decision.skipReason).toBeNull();
    expect(decision.open.map((e) => e.from)).toEqual(["gate"]);
  });

  it("skips the other branch WITH the reason, never silently", () => {
    const decision = resolveInbound(edges, "writer", ran, () => "direct");
    expect(decision.open).toEqual([]);
    expect(decision.skipReason).toContain('gate took "direct", needed "writer"');
  });

  it("skips downstream of a skipped node and says which one", () => {
    const decision = resolveInbound(edges, "changes", new Set(["direct"]), () => "direct");
    expect(decision.open.map((e) => e.from)).toEqual(["direct"]);

    const orphaned = resolveInbound(edges, "changes", new Set(), () => "direct");
    expect(orphaned.skipReason).toContain("direct skipped");
    expect(orphaned.skipReason).toContain("writer skipped");
  });

  it("runs a join node when ANY inbound edge is open", () => {
    const decision = resolveInbound(edges, "changes", new Set(["writer"]), () => "writer");
    expect(decision.skipReason).toBeNull();
  });
});

describe("sinkNodes", () => {
  it("finds the nodes nothing flows out of", () => {
    expect(sinkNodes(ids, edges)).toEqual(["changes"]);
  });
});
