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
 *
 * Bodies and answers may be plain API JSON or the official `@typesafe-ai/sdk`
 * objects (`image()`, `withAssets`, `systemOne` results): every helper reads
 * both, by shape, and the package never imports the SDK. With the SDK, the
 * port is `client.systemOne(...)` plus `jevExtraHeaders` (the SDK does not
 * send the danger-zone headers itself) and `jevResponseToDecideResult`.
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

/**
 * A System One request. `model` is optional because the SDK fills its own
 * default (`jev-latest`); questions and assets may be SDK objects.
 */
export interface JevRequestBody {
  model?: string;
  state?: unknown;
  questions: Record<string, JevQuestion | JevAnyQuestion>;
  assets?: Record<string, JevAsset | object>;
}

/** Any question by its `type`, as the SDK's builders make them (instructions may be an image, a list, an object). */
export interface JevAnyQuestion {
  type: string;
  instructions?: unknown;
  criteria?: unknown;
}

/** One answer as Jev returns it; which fields are set depends on `type`. */
export interface JevAnswer {
  type?: string;
  noul?: number;
  score?: number;
  probabilities?: Record<string, number>;
  box?: BoxAnswer["box"];
  /** `null` when the API reports none (a Box on `jev-preview`). */
  confidence?: number | null;
}

/** Counts the API left out arrive as `null` from the SDK; the helpers drop them. */
export interface JevUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
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

/** An SDK `Image` (`image()`): `type: "image"`, its bytes in `data`, and a `toJSON` that writes its reference. */
const isSdkImage = (v: unknown): boolean =>
  typeof v === "object" && v !== null && (v as { type?: unknown }).type === "image" && "data" in v && typeof (v as { toJSON?: unknown }).toJSON === "function";

/** An SDK `withAssets` text: `text`, the images it names in `assets`, and a `toJSON`. */
const isSdkText = (v: unknown): v is { assets: unknown[] } =>
  typeof v === "object" && v !== null && Array.isArray((v as { assets?: unknown }).assets) &&
  typeof (v as { text?: unknown }).text === "string" && typeof (v as { toJSON?: unknown }).toJSON === "function";

/** Whether an SDK image is anywhere in `value`: placed directly, inside `withAssets` text, or nested in objects and arrays. */
const jevContainsImage = (value: unknown, seen: Set<object> = new Set()): boolean => {
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  if (isSdkImage(value)) return true;
  if (isSdkText(value)) return value.assets.some((a) => jevContainsImage(a, seen));
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  const items = Array.isArray(value) ? value : Object.values(value);
  return items.some((v) => jevContainsImage(v, seen));
};

/**
 * True when the request needs the images header: an image asset or a Box
 * question. An SDK image anywhere in `state` or a question counts as an
 * image asset, and so does one passed in `assets`.
 */
export const jevNeedsImages = (body: Pick<JevRequestBody, "questions" | "assets" | "state">): boolean =>
  Object.values(body.questions).some((q) => q.type === "box") ||
  Object.values(body.assets ?? {}).some((a) => (a as { type?: unknown }).type === "image") ||
  jevContainsImage(body.state) ||
  jevContainsImage(Object.values(body.questions));

/**
 * Every problem with a request before it is sent, all at once — the same
 * stance as the contract check. Empty means send it.
 */
export const checkJevRequest = (body: JevRequestBody): string[] => {
  const problems: string[] = [];
  const boxes = Object.entries(body.questions).filter(([, q]) => q.type === "box");
  for (const [key, q] of boxes) {
    if ("criteria" in q) problems.push(`question "${key}": a box takes no criteria`);
    // Instructions may be an image, a list or an object (SDK content): only a missing or blank one is flagged.
    const instructions: unknown = q.instructions;
    if (instructions == null || (typeof instructions === "string" && !instructions.trim())) {
      problems.push(`question "${key}": a box needs instructions naming the target and the image`);
    }
  }
  if (boxes.length > 0 && body.model !== undefined && !jevSupportsBox(body.model)) {
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
  body: Pick<JevRequestBody, "questions" | "assets" | "state">,
  opts: { longContext?: boolean } = {},
): Record<string, string> => ({
  authorization: `Bearer ${apiKey}`,
  ...jevExtraHeaders(body, opts),
});

/**
 * The danger-zone headers alone, for the SDK's per-call `headers` option (the
 * client sends auth). Images header for a Box, an SDK image in `state`, a
 * question or `assets`, or `images: true`.
 *
 *   await client.systemOne({ state, questions, model: JEV_MODEL }, { headers: jevExtraHeaders({ state, questions }) });
 */
export const jevExtraHeaders = (
  body: Pick<JevRequestBody, "questions" | "assets" | "state">,
  opts: { images?: boolean; longContext?: boolean } = {},
): Record<string, string> => ({
  ...(opts.images || jevNeedsImages(body) ? { [JEV_IMAGES_HEADER]: "true" } : {}),
  ...(opts.longContext ? { [JEV_LONG_CONTEXT_HEADER]: "true" } : {}),
});

/**
 * Jev answers -> the decide port's result. Noul -> `[p]` / `["true"]`;
 * Choice and Score -> one probability per option; Box -> `boxes[key]` (the
 * runtime checks it and mirrors its confidence into `distributions`). An
 * answer with none of these is left out, and the runtime records the slot as
 * unanswered if it was a probe. Usage counts that are `null` are dropped
 * before `costUsd` sees them. A Box with `confidence: null` (the SDK allows
 * it) is passed through, and the runtime fails the node on purpose: a gate
 * needs a number, so `onFailure` decides.
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
    ...(opts.usage && opts.costUsd ? { costUsd: opts.costUsd(dropNulls(opts.usage)) } : {}),
  };
};

const dropNulls = (usage: JevUsage): JevUsage =>
  Object.fromEntries(Object.entries(usage).filter(([, v]) => v != null)) as JevUsage;

/**
 * An SDK `systemOne` result (or the raw response JSON) -> the decide port's
 * result. Answer kinds the SDK does not model are not seen.
 */
export const jevResponseToDecideResult = (
  response: { answers: Record<string, JevAnswer>; usage?: JevUsage | null },
  opts: { costUsd?: (usage: JevUsage) => number } = {},
): DecideResult => jevAnswersToDecideResult(response.answers, { ...(response.usage ? { usage: response.usage } : {}), ...opts });
