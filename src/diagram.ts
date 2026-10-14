/**
 * A decision pipeline drawn from its own JSON (#321).
 *
 * One implementation for every surface: the docs export, the API and the app
 * all call `renderPipelineSvg(manifest.toJSON())`. Nothing here imports
 * anything — the layout is a small layered DAG, top-down, with orthogonal
 * edges; the output is an SVG string.
 *
 * What the picture says, and why:
 *   - a node's colour is its KIND: read · decide (a model estimates) ·
 *     generate (a model writes) · code · gate (code decides) · store;
 *   - a gate is the only hexagon, and the branch that reaches a node is a
 *     pill on its doorstep, so "where does this fork and on what" is never in
 *     a tooltip;
 *   - a dashed outline is a node whose failure the pipeline survives
 *     (`onFailure` fallback / skip / revert);
 *   - edges are consolidated: every edge out of a node leaves by one trunk,
 *     every edge into a node arrives by one drop, and an edge that skips
 *     layers runs down a rail at the left with a tap into each layer it
 *     feeds — a node feeding six others is one line, not six;
 *   - feedback edges are the loop: a human surface (or a review queue) below
 *     the run, joined to the run's end by a faint dotted line and back UP to
 *     an EARLIER node by a dashed rail at the right — the contract's rule that
 *     a run never waits on a person, drawn.
 *
 * Colours are CSS custom properties with fallbacks (`--dp-*`), text and plain
 * edges use `currentColor`, so the same string is theme-aware inline in a page
 * and self-contained as a file (`standalone: true` embeds a light/dark style).
 */

import type { Edge, FeedbackEdge, NodeKind } from "./types";

// ---------------------------------------------------------------------------
// Input — the declarative half of a manifest, as `toJSON()` emits it
// ---------------------------------------------------------------------------

export interface DiagramNode {
  id: string;
  kind: NodeKind | string;
  role?: string;
  branches?: string[];
  describe?: string;
  version?: string;
  onFailure?: string;
  questions?: string;
  probes?: { from: string; max?: number };
  prompt?: string;
  route?: string;
  target?: string;
  scope?: string;
  thresholds?: Record<string, unknown>;
  providesFeatures?: boolean;
  acceptsFeatures?: boolean;
  batched?: boolean;
  [extra: string]: unknown;
}

export type DiagramFeedback = Omit<FeedbackEdge, "key" | "promoteVia"> & {
  key?: boolean | ((input: never) => string);
  promoteVia?: string | { lane: string; queue?: string };
};

/** What the renderer needs — `PipelineJSON` satisfies it; so does a card. */
export interface DiagramInput {
  id: string;
  /** `toJSON()`'s nodes: at least `id` and `kind`, the rest as the manifest declared it. */
  nodes: ReadonlyArray<DiagramNode | Record<string, unknown>>;
  edges: Edge[];
  feedback?: DiagramFeedback[];
  /** Topological order. Computed here when absent. */
  order?: string[];
  fact?: string;
  trigger?: string[];
  result?: string[];
  decidedBy?: string;
}

