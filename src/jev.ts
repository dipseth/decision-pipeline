/**
 * Jev wire helpers — pure, no fetch. The decide port stays the host's; these
 * are the parts every Jev-backed port was writing by hand.
 *
 * TypeSafe's "danger zone" features (Oct 2026) are opt-in per request through
 * headers, and are dreamer-ready rather than production-ready: format and
 * accuracy may change between releases.
 *  - Images work on every Jev, `jev-1.13.0` included, behind
 *    `TypeSafe-Danger-Zone-Images: true`. An image is an asset whose id can
 *    appear anywhere the JSON does: state, instructions, even criteria.
 *  - The `box` question type needs `jev-1.14.0` (or `jev-preview`), and the
 *    same images header.
 *  - Longer context than production allows, behind
 *    `TypeSafe-Danger-Zone-Long-Context: true`. TypeSafe still recommends
 *    keeping state short; so does this package (send only what is asked about).
 * `jev-latest` moves to 1.14.0 a week after release: pin the exact version
 * once a threshold is tuned.
 */

import { BOX_CONFIDENCE_OPTION, type BoxQuestion } from "./box";
import type { DecideResult } from "./ports";
import type { BoxAnswer, ProbeQuestion } from "./types";

/** The default this package documents and tests against. */
export const JEV_MODEL = "jev-1.14.0";
/** Moves with TypeSafe's releases; never tune a threshold on it. */
export const JEV_PREVIEW_MODEL = "jev-preview";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Required on any request with an image asset or a Box question. */
export const JEV_IMAGES_HEADER = "TypeSafe-Danger-Zone-Images";
/** Opt-in to context beyond the production limit. Less reliable; prefer a smaller state. */
export const JEV_LONG_CONTEXT_HEADER = "TypeSafe-Danger-Zone-Long-Context";

/** Every question shape a decide node can send: the probe shapes plus Box. */
export type JevQuestion = Omit<ProbeQuestion, "why"> | BoxQuestion;

/** An asset the state references by id. `part` names a multipart file part. */
export interface JevAsset {
  type: "image" | (string & {});
  part?: string;
  [key: string]: unknown;
}

export interface JevRequestBody {
  model: string;
  state: unknown;
  questions: Record<string, JevQuestion>;
  assets?: Record<string, JevAsset>;
}

/** One answer as Jev returns it; which fields are set depends on `type`. */
export interface JevAnswer {
  type?: string;
  noul?: number;
  score?: number;
  probabilities?: Record<string, number>;
  box?: BoxAnswer["box"];
  confidence?: number;
}

export interface JevUsage {
  input_tokens?: number;
  output_tokens?: number;
}

const VERSION = /^jev-(\d+)\.(\d+)\.(\d+)$/;

/**
 * Whether `model` answers Box questions: `jev-preview`, or a pinned version
 * from 1.14.0. An alias this package cannot read (`jev-latest`) is given the
 * benefit of the doubt. Images alone need no particular version.
 */
export const jevSupportsBox = (model: string): boolean => {
  if (model === JEV_PREVIEW_MODEL) return true;
  const m = VERSION.exec(model);
  if (!m) return true;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 1 || (major === 1 && minor >= 14);
};

/** True when the request needs the images header: an image asset or a Box question. */
export const jevNeedsImages = (body: Pick<JevRequestBody, "questions" | "assets">): boolean =>
  Object.values(body.questions).some((q) => q.type === "box") ||
  Object.values(body.assets ?? {}).some((a) => a.type === "image");

/**
 * Every problem with a request before it is sent, all at once — the same
 * stance as the contract check. Empty means send it.
 */
export const checkJevRequest = (body: JevRequestBody): string[] => {
  const problems: string[] = [];
  const boxes = Object.entries(body.questions).filter(([, q]) => q.type === "box");
  for (const [key, q] of boxes) {
    if ("criteria" in q) problems.push(`question "${key}": a box takes no criteria`);
    if (!q.instructions.trim()) problems.push(`question "${key}": a box needs instructions naming the target and the image`);
  }
  if (boxes.length > 0 && !jevSupportsBox(body.model)) {
    problems.push(`model "${body.model}" does not answer box questions; send "${JEV_MODEL}" or "${JEV_PREVIEW_MODEL}"`);
  }
  return problems;
};

/**
 * Auth, the images header when the request needs it, and the long-context
 * header only when asked for. Content type is the caller's (JSON or multipart).
 */
export const jevHeaders = (
  apiKey: string,
  body: Pick<JevRequestBody, "questions" | "assets">,
  opts: { longContext?: boolean } = {},
): Record<string, string> => ({
  authorization: `Bearer ${apiKey}`,
  ...(jevNeedsImages(body) ? { [JEV_IMAGES_HEADER]: "true" } : {}),
  ...(opts.longContext ? { [JEV_LONG_CONTEXT_HEADER]: "true" } : {}),
});

/**
 * Jev answers -> the decide port's result. Noul -> `[p]` / `["true"]`;
 * Choice and Score -> one probability per option; Box -> `boxes[key]` (the
 * runtime checks it and mirrors its confidence into `distributions`). An
 * answer with none of these is left out, and the runtime records the slot as
 * unanswered if it was a probe.
 */
export const jevAnswersToDecideResult = (
  answers: Record<string, JevAnswer>,
  opts: { usage?: JevUsage; costUsd?: (usage: JevUsage) => number } = {},
): DecideResult => {
  const distributions: Record<string, number[]> = {};
  const distributionOptions: Record<string, string[]> = {};
  const boxes: Record<string, BoxAnswer> = {};
  for (const [key, a] of Object.entries(answers)) {
    if (a.type === "box" || a.box) {
      boxes[key] = { box: a.box as BoxAnswer["box"], confidence: a.confidence as number };
      distributions[key] = [a.confidence as number];
      distributionOptions[key] = [BOX_CONFIDENCE_OPTION];
    } else if (typeof a.noul === "number") {
      distributions[key] = [a.noul];
      distributionOptions[key] = ["true"];
    } else if (a.probabilities) {
      distributionOptions[key] = Object.keys(a.probabilities);
      distributions[key] = Object.values(a.probabilities);
    }
  }
  return {
    distributions,
    distributionOptions,
    ...(Object.keys(boxes).length > 0 ? { boxes } : {}),
    ...(opts.usage && opts.costUsd ? { costUsd: opts.costUsd(opts.usage) } : {}),
  };
};
