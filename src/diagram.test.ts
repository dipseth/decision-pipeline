import { describe, expect, it } from "vitest";
import { layoutPipeline, nodeSubtitle, renderPipelineSvg, type DiagramInput } from "./diagram";

/** The shape of Scale (#317): decide → transform → gate ⑂2 → gate ⑂2 → writers → guard → derive → store, two feedback edges. */
const scale: DiagramInput = {
  id: "scale",
  fact: "scaled_recipe",
  trigger: ["on-demand"],
  result: ["changes"],
  decidedBy: "llm",
  nodes: [
    { id: "classify", kind: "decide", questions: "jev-scale-classify", onFailure: "fallback", version: "3" },
    { id: "table", kind: "code", role: "transform", version: "2" },
    { id: "gate", kind: "code", role: "gate", branches: ["direct", "writer"], thresholds: { direct_line: { env: "X", default: 0.8 } }, version: "1" },
    { id: "direct", kind: "code", role: "derive", version: "1" },
    { id: "agent", kind: "code", role: "gate", branches: ["quick", "full"], thresholds: {}, version: "1" },
    { id: "writer_quick", kind: "generate", prompt: "recipe-scale-quick", route: "scale-writer-quick", version: "7" },
    { id: "writer_full", kind: "generate", prompt: "recipe-scale", route: "scale-writer", version: "7" },
    { id: "guard", kind: "code", role: "validate", version: "1" },
    { id: "changes", kind: "code", role: "derive", version: "2" },
    { id: "persist", kind: "store", target: "turso", scope: "tenant", version: "1" },
  ],
  edges: [
    { from: "classify", to: "table" },
    { from: "table", to: "gate" },
    { from: "gate", to: "direct", when: { gate: "gate", branch: "direct" } },
    { from: "gate", to: "agent", when: { gate: "gate", branch: "writer" } },
    { from: "agent", to: "writer_quick", when: { gate: "agent", branch: "quick" } },
    { from: "agent", to: "writer_full", when: { gate: "agent", branch: "full" } },
    { from: "writer_quick", to: "guard" },
    { from: "writer_full", to: "guard" },
    { from: "direct", to: "changes" },
    { from: "guard", to: "changes" },
    { from: "changes", to: "persist" },
  ],
  feedback: [
    { id: "rating", from: "surface:scaling-notes", to: "gate", source: "explicit", scope: "user", form: "score", latency: "deferred", score: { name: "scale_feedback", dataType: "NUMERIC" } },
    { id: "flagged-lines", from: "surface:scaling-notes", to: "classify", source: "explicit", scope: "user", form: "queue", latency: "deferred", promoteVia: "scale-line-review" },
  ],
};

describe("layoutPipeline", () => {
  it("layers by longest path and keeps every node inside the canvas", () => {
    const l = layoutPipeline(scale);
    const at = (id: string) => l.nodes.find((n) => n.id === id)!;
    expect(at("classify").layer).toBe(0);
    expect(at("gate").layer).toBe(2);
    expect(at("direct").layer).toBe(3);
    expect(at("agent").layer).toBe(3);
    expect(at("guard").layer).toBe(5);
    expect(at("changes").layer).toBe(6);
    expect(at("persist").layer).toBe(7);
    for (const n of l.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(l.width);
      expect(n.y + n.h).toBeLessThanOrEqual(l.height);
      expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
    }
    expect(l.sinks).toEqual(["persist"]);
  });

  it("never overlaps two nodes in one layer", () => {
    const l = layoutPipeline(scale);
    for (const a of l.nodes) {
      for (const b of l.nodes) {
        if (a === b || a.layer !== b.layer) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });

  it("groups feedback edges by surface, below the graph", () => {
    const l = layoutPipeline(scale);
    expect(l.surfaces).toHaveLength(1);
    const s = l.surfaces[0]!;
    expect(s.channel).toBe("surface");
    expect(s.name).toBe("scaling-notes");
    expect(s.edges.map((f) => f.to)).toEqual(["gate", "classify"]);
    expect(s.y).toBeGreaterThan(Math.max(...l.nodes.map((n) => n.y + n.h)));
    expect(layoutPipeline(scale, { feedback: false }).surfaces).toHaveLength(0);
  });

  it("works without `order` and drops an edge to an unknown node", () => {
    const l = layoutPipeline({ ...scale, edges: [...scale.edges, { from: "persist", to: "ghost" }] });
    expect(l.edges).toHaveLength(scale.edges.length);
    expect(l.nodes.find((n) => n.id === "persist")?.layer).toBe(7);
  });

  it("runs an edge that skips a layer down a rail at the left, one rail per fan", () => {
    const fanOut = layoutPipeline({
      id: "chain",
      nodes: ["a", "b", "c", "d", "e"].map((id) => ({ id, kind: "code", role: "transform" })),
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
        { from: "d", to: "e" },
        { from: "a", to: "d" },
        { from: "a", to: "e" },
        { from: "b", to: "e" },
      ],
    });
    // a fans out (a→d, a→e) and owns a rail; b's one long edge joins e's fan-in rail
    expect([...fanOut.rails.keys()].sort()).toEqual(["dst:e", "src:a"]);
    for (const x of fanOut.rails.values()) expect(x).toBeLessThan(fanOut.graphLeft);
    expect(fanOut.nodes.every((n) => n.y >= 20)).toBe(true);

    const fanIn = layoutPipeline({
      id: "fan-in",
      nodes: ["a", "b", "c", "z"].map((id) => ({ id, kind: "code", role: "transform" })),
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "z" },
        { from: "a", to: "z" },
        { from: "b", to: "z" },
      ],
    });
    // a and b each have ONE long edge, both into z: they share z's rail
    expect([...fanIn.rails.keys()]).toEqual(["dst:z"]);
  });

  it("wraps a long header and the legend for a narrow graph", () => {
    const narrow: DiagramInput = {
      id: "narrow",
      fact: "a_fact",
      trigger: ["ingest", "cron", "on-demand"],
      result: ["one", "two", "three", "four"],
      decidedBy: "llm",
      nodes: [{ id: "a", kind: "read" }, { id: "b", kind: "store", target: "turso", scope: "tenant" }],
      edges: [{ from: "a", to: "b" }],
    };
    const svg = renderPipelineSvg(narrow);
    const headerStart = svg.indexOf('class="dp-header"');
    const header = svg.slice(headerStart, svg.indexOf("</g>", headerStart));
    expect((header.match(/<text/g) ?? []).length).toBeGreaterThan(2);
    const legend = svg.slice(svg.indexOf('class="dp-legend"'));
    expect(new Set(legend.match(/<text x="[\d.]+" y="([\d.]+)"/g)?.map((m) => m.replace(/.*y=/, ""))).size).toBeGreaterThan(1);
  });
});