export interface DiagramOptions {
  /** Shown above the graph. Defaults to the pipeline id. */
  title?: string;
  /** One line under the title. Defaults to fact · trigger · results. */
  subtitle?: string;
  /** Draw the title block. Default true. */
  header?: boolean;
  /** Draw the legend. Default true. */
  legend?: boolean;
  /** Draw feedback surfaces and their edges. Default true. */
  feedback?: boolean;
  /**
   * Embed a light/dark `<style>` and a background so the file stands on its
   * own. Off (the default) the SVG inherits `color` and the `--dp-*` custom
   * properties from the page it is inlined in.
   */
  standalone?: boolean;
  /** Longest text on a node before it is cut with an ellipsis. Default 22. */
  maxLabelChars?: number;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** The six visual classes a node can have. Gate is a role, drawn as its own thing. */
export type NodeVisual = "read" | "decide" | "generate" | "code" | "gate" | "store";

export interface LaidOutNode {
  id: string;
  node: DiagramNode;
  layer: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** Second line: the kind, or the code role. */
  kindLabel: string;
  /** Third line: the one name that identifies the node (prompt, questions, target…). */
  name: string;
  visual: NodeVisual;
}

export interface LaidOutSurface {
  id: string;
  /** `surface` / `queue` / `hand-read` / `lane` … — the prefix of `from`. */
  channel: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  edges: DiagramFeedback[];
}

/** The horizontal lanes in the gap below layer `g`, one per trunk or rail that routes through it. */
export interface GapLanes {
  top: number;
  bottom: number;
  /** lane key (`src:<id>` or `dst:<id>`) → y of its lane */
  lane: Map<string, number>;
}

export interface DiagramLayout {
  nodes: LaidOutNode[];
  layers: string[][];
  gaps: GapLanes[];
  /**
   * Rail key → x of its rail at the left, for edges that skip a layer. A node
   * fanning out to several far nodes owns one rail (`src:<id>`); several nodes
   * feeding one far node share one (`dst:<id>`).
   */
  rails: Map<string, number>;
  surfaces: LaidOutSurface[];
  /** Feedback edge id → x of its rail at the right. */
  feedbackRails: Map<string, number>;
  edges: Edge[];
  width: number;
  height: number;
  /** Node ids with no outbound flow edge — where the run ends. */
  sinks: string[];
  /** The rail key of every edge that skips a layer (edge index → key). */
  railOf: Map<number, string>;
  /** Left and right x of the node columns (rails sit outside). */
  graphLeft: number;
  graphRight: number;
}

export const nodeVisual = (n: DiagramNode): NodeVisual => {
  if (n.kind === "code") return n.role === "gate" ? "gate" : "code";
  if (n.kind === "read" || n.kind === "decide" || n.kind === "generate" || n.kind === "store") return n.kind;
  return "code";
};

const NODE_H = 62;
const NODE_MIN_W = 96;
const NODE_MAX_W = 168;
const COL_GAP = 28;
const GAP_BASE = 30;
const LANE_STEP = 9;
const RAIL_STEP = 11;
const PAD = 20;
const MONO_CH = 7.2; // 12px ui-monospace
const MONO_SM_CH = 6.0; // 10px ui-monospace
const SANS_CH = 5.4; // 10px system-ui
const SURFACE_H = 30;
const SURFACE_GAP = 52;

const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`);

/** The one name that identifies a node — what its third line shows. */
export const nodeName = (n: DiagramNode): string => {
  switch (nodeVisual(n)) {
    case "read":
      return n.providesFeatures ? "features" : "";
    case "decide":
      return n.questions ?? (n.probes ? `probes ← ${n.probes.from}` : "");
    case "generate":
      return n.prompt ?? "";
    case "gate":
      return n.thresholds ? Object.keys(n.thresholds).join(", ") : "";
    case "store":
      return [n.target, n.scope].filter(Boolean).join(" · ");
    case "code": {
      const keys = n.thresholds ? Object.keys(n.thresholds) : [];
      return keys.length > 0 ? `${keys.length} threshold${keys.length === 1 ? "" : "s"}` : "";
    }
  }
};

/** The node's kind as its second line reads it. */
export const nodeKindLabel = (n: DiagramNode): string => {
  const v = nodeVisual(n);
  if (v === "code") return n.role ?? "code";
  if (v === "decide" && n.batched) return "decide · batched";
  if (v === "decide" && n.questions && n.probes) return "decide + probes";
  return v;
};

/** Kind and name on one line — for chips, tooltips and tests. */
export const nodeSubtitle = (n: DiagramNode): string => {
  const name = nodeName(n);
  return name ? `${nodeKindLabel(n)} · ${name}` : nodeKindLabel(n);
};

const topoOrder = (nodes: DiagramNode[], edges: Edge[]): string[] => {
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const out: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    out.push(id);
    for (const e of edges) {
      if (e.from !== id) continue;
      const d = (indeg.get(e.to) ?? 1) - 1;
      indeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  return out.length === nodes.length ? out : nodes.map((n) => n.id);
};

/** The words on a feedback edge: its form, scope and latency, and whether a review lane promotes it. */
export const feedbackLabel = (f: DiagramFeedback): string => {
  const lane = typeof f.promoteVia === "string" ? f.promoteVia : f.promoteVia?.lane;
  return cut(`${f.form} · ${f.scope} · ${f.latency}${lane ? " · lane" : ""}`, 34);
};

const parseFrom = (from: string): { channel: string; name: string } => {
  const i = from.indexOf(":");
  return i < 0 ? { channel: "surface", name: from } : { channel: from.slice(0, i), name: from.slice(i + 1) };
};

export const layoutPipeline = (input: DiagramInput, opts: DiagramOptions = {}): DiagramLayout => {
  const maxLabel = opts.maxLabelChars ?? 22;
  const nodes: DiagramNode[] = input.nodes.map((raw) => ({ ...raw, id: String(raw.id), kind: String(raw.kind) }));
  const known = new Set(nodes.map((n) => n.id));
  const edges = input.edges.filter((e) => known.has(e.from) && known.has(e.to));
  const order = input.order && input.order.length === nodes.length ? input.order : topoOrder(nodes, edges);

  // --- layers: longest path from a root
  const layerOf = new Map<string, number>();
  for (const id of order) {
    let l = 0;
    for (const e of edges) if (e.to === id) l = Math.max(l, (layerOf.get(e.from) ?? 0) + 1);
    layerOf.set(id, l);
  }
  const layerCount = Math.max(0, ...[...layerOf.values()]) + 1;
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of order) layers[layerOf.get(id) ?? 0]?.push(id);

  // --- order inside a layer: barycenter sweeps, down then up
  const pos = new Map<string, number>();
  const reindex = () => layers.forEach((ids) => ids.forEach((id, i) => pos.set(id, i)));
  reindex();
  const bary = (id: string, dir: "in" | "out"): number => {
    const ns = edges
      .filter((e) => (dir === "in" ? e.to === id : e.from === id))
      .map((e) => pos.get(dir === "in" ? e.from : e.to) ?? 0);
    return ns.length === 0 ? (pos.get(id) ?? 0) : ns.reduce((a, b) => a + b, 0) / ns.length;
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let l = 1; l < layers.length; l++) {
      const keyed = (layers[l] as string[]).map((id, i) => ({ id, k: bary(id, "in"), i }));
      keyed.sort((a, b) => a.k - b.k || a.i - b.i);
      layers[l] = keyed.map((k) => k.id);
      reindex();
    }
    for (let l = layers.length - 2; l >= 0; l--) {
      const keyed = (layers[l] as string[]).map((id, i) => ({ id, k: bary(id, "out"), i }));
      keyed.sort((a, b) => a.k - b.k || a.i - b.i);
      layers[l] = keyed.map((k) => k.id);
      reindex();
    }
  }

  // --- sizes
  const laid = new Map<string, LaidOutNode>();
  for (const n of nodes) {
    const label = cut(n.id, maxLabel);
    const kindLabel = cut(nodeKindLabel(n), maxLabel + 4);
    const name = cut(nodeName(n), maxLabel + 4);
    const visual = nodeVisual(n);
    const textW = Math.max(label.length * MONO_CH, name.length * MONO_SM_CH, kindLabel.length * SANS_CH);
    const w = Math.max(NODE_MIN_W, Math.min(NODE_MAX_W, Math.ceil(textW + 24 + (visual === "gate" ? 22 : 0))));
    laid.set(n.id, { id: n.id, node: n, layer: layerOf.get(n.id) ?? 0, x: 0, y: 0, w, h: NODE_H, label, kindLabel, name, visual });
  }

  // --- x: stack each layer, centre on the widest, then pull toward neighbours' median
  const layerW = layers.map((ids) => ids.reduce((s, id) => s + (laid.get(id)?.w ?? 0), 0) + Math.max(0, ids.length - 1) * COL_GAP);
  const widest = Math.max(0, ...layerW);
  layers.forEach((ids, l) => {
    let x = (widest - (layerW[l] ?? 0)) / 2;
    for (const id of ids) {
      const n = laid.get(id) as LaidOutNode;
      n.x = x;
      x += n.w + COL_GAP;
    }
  });
  const settle = (ids: string[], dir: "in" | "out") => {
    const want = ids.map((id) => {
      const ns = edges
        .filter((e) => (dir === "in" ? e.to === id : e.from === id))
        .map((e) => laid.get(dir === "in" ? e.from : e.to))
        .filter((n): n is LaidOutNode => n !== undefined);
      const cur = laid.get(id) as LaidOutNode;
      if (ns.length === 0) return cur.x;
      return ns.reduce((a, n) => a + n.x + n.w / 2, 0) / ns.length - cur.w / 2;
    });
    let floor = -Infinity;
    ids.forEach((id, i) => {
      const n = laid.get(id) as LaidOutNode;
      n.x = Math.max(want[i] ?? n.x, floor);
      floor = n.x + n.w + COL_GAP;
    });
  };
  for (let l = 1; l < layers.length; l++) settle(layers[l] as string[], "in");
  for (let l = layers.length - 2; l >= 0; l--) settle(layers[l] as string[], "out");
  for (let l = 1; l < layers.length; l++) settle(layers[l] as string[], "in");

  // --- rails at the left, for edges that skip a layer. Consolidated: a node
  // fanning out owns a rail; nodes fanning in to one far node share one.
  const span = (e: Edge) => (laid.get(e.to)?.layer ?? 0) - (laid.get(e.from)?.layer ?? 0);
  const longOut = new Map<string, number>();
  const longIn = new Map<string, number>();
  edges.forEach((e) => {
    if (span(e) <= 1) return;
    longOut.set(e.from, (longOut.get(e.from) ?? 0) + 1);
    longIn.set(e.to, (longIn.get(e.to) ?? 0) + 1);
  });
  const railOf = new Map<number, string>();
  edges.forEach((e, i) => {
    if (span(e) <= 1) return;
    const key = (longOut.get(e.from) ?? 0) >= 2 ? `src:${e.from}` : (longIn.get(e.to) ?? 0) >= 2 ? `dst:${e.to}` : `src:${e.from}`;
    railOf.set(i, key);
  });
  const railTop = new Map<string, number>();
  edges.forEach((e, i) => {
    const key = railOf.get(i);
    if (key === undefined) return;
    railTop.set(key, Math.min(railTop.get(key) ?? Infinity, laid.get(e.from)?.layer ?? 0));
  });
  // The rail that starts highest is outermost: its taps then cross no later rail.
  const railKeys = [...railTop.keys()].sort((a, b) => (railTop.get(a) ?? 0) - (railTop.get(b) ?? 0) || a.localeCompare(b));
  const rails = new Map<string, number>();
  railKeys.forEach((key, i) => rails.set(key, -(RAIL_STEP * (railKeys.length - i) + 10)));

  // --- gaps between layers: a lane per trunk or rail that routes through the gap
  const laneKeyBelow = (e: Edge, i: number): string => railOf.get(i) ?? `src:${e.from}`;
  const gaps: GapLanes[] = [];
  const laneSources: string[][] = layers.map(() => []);
  for (let g = 0; g < layers.length - 1; g++) {
    const direct: string[] = [];
    const viaRail: string[] = [];
    edges.forEach((e, i) => {
      const key = laneKeyBelow(e, i);
      const a = laid.get(e.from) as LaidOutNode;
      const b = laid.get(e.to) as LaidOutNode;
      if (a.layer === g && !direct.includes(key)) direct.push(key);
      if (railOf.has(i) && b.layer === g + 1 && a.layer !== g && !viaRail.includes(key)) viaRail.push(key);
    });
    const xOf = (key: string) => laid.get(key.slice(4))?.x ?? 0;
    laneSources[g] = [...direct.sort((a, b) => xOf(a) - xOf(b)), ...viaRail.filter((k) => !direct.includes(k))];
  }

  // --- y: layers stacked, each gap as tall as its lanes need
  const minX = Math.min(0, ...[...laid.values()].map((n) => n.x));
  const railLeft = Math.min(0, ...rails.values());
  const shiftX = PAD - railLeft - minX;
  let y = PAD;
  layers.forEach((ids, l) => {
    for (const id of ids) {
      const n = laid.get(id) as LaidOutNode;
      n.y = y;
      n.x += shiftX;
    }
    y += NODE_H;
    if (l < layers.length - 1) {
      const sources = laneSources[l] as string[];
      const lanesH = Math.max(1, sources.length) * LANE_STEP;
      const top = y;
      const bottom = y + GAP_BASE + lanesH;
      const lane = new Map<string, number>();
      sources.forEach((id, i) => lane.set(id, top + (GAP_BASE - LANE_STEP) / 2 + LANE_STEP * (i + 1)));
      gaps.push({ top, bottom, lane });
      y = bottom;
    }
  });
  for (const [key, x] of rails) rails.set(key, x + shiftX + minX);
  const graphLeft = Math.min(...[...laid.values()].map((n) => n.x));
  const graphRight = Math.max(...[...laid.values()].map((n) => n.x + n.w));
  let maxY = y;

  // --- feedback: surfaces below, rails at the right
  const sinks = nodes.map((n) => n.id).filter((id) => !edges.some((e) => e.from === id));
  const surfaces: LaidOutSurface[] = [];
  const feedbackRails = new Map<string, number>();
  const feedback = opts.feedback === false ? [] : (input.feedback ?? []).filter((f) => known.has(f.to));
  if (feedback.length > 0) {
    const groups = new Map<string, DiagramFeedback[]>();
    for (const f of feedback) groups.set(f.from, [...(groups.get(f.from) ?? []), f]);
    const rowY = maxY + SURFACE_GAP;
    let x = graphLeft;
    for (const [from, fs] of groups) {
      const { channel, name } = parseFrom(from);
      const label = cut(name, maxLabel + 6);
      const w = Math.ceil(channel.length * 6.4 + label.length * MONO_CH + 52);
      surfaces.push({ id: from, channel, name: label, x, y: rowY, w, h: SURFACE_H, edges: fs });
      x += w + 24;
    }
    // Rails in order of how high they reach: the highest tap is the outermost, so nothing crosses it.
    const byReach = [...feedback].sort((a, b) => (laid.get(a.to)?.y ?? 0) - (laid.get(b.to)?.y ?? 0));
    byReach.forEach((f, i) => feedbackRails.set(f.id, graphRight + 22 + RAIL_STEP * (byReach.length - i)));
    maxY = rowY + SURFACE_H + 10 + 7 * surfaces.length;
  }

  const labelRoom = feedback.length > 0 ? 10 + Math.max(...feedback.map((f) => feedbackLabel(f).length)) * SANS_CH + 10 : 0;
  const width = Math.max(graphRight, ...surfaces.map((s) => s.x + s.w), ...[...feedbackRails.values()].map((x) => x + labelRoom)) + PAD;
  return {
    nodes: [...laid.values()],
    layers,
    gaps,
    rails,
    surfaces,
    feedbackRails,
    edges,
    width,
    height: maxY + PAD,
    sinks,
    railOf,
    graphLeft,
    graphRight,
  };
};

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The README's palette: blue estimates, amber decides, violet writes, green saves. */
const COLOR: Record<NodeVisual | "feedback" | "edge", { v: string; hex: string }> = {
  edge: { v: "--dp-edge", hex: "#a8a29e" },
  read: { v: "--dp-read", hex: "#0e7490" },
  decide: { v: "--dp-decide", hex: "#2563eb" },
  generate: { v: "--dp-generate", hex: "#7c3aed" },
  code: { v: "--dp-code", hex: "#64748b" },
  gate: { v: "--dp-gate", hex: "#d97706" },
  store: { v: "--dp-store", hex: "#16a34a" },
  feedback: { v: "--dp-feedback", hex: "#e11d48" },
};
const col = (k: keyof typeof COLOR): string => `var(${COLOR[k].v}, ${COLOR[k].hex})`;

type LegendKey = NodeVisual | "survive" | "feedback";
const LEGEND: Array<{ k: LegendKey; text: string }> = [
  { k: "read", text: "read" },
  { k: "decide", text: "decide — a model estimates" },
  { k: "generate", text: "generate — a model writes" },
  { k: "code", text: "code" },
  { k: "gate", text: "gate — code decides" },
  { k: "store", text: "store" },
  { k: "survive", text: "survives its own failure" },
  { k: "feedback", text: "human feedback, back to an earlier node" },
];

const nodeTitle = (n: DiagramNode): string => {
  const parts = [`${n.id} — ${nodeSubtitle(n)}`];
  if (n.describe) parts.push(n.describe);
  if (n.route) parts.push(`route: ${n.route}`);
  if (n.branches) parts.push(`branches: ${n.branches.join(" | ")}`);
  if (n.thresholds && Object.keys(n.thresholds).length > 0) {
    parts.push(
      `thresholds: ${Object.entries(n.thresholds)
        .map(([k, t]) =>
          typeof t === "number"
            ? `${k}=${t}`
            : typeof t === "object" && t && "default" in t
              ? `${k}=${String((t as { default: unknown }).default)}`
              : k,
        )
        .join(", ")}`,
    );
  }
  if (n.onFailure && n.onFailure !== "fail") parts.push(`on failure: ${n.onFailure}`);
  if (n.version) parts.push(`v${n.version}`);
  return parts.join("\n");
};

const feedbackTitle = (f: DiagramFeedback): string => {
  const lane = typeof f.promoteVia === "string" ? f.promoteVia : f.promoteVia?.lane;
  return [
    `${f.id}: ${f.from} → ${f.to}`,
    `${f.source} · ${f.form} · ${f.scope} · ${f.latency}`,
    f.score ? `score: ${f.score.name} (${f.score.dataType})` : "",
    lane ? `review lane: ${lane}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

type Pt = [number, number];

/** An orthogonal polyline with rounded corners. Collinear points are dropped. */
const orthoPath = (pts: Pt[], r = 6): string => {
  const p: Pt[] = [];
  for (const q of pts) {
    const last = p[p.length - 1];
    if (last && Math.abs(last[0] - q[0]) < 0.01 && Math.abs(last[1] - q[1]) < 0.01) continue;
    const prev = p[p.length - 2];
    if (last && prev && ((prev[0] === last[0] && last[0] === q[0]) || (prev[1] === last[1] && last[1] === q[1]))) p.pop();
    p.push(q);
  }
  if (p.length === 0) return "";
  const first = p[0] as Pt;
  let d = `M${first[0]},${first[1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [ax, ay] = p[i - 1] as Pt;
    const [bx, by] = p[i] as Pt;
    const [cx, cy] = p[i + 1] as Pt;
    const rr = Math.min(r, Math.hypot(bx - ax, by - ay) / 2, Math.hypot(cx - bx, cy - by) / 2);
    const inX = Math.sign(bx - ax) * rr;
    const inY = Math.sign(by - ay) * rr;
    const outX = Math.sign(cx - bx) * rr;
    const outY = Math.sign(cy - by) * rr;
    d += ` L${bx - inX},${by - inY} Q${bx},${by} ${bx + outX},${by + outY}`;
  }
  const last = p[p.length - 1] as Pt;
  d += ` L${last[0]},${last[1]}`;
  return d;
};

const hexagon = (x: number, y: number, w: number, h: number): string => {
  const k = Math.min(12, h / 4);
  return `M${x + k},${y} H${x + w - k} L${x + w},${y + h / 2} L${x + w - k},${y + h} H${x + k} L${x},${y + h / 2} Z`;
};

const cylinder = (x: number, y: number, w: number, h: number, c: string, dash: string): string => {
  const ry = 5;
  return (
    `<path d="M${x},${y + ry} A${w / 2},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} A${w / 2},${ry} 0 0 1 ${x},${y + h - ry} Z" fill="${c}" fill-opacity="0.12" stroke="${c}" stroke-width="1.4"${dash}/>` +
    `<path d="M${x},${y + ry} A${w / 2},${ry} 0 0 0 ${x + w},${y + ry}" fill="none" stroke="${c}" stroke-width="1.2"/>`
  );
};

/** A small outline person — the one glyph, for a human surface. */
const person = (cx: number, cy: number): string =>
  `<circle cx="${cx}" cy="${cy - 3.5}" r="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/>` +
  `<path d="M${cx - 5},${cy + 5.5} a5,4.5 0 0 1 10,0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`;

export const renderPipelineSvg = (input: DiagramInput, opts: DiagramOptions = {}): string => {
  const layout = layoutPipeline(input, opts);
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const header = opts.header !== false;
  const legend = opts.legend !== false;
  const width = Math.max(layout.width, 380);
  const subtitleParts = header
    ? (opts.subtitle !== undefined
        ? opts.subtitle.split("   ·   ")
        : [
            input.fact ? `fact: ${input.fact}` : "",
            input.trigger?.length ? `trigger: ${input.trigger.join(", ")}` : "",
            input.result?.length ? `ends in: ${input.result.join(" | ")}` : "",
            input.decidedBy ? `decided by: ${input.decidedBy}` : "",
          ]
      ).filter(Boolean)
    : [];
  const subtitleLines: string[] = [];
  for (const part of subtitleParts) {
    const last = subtitleLines[subtitleLines.length - 1];
    const joined = last === undefined ? part : `${last}   ·   ${part}`;
    if (last !== undefined && joined.length * SANS_CH * 1.05 <= width - 2 * PAD) subtitleLines[subtitleLines.length - 1] = joined;
    else subtitleLines.push(part);
  }
  const headerH = header ? 32 + subtitleLines.length * 14 : 0;

  // legend rows, wrapped to the width
  const legendRows: Array<Array<{ k: LegendKey; text: string; x: number }>> = [];
  if (legend) {
    let row: Array<{ k: LegendKey; text: string; x: number }> = [];
    let x = PAD;
    for (const item of LEGEND) {
      const w = 23 + item.text.length * SANS_CH + 16;
      if (row.length > 0 && x + w > width - PAD) {
        legendRows.push(row);
        row = [];
        x = PAD;
      }
      row.push({ ...item, x });
      x += w;
    }
    if (row.length > 0) legendRows.push(row);
  }
  const legendH = legend ? 14 + legendRows.length * 18 : 0;
  const height = layout.height + headerH + legendH;
  const uid = `dp-${input.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const out: string[] = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="dp-diagram" data-pipeline="${esc(input.id)}" role="img" aria-labelledby="${uid}-title" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"${opts.standalone ? ` style="color:#1c1917;background:#ffffff"` : ""}>`,
  );
  out.push(`<title id="${uid}-title">${esc(opts.title ?? input.id)} — decision pipeline</title>`);
  if (opts.standalone) {
    out.push(
      `<style>svg.dp-diagram{--dp-bg:#ffffff}@media (prefers-color-scheme: dark){svg.dp-diagram{color:#e7e5e4;background:#1c1917;--dp-bg:#1c1917}}</style>`,
    );
  }
  out.push(`<defs>`);
  for (const k of ["flow", "branch", "feedback"] as const) {
    const stroke = k === "flow" ? col("edge") : k === "branch" ? col("gate") : col("feedback");
    out.push(
      `<marker id="${uid}-arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>`,
    );
  }
  out.push(`</defs>`);

  // --- header
  if (header) {
    out.push(`<g class="dp-header">`);
    out.push(`<text x="${PAD}" y="22" font-size="15" font-weight="600" fill="currentColor">${esc(opts.title ?? input.id)}</text>`);
    subtitleLines.forEach((line, i) =>
      out.push(`<text x="${PAD}" y="${38 + i * 14}" font-size="10.5" fill="currentColor" opacity="0.62">${esc(line)}</text>`),
    );
    out.push(`</g>`);
  }

  out.push(`<g transform="translate(0,${headerH})">`);

  // --- flow edges: trunk → lane → (rail →) drop. Shared segments overlap into one line.
  const cx = (n: LaidOutNode) => n.x + n.w / 2;
  const branchInto = new Map<string, Array<{ branch: string; gate: string }>>();
  out.push(`<g class="dp-edges">`);
  layout.edges.forEach((e, i) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return;
    const branch = e.when?.branch;
    if (branch) branchInto.set(e.to, [...(branchInto.get(e.to) ?? []), { branch, gate: e.from }]);
    const railKey = layout.railOf.get(i);
    const laneKey = railKey ?? `src:${e.from}`;
    const pts: Pt[] = [[cx(a), a.y + a.h]];
    const outLane = layout.gaps[a.layer]?.lane.get(laneKey) ?? a.y + a.h + GAP_BASE / 2;
    if (railKey !== undefined) {
      const rail = layout.rails.get(railKey) ?? layout.graphLeft - 16;
      const inLane = layout.gaps[b.layer - 1]?.lane.get(railKey) ?? b.y - GAP_BASE / 2;
      pts.push([cx(a), outLane], [rail, outLane], [rail, inLane], [cx(b), inLane]);
    } else {
      pts.push([cx(a), outLane], [cx(b), outLane]);
    }
    pts.push([cx(b), b.y]);
    const stroke = branch ? col("gate") : col("edge");
    out.push(
      `<path d="${orthoPath(pts)}" fill="none" stroke="${stroke}" stroke-width="${branch ? 1.7 : 1.4}" stroke-linecap="round" marker-end="url(#${uid}-arrow-${branch ? "branch" : "flow"})" class="dp-edge${branch ? " dp-edge-branch" : ""}${railKey !== undefined ? " dp-edge-long" : ""}" data-edge="${esc(e.from)}→${esc(e.to)}"${branch ? ` data-branch="${esc(branch)}"` : ""}><title>${esc(`${e.from} → ${e.to}${branch ? ` when ${e.from} = ${branch}` : ""}`)}</title></path>`,
    );
  });
  out.push(`</g>`);

