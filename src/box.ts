/**
 * Box — where something is in an image (Jev 1.14, `type: "box"`).
 *
 * A Box answer is four edges as fractions of the image (`left`/`right` of the
 * width, `top`/`bottom` of the height, origin top-left) plus a confidence. It
 * is an ESTIMATE like any decide answer: the decide port returns it under
 * `boxes`, the runtime checks it, records it on the node, mirrors its
 * confidence into `distributions` as `[confidence]` (option `"confidence"`) so
 * a gate thresholds it exactly like a Noul, and adds flat geometry features.
 * What to DO with a box (crop, pad, ask again on a tile) stays in code.
 *
 * Two facts from the API shape every pipeline that asks one:
 *  - There is no "not found". A Box about something absent still returns four
 *    edges, so pair it with a Noul ("is there a mug in `photo`?") in the same
 *    request and let a gate ignore the box when the Noul is low.
 *  - One box per question. Several targets are several Box questions.
 */

import type { Box, BoxAnswer } from "./types";

/** A Box question as Jev takes it. `instructions` names the target and the image path. */
export interface BoxQuestion {
  type: "box";
  instructions: string;
}

/** The option key a Box's mirrored distribution carries. */
export const BOX_CONFIDENCE_OPTION = "confidence";

const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Null when the answer is a usable box, else why not. */
export const checkBoxAnswer = (a: unknown): string | null => {
  if (!a || typeof a !== "object") return "not an object";
  const { box, confidence } = a as Partial<BoxAnswer>;
  if (!unit(confidence)) return `confidence ${String(confidence)} is not in 0..1`;
  if (!box || typeof box !== "object") return "no box";
  for (const edge of ["top", "bottom", "left", "right"] as const) {
    if (!unit(box[edge])) return `${edge} ${String(box[edge])} is not in 0..1`;
  }
  if (!(box.left < box.right)) return `left ${box.left} is not less than right ${box.right}`;
  if (!(box.top < box.bottom)) return `top ${box.top} is not less than bottom ${box.bottom}`;
  return null;
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export const boxWidth = (b: Box): number => b.right - b.left;
export const boxHeight = (b: Box): number => b.bottom - b.top;
/** Fraction of the image the box covers. */
export const boxArea = (b: Box): number => boxWidth(b) * boxHeight(b);
export const boxCenter = (b: Box): { x: number; y: number } => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });

/**
 * Move every edge outward by `pad` (a fraction of the image), kept inside it.
 * The docs' answer to a low-confidence box you must not cut off when cropping.
 */
export const padBox = (b: Box, pad: number): Box => ({
  left: clamp01(b.left - pad),
  top: clamp01(b.top - pad),
  right: clamp01(b.right + pad),
  bottom: clamp01(b.bottom + pad),
});

/**
 * Pixel rectangle for an image of `width` x `height`, rounded — the
 * `(left, top, right, bottom)` order PIL's `crop` and most canvas APIs take.
 */
export const boxToPixels = (
  b: Box,
  width: number,
  height: number,
): { left: number; top: number; right: number; bottom: number } => ({
  left: Math.round(b.left * width),
  top: Math.round(b.top * height),
  right: Math.round(b.right * width),
  bottom: Math.round(b.bottom * height),
});

/** Intersection over union, 0..1. The score a corrected box earns against the pipeline's. */
export const boxIoU = (a: Box, b: Box): number => {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
};

/**
 * Split the image into a `rows` x `cols` grid, named `r<row>c<col>`. Find a
 * small target in a large image by asking a Choice over the tiles first, then
 * a Box on the chosen tile's crop, then `boxFromTile` back to the full image.
 */
export const tileBoxes = (rows: number, cols: number): Record<string, Box> => {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
    throw new Error(`tileBoxes: rows and cols must be positive integers, got ${rows} x ${cols}`);
  }
  const out: Record<string, Box> = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out[`r${r}c${c}`] = { top: r / rows, bottom: (r + 1) / rows, left: c / cols, right: (c + 1) / cols };
    }
  }
  return out;
};

/** A box answered on a crop (`tile`, in full-image fractions) mapped back to the full image. */
export const boxFromTile = (tile: Box, inner: Box): Box => ({
  left: tile.left + inner.left * boxWidth(tile),
  right: tile.left + inner.right * boxWidth(tile),
  top: tile.top + inner.top * boxHeight(tile),
  bottom: tile.top + inner.bottom * boxHeight(tile),
});

export type BoxEdge = "top" | "bottom" | "left" | "right";
export const BOX_EDGES: readonly BoxEdge[] = ["top", "bottom", "left", "right"];

/**
 * One Noul per edge — "does the target in `crop` continue past the left edge
 * of the image?" — the check that caught 30 of 36 cut-off crops in TypeSafe's
 * test, against 26 for one "is all of it inside?" question. Keys are
 * `<prefix>_<edge>`; ask them on the CROP, not the full image.
 */
export const edgeCheckQuestions = (
  target: string,
  cropPath: string,
  prefix = "past",
): Record<string, { type: "noul"; instructions: string }> =>
  Object.fromEntries(
    BOX_EDGES.map((edge) => [
      `${prefix}_${edge}`,
      { type: "noul" as const, instructions: `Does ${target} in \`${cropPath}\` continue past the ${edge} edge of the image?` },
    ]),
  );

/**
 * Move out each edge whose edge-check Noul is at or above `threshold`, by
 * `step` (a fraction of the image), kept inside it. A code decision on model
 * estimates: the threshold is data, so declare it on the node that calls this.
 * Returns the new box and which edges moved; none moved means the box holds.
 */
export const expandBoxEdges = (
  b: Box,
  pastEdge: Partial<Record<BoxEdge, number>>,
  threshold: number,
  step: number,
): { box: Box; moved: BoxEdge[] } => {
  const box = { ...b };
  const moved: BoxEdge[] = [];
  for (const edge of BOX_EDGES) {
    const p = pastEdge[edge];
    if (typeof p !== "number" || p < threshold) continue;
    const before = box[edge];
    box[edge] = clamp01(edge === "top" || edge === "left" ? before - step : before + step);
    if (box[edge] !== before) moved.push(edge);
  }
  return { box, moved };
};

/**
 * `<nodeId>.<question>.box_area`, `.box_cx`, `.box_cy` for every box a decide
 * node answered. Confidence needs no column of its own: it is mirrored into
 * `distributions`, so `.top` already carries it.
 */
export const boxFeatures = (
  inputs: readonly { nodeId: string; boxes: Record<string, BoxAnswer> }[],
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const { nodeId, boxes } of inputs) {
    for (const [question, { box }] of Object.entries(boxes)) {
      const { x, y } = boxCenter(box);
      out[`${nodeId}.${question}.box_area`] = boxArea(box);
      out[`${nodeId}.${question}.box_cx`] = x;
      out[`${nodeId}.${question}.box_cy`] = y;
    }
  }
  return out;
};
