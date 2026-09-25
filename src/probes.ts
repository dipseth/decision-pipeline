/**
 * Probes — Jev questions an LLM writes for THIS run.
 *
 * A decide node's `questions` are structure: fixed in code, worded in
 * Langfuse (#318), the same every run. That is right for the questions a gate
 * thresholds on, and wrong for scrutiny — the question worth asking about a
 * Sichuan-Peruvian fusion recipe is not one anybody wrote down in advance.
 * A probe is a question an upstream `generate` node writes after looking at
 * the state, asked in the SAME Jev request as the static questions.
 *
 * What makes that safe to put in a pipeline, and not just a prompt trick:
 *
 *   validated   every probe is parsed against `probeQuestionSchema`, capped,
 *               de-duplicated, length-bounded and (with `paths`) required to
 *               point at a real part of the state. A bad probe is DROPPED
 *               with a reason on the record — it never reaches Jev.
 *   recorded    the probe TEXT lands on the run record beside its answer. A
 *               static question's text is recoverable from its prompt version;
 *               a probe's is not, so without this a replay cannot re-ask it.
 *   evidence    probe answers are never read by a gate. The runtime withholds
 *               them from gate bodies (`args.probes` is empty there) and from
 *               `interpret`, so a threshold can only ever be tuned against
 *               questions that exist on every run. They reach `generate` and
 *               non-gate `code` nodes, as evidence.
 *   bounded     features are aggregates (`<node>.probes.min_margin`, …), not
 *               one column per question — probe keys are slots (`probe_0`…),
 *               and slot 0 on one run means nothing on the next.
 *
 * The loop back — probes whose answers track human labels becoming static
 * questions — is a `derived` feedback edge through a review lane, like any
 * other change to a pipeline's questions.
 */

import { z } from "zod";
import { normalizedEntropy, topMargin } from "./features";
import type { ProbeAnswer, ProbeQuestion, ProbeSpec } from "./types";

export type { ProbeAnswer, ProbeQuestion, ProbeSpec } from "./types";

/** Hard ceiling on probes per decide node, whatever a manifest asks for. */
export const MAX_PROBES = 8;
/** Default ceiling on a probe's text (instructions + criteria), in characters. */
export const DEFAULT_PROBE_MAX_CHARS = 800;
/** A Choice probe's option ceiling: a wide Choice is a classifier, not a probe. */
export const MAX_PROBE_OPTIONS = 12;

export const PROBE_KEY_PREFIX = "probe_";
export const probeKey = (slot: number): string => `${PROBE_KEY_PREFIX}${slot}`;
export const isProbeKey = (key: string): boolean => key.startsWith(PROBE_KEY_PREFIX);

const text = z.string().trim().min(1);

export const probeQuestionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: text,
    criteria: z.object({ true: text, false: text }).optional(),
    /** Why the writer asked — for the hand read, never sent to Jev. */
    why: z.string().optional(),
  }),
  z.object({
    type: z.literal("choice"),
    instructions: text,
    criteria: z
      .record(z.string().regex(/^[a-z0-9_]+$/, "option keys are snake_case"), text)
      .refine((c) => Object.keys(c).length >= 2, "a choice needs at least two options")
      .refine((c) => Object.keys(c).length <= MAX_PROBE_OPTIONS, `a choice allows at most ${MAX_PROBE_OPTIONS} options`),
    why: z.string().optional(),
  }),
  z.object({
    type: z.literal("score"),
    instructions: text,
    criteria: z.array(text).min(2, "a score needs at least two levels").max(MAX_PROBE_OPTIONS),
    why: z.string().optional(),
  }),
]);

// The schema and the hand-written type in ./types must agree, both ways.
type Parsed = z.infer<typeof probeQuestionSchema>;
const _schemaMatchesType: [Parsed extends ProbeQuestion ? true : never, ProbeQuestion extends Parsed ? true : never] = [true, true];
void _schemaMatchesType;

export interface ProbeDrop {
  /** Position in the generator's output; -1 when the output itself was unusable. */
  index: number;
  reason: string;
}

export interface ProbeSet {
  /** Slot key -> the probe, in the order the generator wrote them. */
  asked: Record<string, ProbeQuestion>;
  dropped: ProbeDrop[];
}

/** How a run record keeps a decide node's probes. */
export interface ProbeRecord {
  from: string;
  asked: Record<string, ProbeQuestion>;
  dropped: ProbeDrop[];
  /** Asked, but the port returned no distribution for it. */
  unanswered: string[];
}

const probeChars = (q: ProbeQuestion): number => {
  const criteria = q.criteria === undefined ? [] : Array.isArray(q.criteria) ? q.criteria : Object.values(q.criteria);
  return q.instructions.length + criteria.reduce((n, c) => n + c.length, 0);
};

/** Backticked spans in a string. */
const backticked = (s: string): string[] => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());

const addressesPath = (instructions: string, paths: readonly string[]): boolean =>
  backticked(instructions).some((ref) =>
    paths.some((p) => ref === p || ref.startsWith(`${p}.`) || ref.startsWith(`${p}[`)),
  );