  // --- feedback: the loop
  const labels: string[] = [];
  if (layout.surfaces.length > 0) {
    out.push(`<g class="dp-feedback">`);
    const row = layout.surfaces[0] as LaidOutSurface;
    // faint dotted: the run's end (its deepest sinks) down to the surface row — the output a person sees
    const firstX = Math.min(...layout.surfaces.map((s) => s.x));
    const lastX = Math.max(...layout.surfaces.map((s) => s.x + s.w));
    const deepest = Math.max(...layout.sinks.map((id) => byId.get(id)?.layer ?? 0));
    for (const sinkId of layout.sinks) {
      const sink = byId.get(sinkId);
      if (!sink || sink.layer !== deepest) continue;
      const x = cx(sink);
      const dropTo = row.y - 10;
      const toward = x < firstX ? firstX : x > lastX ? lastX : x;
      out.push(
        `<path d="${orthoPath([[x, sink.y + sink.h], [x, dropTo], [toward, dropTo], [toward, row.y]])}" fill="none" stroke="${col("edge")}" stroke-width="1" stroke-dasharray="1.5 4" stroke-linecap="round" class="dp-edge-shown"/>`,
      );
    }
    const outermost = Math.max(...layout.feedbackRails.values());
    const all = layout.surfaces.flatMap((s, si) => s.edges.map((f) => ({ s, si, f })));
    const perTarget = new Map<string, number>();
    all.forEach(({ s, si, f }) => {
      const t = byId.get(f.to);
      const rail = layout.feedbackRails.get(f.id);
      if (!t || rail === undefined) return;
      const k = perTarget.get(f.to) ?? 0;
      perTarget.set(f.to, k + 1);
      const ty = t.y + t.h / 2 + k * 9;
      const under = row.y + row.h + 12 + si * 7;
      const d = orthoPath([[s.x + s.w / 2, s.y + s.h], [s.x + s.w / 2, under], [rail, under], [rail, ty], [t.x + t.w, ty]], 8);
      out.push(
        `<path d="${d}" fill="none" stroke="${col("feedback")}" stroke-width="1.5" stroke-dasharray="5 4" stroke-linecap="round" marker-end="url(#${uid}-arrow-feedback)" class="dp-edge dp-edge-feedback" data-feedback="${esc(f.id)}"><title>${esc(feedbackTitle(f))}</title></path>`,
      );
      // the label sits right of every rail, level with its tap — no line crosses it
      const text = feedbackLabel(f);
      const w = text.length * SANS_CH + 10;
      const lx = outermost + 8;
      const ly = ty + k * 9;
      labels.push(
        `<g class="dp-feedback-label" data-feedback="${esc(f.id)}"><rect x="${lx}" y="${ly - 7.5}" width="${w}" height="15" rx="4" fill="${col("feedback")}" fill-opacity="0.1" stroke="${col("feedback")}" stroke-opacity="0.5" stroke-width="0.8"/><text x="${lx + 5}" y="${ly + 3.5}" font-size="9.5" fill="${col("feedback")}">${esc(text)}</text><title>${esc(feedbackTitle(f))}</title></g>`,
      );
    });
    for (const s of layout.surfaces) {
      const chanW = s.channel.length * 6.4 + 6;
      out.push(
        `<g class="dp-surface" data-surface="${esc(s.id)}"><rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="15" fill="${col("feedback")}" fill-opacity="0.1" stroke="${col("feedback")}" stroke-width="1.4"/>${person(s.x + 16, s.y + s.h / 2)}<text x="${s.x + 28}" y="${s.y + s.h / 2 + 3.5}" font-size="8.5" letter-spacing="0.06em" fill="${col("feedback")}">${esc(s.channel.toUpperCase())}</text><text x="${s.x + 32 + chanW}" y="${s.y + s.h / 2 + 4}" font-size="11.5" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" fill="currentColor">${esc(s.name)}</text><title>${esc(`${s.channel}: ${s.name}`)}\n${esc(s.edges.map((f) => feedbackTitle(f)).join("\n\n"))}</title></g>`,
      );
    }
    out.push(`</g>`);
  }