describe("nodeSubtitle", () => {
  it("names the one thing that identifies a node", () => {
    expect(nodeSubtitle({ id: "x", kind: "decide", questions: "jev-q" })).toBe("decide · jev-q");
    expect(nodeSubtitle({ id: "x", kind: "decide", probes: { from: "w" } })).toBe("decide · probes ← w");
    expect(nodeSubtitle({ id: "x", kind: "generate", prompt: "p" })).toBe("generate · p");
    expect(nodeSubtitle({ id: "x", kind: "code", role: "gate", thresholds: { a: 1, b: 2 } })).toBe("gate · a, b");
    expect(nodeSubtitle({ id: "x", kind: "code", role: "transform", thresholds: { a: 1 } })).toBe("transform · 1 threshold");
    expect(nodeSubtitle({ id: "x", kind: "store", target: "turso", scope: "tenant" })).toBe("store · turso · tenant");
    expect(nodeSubtitle({ id: "x", kind: "read", providesFeatures: true })).toBe("read · features");
  });
});

describe("renderPipelineSvg", () => {
  const svg = renderPipelineSvg(scale, { title: "Scale" });

  it("is one SVG with every node, edge, branch and feedback edge addressable", () => {
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).not.toMatch(/NaN|undefined/);
    for (const n of scale.nodes) expect(svg).toContain(`data-node="${n.id}"`);
    for (const e of scale.edges) expect(svg).toContain(`data-edge="${e.from}→${e.to}"`);
    for (const b of ["direct", "writer", "quick", "full"]) expect(svg).toContain(`data-branch="${b}"`);
    for (const f of scale.feedback ?? []) expect(svg).toContain(`data-feedback="${f.id}"`);
    expect(svg).toContain(`data-surface="surface:scaling-notes"`);
    expect(svg).toMatch(/<title id="[^"]+">Scale — decision pipeline<\/title>/);
  });

  it("draws a gate as the hexagon and a survivable node dashed", () => {
    expect(svg).toMatch(/data-node="gate"[^>]*data-role="gate">.*?<path d="M/s);
    expect(svg).toMatch(/data-node="classify"[^>]*>.*?stroke-dasharray="4 3"/s);
    expect(svg).not.toMatch(/data-node="table"[^>]*>[^/]*?stroke-dasharray/s);
  });

  it("escapes text and puts the details in a tooltip", () => {
    const out = renderPipelineSvg({ ...scale, nodes: [{ id: "a<b", kind: "read", describe: "reads \"x\" & y" }], edges: [], feedback: [] });
    expect(out).toContain("a&lt;b");
    expect(out).toContain("reads &quot;x&quot; &amp; y");
    expect(out).not.toContain("a<b");
  });

  it("is theme-aware inline and self-contained when standalone", () => {
    expect(svg).toContain("var(--dp-gate, #d97706)");
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toContain("<style>");
    const alone = renderPipelineSvg(scale, { standalone: true });
    expect(alone).toContain("prefers-color-scheme: dark");
    expect(alone).toContain('style="color:#1c1917;background:#ffffff"');
  });

  it("can leave the header and legend out", () => {
    const bare = renderPipelineSvg(scale, { header: false, legend: false });
    expect(bare).not.toContain('class="dp-header"');
    expect(bare).not.toContain('class="dp-legend"');
    expect(bare.length).toBeLessThan(svg.length);
  });
});