const normalizeForDedupe = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The generator's output as a list: a bare array, or `{ probes }` / `{ questions }`. */
const rawList = (raw: unknown): unknown[] | null => {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.probes)) return o.probes;
    if (Array.isArray(o.questions)) return o.questions;
  }
  return null;
};

/**
 * The generator's output → the probes that may be asked. Never throws: a
 * generator that wrote garbage produces an empty set and a drop per item, so
 * the run record says exactly what the model tried to ask and why it didn't.
 */
export const collectProbes = (raw: unknown, spec: ProbeSpec): ProbeSet => {
  const asked: Record<string, ProbeQuestion> = {};
  const dropped: ProbeDrop[] = [];
  const list = rawList(raw);
  if (list === null) {
    dropped.push({ index: -1, reason: "generator output is not a list of probes" });
    return { asked, dropped };
  }
  const max = Math.min(spec.max, MAX_PROBES);
  const maxChars = spec.maxChars ?? DEFAULT_PROBE_MAX_CHARS;
  const seen = new Set<string>();
  let slot = 0;

  list.forEach((item, index) => {
    const parsed = probeQuestionSchema.safeParse(item);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      dropped.push({ index, reason: `invalid: ${first ? `${first.path.join(".") || "(root)"} ${first.message}` : "unparseable"}` });
      return;
    }
    const q = parsed.data;
    const chars = probeChars(q);
    if (chars > maxChars) {
      dropped.push({ index, reason: `too long: ${chars} > ${maxChars} chars` });
      return;
    }
    if (spec.paths?.length && !addressesPath(q.instructions, spec.paths)) {
      dropped.push({ index, reason: `addresses no state path (want one of: ${spec.paths.join(", ")})` });
      return;
    }
    const norm = normalizeForDedupe(q.instructions);
    if (seen.has(norm)) {
      dropped.push({ index, reason: "duplicate" });
      return;
    }
    if (slot >= max) {
      dropped.push({ index, reason: `over max (${max})` });
      return;
    }
    seen.add(norm);
    asked[probeKey(slot)] = q;
    slot += 1;
  });

  return { asked, dropped };
};

/** The option keys behind a probe's distribution when the port did not say. */
export const defaultProbeOptions = (q: ProbeQuestion): string[] => {
  switch (q.type) {
    case "noul":
      return ["true"];
    case "choice":
      return Object.keys(q.criteria);
    case "score":
      return q.criteria.map((_, i) => String(i));
  }
};

/** Pair each asked probe with its answer. Unanswered ones are listed, not invented. */
export const probeAnswers = (
  asked: Record<string, ProbeQuestion>,
  distributions: Record<string, number[]>,
  options: Record<string, string[]> | undefined,
): { answers: ProbeAnswer[]; unanswered: string[] } => {
  const answers: ProbeAnswer[] = [];
  const unanswered: string[] = [];
  for (const [key, question] of Object.entries(asked)) {
    const distribution = distributions[key];
    if (!distribution || distribution.length === 0) {
      unanswered.push(key);
      continue;
    }
    answers.push({ key, question, distribution, options: options?.[key] ?? defaultProbeOptions(question) });
  }
  return { answers, unanswered };
};

/** Split a decide result's distributions into the static questions and the probes. */
export const splitProbeDistributions = (
  distributions: Record<string, number[]>,
): { fixed: Record<string, number[]>; probes: Record<string, number[]> } => {
  const fixed: Record<string, number[]> = {};
  const probes: Record<string, number[]> = {};
  for (const [key, p] of Object.entries(distributions)) (isProbeKey(key) ? probes : fixed)[key] = p;
  return { fixed, probes };
};

/**
 * Aggregates only — a probe slot means something different every run, so a
 * per-slot column would be noise to any model trained on the record.
 *
 * `min_margin` is the one to watch: the least decided probe is where the
 * writer found something the state does not settle.
 */
export const probeFeatures = (
  nodeId: string,
  record: ProbeRecord,
  answers: readonly ProbeAnswer[],
): Record<string, number> => {
  const out: Record<string, number> = {
    [`${nodeId}.probes.asked`]: Object.keys(record.asked).length,
    [`${nodeId}.probes.answered`]: answers.length,
    [`${nodeId}.probes.dropped`]: record.dropped.length,
  };
  const margins: number[] = [];
  const entropies: number[] = [];
  for (const a of answers) {
    // A Noul is one number: its "margin" is its distance from a coin flip.
    const m = a.distribution.length === 1 ? Math.abs(2 * a.distribution[0]! - 1) : topMargin(a.distribution);
    if (m !== null) margins.push(m);
    if (a.distribution.length > 1) {
      const h = normalizedEntropy(a.distribution);
      if (h !== null) entropies.push(h);
    }
  }
  if (margins.length > 0) out[`${nodeId}.probes.min_margin`] = Math.min(...margins);
  if (entropies.length > 0) {
    out[`${nodeId}.probes.max_entropy`] = Math.max(...entropies);
    out[`${nodeId}.probes.mean_entropy`] = entropies.reduce((a, b) => a + b, 0) / entropies.length;
  }
  return out;
};