  // --- nodes
  out.push(`<g class="dp-nodes">`);
  for (const n of layout.nodes) {
    const c = col(n.visual);
    const survivable = n.node.onFailure && n.node.onFailure !== "fail";
    const dash = survivable ? ` stroke-dasharray="4 3"` : "";
    const shape =
      n.visual === "gate"
        ? `<path d="${hexagon(n.x, n.y, n.w, n.h)}" fill="${c}" fill-opacity="0.13" stroke="${c}" stroke-width="1.6"${dash}/>`
        : n.visual === "store"
          ? cylinder(n.x, n.y, n.w, n.h, c, dash)
          : `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8" fill="${c}" fill-opacity="0.12" stroke="${c}" stroke-width="1.4"${dash}/>`;
    const bar =
      n.visual === "gate" || n.visual === "store"
        ? ""
        : `<rect x="${n.x + 8}" y="${n.y + 8}" width="${n.w - 16}" height="3" rx="1.5" fill="${c}"/>`;
    const tx = n.x + n.w / 2;
    const baseY = n.visual === "store" ? n.y + 6 : n.y;
    out.push(
      `<g class="dp-node dp-${n.visual}" data-node="${esc(n.id)}" data-kind="${esc(String(n.node.kind))}"${n.node.role ? ` data-role="${esc(String(n.node.role))}"` : ""}>` +
        `<title>${esc(nodeTitle(n.node))}</title>` +
        shape +
        bar +
        `<text x="${tx}" y="${baseY + 27}" font-size="12" font-weight="600" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" fill="currentColor">${esc(n.label)}</text>` +
        `<text x="${tx}" y="${baseY + 40}" font-size="9.5" text-anchor="middle" fill="${c}" letter-spacing="0.02em">${esc(n.kindLabel)}</text>` +
        (n.name ? `<text x="${tx}" y="${baseY + 52}" font-size="9.5" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" fill="currentColor" opacity="0.7">${esc(n.name)}</text>` : "") +
        `</g>`,
    );
    // the branch that reaches this node, on its doorstep
    const reached = branchInto.get(n.id) ?? [];
    reached.forEach((r, i) => {
      const text = cut(r.branch, 16);
      const w = text.length * SANS_CH + 12;
      const px = tx + (i - (reached.length - 1) / 2) * (w + 4);
      labels.push(
        `<g class="dp-branch" data-branch="${esc(r.branch)}" data-gate="${esc(r.gate)}"><rect x="${px - w / 2}" y="${n.y - 19}" width="${w}" height="16" rx="8" fill="${col("gate")}"/><text x="${px}" y="${n.y - 7.5}" font-size="10" font-weight="600" text-anchor="middle" fill="#ffffff">${esc(text)}</text><title>${esc(`${r.gate} = ${r.branch}`)}</title></g>`,
      );
    });
  }
  out.push(`</g>`);
  if (labels.length > 0) out.push(`<g class="dp-labels">${labels.join("")}</g>`);
  out.push(`</g>`);

