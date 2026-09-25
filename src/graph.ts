/**
 * The DAG: topological order, and the skip rule.
 *
 * A node whose EVERY inbound guard is false is skipped, and the trace shows it
 * skipped WITH THE REASON — never missing. That is the difference between a
 * trace you can read six weeks later and one you cannot.
 */

import type { Edge } from "./types";

export interface TopoResult {
  order: string[];
  /** Node ids that take part in a cycle. Empty when the graph is a DAG. */
  cycle: string[];
}

/**
 * Kahn's algorithm, tie-broken by DECLARATION order so a run's node order is
 * stable across processes — the run record is compared across runs.
 */
export const topologicalOrder = (
  nodeIds: readonly string[],
  edges: readonly Edge[],
): TopoResult => {
  const indegree = new Map<string, number>();
  const out = new Map<string, string[]>();
  const rank = new Map<string, number>();

  nodeIds.forEach((id, i) => {
    indegree.set(id, 0);
    out.set(id, []);
    rank.set(id, i);
  });

  for (const edge of edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    out.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const ready = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];

  while (ready.length > 0) {
    ready.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    const id = ready.shift();
    if (id === undefined) break;
    order.push(id);
    for (const next of out.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  const cycle = nodeIds.filter((id) => !order.includes(id));
  return { order, cycle };
};

export const inboundEdges = (
  edges: readonly Edge[],
  nodeId: string,
): Edge[] => edges.filter((e) => e.to === nodeId);

export const outboundEdges = (
  edges: readonly Edge[],
  nodeId: string,
): Edge[] => edges.filter((e) => e.from === nodeId);

/** The branch a gate took, or undefined when the gate has not run (or was skipped). */
export type BranchLookup = (gateId: string) => string | undefined;

export interface InboundDecision {
  /** Edges whose source ran AND whose guard (if any) matched. */
  open: Edge[];
  /** Why the node is being skipped, when `open` is empty. Null when it runs. */
  skipReason: string | null;
}

/**
 * A root node (no inbound edges) always runs. Otherwise at least one inbound
 * edge has to be open: its source produced an output, and either it carries no
 * guard or the named gate took the named branch.
 */
export const resolveInbound = (
  edges: readonly Edge[],
  nodeId: string,
  ran: ReadonlySet<string>,
  branchOf: BranchLookup,
): InboundDecision => {
  const inbound = inboundEdges(edges, nodeId);
  if (inbound.length === 0) return { open: [], skipReason: null };

  const open: Edge[] = [];
  const closedBecause: string[] = [];

  for (const edge of inbound) {
    if (!ran.has(edge.from)) {
      closedBecause.push(`${edge.from} skipped`);
      continue;
    }
    if (!edge.when) {
      open.push(edge);
      continue;
    }
    const taken = branchOf(edge.when.gate);
    if (taken === edge.when.branch) {
      open.push(edge);
    } else {
      closedBecause.push(
        `${edge.when.gate} took ${taken === undefined ? "no branch" : `"${taken}"`}, needed "${edge.when.branch}"`,
      );
    }
  }

  if (open.length > 0) return { open, skipReason: null };
  return { open, skipReason: closedBecause.join("; ") || "no open inbound edge" };
};

/** Nodes with no outbound flow edges — the graph's sinks. */
export const sinkNodes = (
  nodeIds: readonly string[],
  edges: readonly Edge[],
): string[] => {
  const hasOut = new Set(edges.map((e) => e.from));
  return nodeIds.filter((id) => !hasOut.has(id));
};
