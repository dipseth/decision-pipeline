/**
 * Applying a `ManifestPatch` — how an arm, or an offline replay, becomes a
 * runnable manifest.
 *
 * Only the declarative half moves. There is no way to patch a `run:` body,
 * and that is the point: a variant that needs new code is a new NODE VERSION,
 * not a variant.
 */

import type { ManifestPatch } from "./experiments";
import { hasThresholds, type Edge, type PipelineNode, type Threshold } from "./types";

export interface PatchedManifest<I> {
  nodes: Record<string, PipelineNode<I>>;
  edges: Edge[];
  /** Human-readable arm diff — the same list the run record and a review see. */
  applied: string[];
}

export const applyManifestPatch = <I>(
  nodes: Readonly<Record<string, PipelineNode<I>>>,
  edges: readonly Edge[],
  patch: ManifestPatch | undefined,
): PatchedManifest<I> => {
  const applied: string[] = [];
  if (!patch || Object.keys(patch).length === 0) {
    return { nodes: { ...nodes }, edges: edges.map((e) => ({ ...e })), applied };
  }

  const next: Record<string, PipelineNode<I>> = { ...nodes };
  const clone = (id: string): PipelineNode<I> | undefined => {
    const n = next[id];
    if (!n) return undefined;
    const copy = { ...n } as PipelineNode<I>;
    next[id] = copy;
    return copy;
  };

  for (const [nodeId, values] of Object.entries(patch.thresholds ?? {})) {
    const n = clone(nodeId);
    if (!n || !hasThresholds(n)) continue;
    const merged: Record<string, Threshold> = { ...n.thresholds };
    for (const [name, value] of Object.entries(values)) {
      merged[name] = value;
      applied.push(`${nodeId}.thresholds.${name}=${value}`);
    }
    n.thresholds = merged;
  }

  for (const [nodeId, prompt] of Object.entries(patch.prompts ?? {})) {
    const n = clone(nodeId);
    if (!n || n.kind !== "generate") continue;
    n.prompt = prompt;
    applied.push(`${nodeId}.prompt=${prompt}`);
  }

  for (const [nodeId, route] of Object.entries(patch.routes ?? {})) {
    const n = clone(nodeId);
    if (!n || n.kind !== "generate") continue;
    n.route = route;
    applied.push(`${nodeId}.route=${route}`);
  }

  for (const [nodeId, tools] of Object.entries(patch.tools ?? {})) {
    const n = clone(nodeId);
    if (!n || n.kind !== "generate") continue;
    n.tools = tools;
    applied.push(`${nodeId}.tools`);
  }

  for (const [nodeId, questions] of Object.entries(patch.questions ?? {})) {
    const n = clone(nodeId);
    if (!n || n.kind !== "decide") continue;
    n.questions = questions;
    applied.push(`${nodeId}.questions=${questions}`);
  }

  const nextEdges = edges.map((e) => ({ ...e }));
  for (const guard of patch.guards ?? []) {
    const edge = nextEdges.find((e) => e.from === guard.from && e.to === guard.to);
    if (!edge) continue;
    if (guard.when === null) {
      delete edge.when;
      applied.push(`${guard.from}->${guard.to}.when=none`);
    } else {
      edge.when = { ...guard.when };
      applied.push(`${guard.from}->${guard.to}.when=${guard.when.gate}:${guard.when.branch}`);
    }
  }

  return { nodes: next, edges: nextEdges, applied };
};