  // --- legend
  if (legend) {
    out.push(`<g class="dp-legend" font-size="9.5">`);
    legendRows.forEach((row, r) => {
      const y = height - legendH + 14 + r * 18;
      for (const item of row) {
        const x = item.x;
        if (item.k === "survive") {
          out.push(`<rect x="${x}" y="${y - 6}" width="18" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.7"/>`);
        } else if (item.k === "feedback") {
          out.push(`<path d="M${x},${y} h18" stroke="${col("feedback")}" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#${uid}-arrow-feedback)"/>`);
        } else if (item.k === "gate") {
          out.push(`<path d="${hexagon(x, y - 6, 18, 12)}" fill="${col("gate")}" fill-opacity="0.13" stroke="${col("gate")}" stroke-width="1.2"/>`);
        } else {
          const c = col(item.k);
          out.push(`<rect x="${x}" y="${y - 6}" width="18" height="12" rx="${item.k === "store" ? 6 : 3}" fill="${c}" fill-opacity="0.12" stroke="${c}" stroke-width="1.2"/>`);
        }
        out.push(`<text x="${x + 23}" y="${y + 3.5}" fill="currentColor" opacity="0.8">${esc(item.text)}</text>`);
      }
    });
    out.push(`</g>`);
  }

  out.push(`</svg>`);
  return out.join("\n");
};
