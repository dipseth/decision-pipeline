/**
 * Named inputs — a node says WHAT it reads instead of reaching into
 * `args.from.<nodeId>`.
 *
 * Every existing node body opens by digging its inputs out of `from` by node
 * id (`args.from.taxonomy`, `from.maps ?? from.retry_maps`). That makes node
 * ids load-bearing inside bodies: rename or move a node and some other node's
 * code breaks, with no load-time error. A binding moves that dig into the
 * manifest, where `definePipeline` can check it:
 *
 *   inputs: { row: "evidence.row", taxonomy: "taxonomy", iteration: "$input.iteration" }
 *
 * and the body reads `args.in.row`. A ref is
 *
 *   <node>[.<field>|[<n>]]*     an output of a DIRECT inbound node, or a part of it
 *   $input[.<field>|[<n>]]*     the pipeline's validated input
 *   <ref> | <ref> | ...         the first that resolves (`maps | retry_maps`)
 *   ... | null / 0 / true / "x"   a JSON literal as the LAST alternative, the
 *                               default when nothing before it resolves
 *
 * "Resolves" means the node ran and the path is not `undefined` — `null` is a
 * value (a gate that routes on `row = null` needs to see it). A skipped node
 * is absent from `from`, so it falls through to the next alternative, and a
 * ref with no alternative left binds `undefined`.
 *
 * Direct inbound only, the same rule as `from` and `probes.from`: a binding
 * to a non-adjacent ancestor would read an output the edge guards never
 * vouched for on this path.
 */

export const INPUT_REF = "$input";

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const REF_RE = new RegExp(`^(\\$input|${IDENT})((?:\\.${IDENT}|\\[\\d+\\])*)$`);
const SEGMENT_RE = new RegExp(`\\.(${IDENT})|\\[(\\d+)\\]`, "g");
const NAME_RE = new RegExp(`^${IDENT}$`);

export type ParsedRef =
  | {
      /** A node id, or `$input`. */
      source: string;
      path: Array<string | number>;
    }
  | { literal: null | boolean | number | string };

const LITERAL_RE = /^(null|true|false|-?\d+(?:\.\d+)?|"[^"\\]*")$/;

/** A ref's alternatives, or the reason it does not parse. */
export const parseInputRef = (ref: string): ParsedRef[] | string => {
  const alternatives = ref.split("|").map((s) => s.trim());
  const parsed: ParsedRef[] = [];
  for (const [i, alt] of alternatives.entries()) {
    if (LITERAL_RE.test(alt)) {
      if (i === 0) return `"${alt}" is a literal — a binding reads something first, a literal is only its default`;
      if (i !== alternatives.length - 1) return `literal "${alt}" must be the last alternative — nothing after a default is ever read`;
      parsed.push({ literal: JSON.parse(alt) as null | boolean | number | string });
      continue;
    }
    const m = REF_RE.exec(alt);
    if (!m) return `"${alt}" is not <node>[.field|[n]]* or $input[.field|[n]]*`;
    const path: Array<string | number> = [];
    for (const s of m[2]!.matchAll(SEGMENT_RE)) path.push(s[1] !== undefined ? s[1] : Number(s[2]));
    parsed.push({ source: m[1]!, path });
  }
  return parsed;
};

/** The node ids a set of bindings reads from — for edge checks and diagrams. */
export const bindingSources = (inputs: Record<string, string>): string[] => {
  const out = new Set<string>();
  for (const ref of Object.values(inputs)) {
    const parsed = parseInputRef(ref);
    if (typeof parsed === "string") continue;
    for (const p of parsed) if ("source" in p && p.source !== INPUT_REF) out.add(p.source);
  }
  return [...out];
};

/** Load-time checks: names are identifiers, refs parse, every source is a direct inbound node. */
export const bindingProblems = (
  nodeId: string,
  inputs: Record<string, string>,
  directInbound: ReadonlySet<string>,
): string[] => {
  const problems: string[] = [];
  for (const [name, ref] of Object.entries(inputs)) {
    if (!NAME_RE.test(name)) problems.push(`node "${nodeId}": input name "${name}" is not an identifier`);
    const parsed = parseInputRef(ref);
    if (typeof parsed === "string") {
      problems.push(`node "${nodeId}": input "${name}": ${parsed}`);
      continue;
    }
    for (const p of parsed) {
      if ("source" in p && p.source !== INPUT_REF && !directInbound.has(p.source)) {
        problems.push(
          `node "${nodeId}": input "${name}" reads "${p.source}", which has no edge ${p.source} -> ${nodeId} — a node binds only what flows into it`,
        );
      }
    }
  }
  return problems;
};

const walk = (value: unknown, path: ReadonlyArray<string | number>): unknown => {
  let v = value;
  for (const seg of path) {
    if (v === null || v === undefined || typeof v !== "object") return undefined;
    v = (v as Record<string | number, unknown>)[seg];
  }
  return v;
};

/**
 * Bindings -> values, for one node on one run. Assumes `bindingProblems`
 * passed at load; an unparseable ref here binds `undefined` rather than throw.
 */
export const resolveInputs = (
  inputs: Record<string, string> | undefined,
  from: Readonly<Record<string, unknown>>,
  input: unknown,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (!inputs) return out;
  for (const [name, ref] of Object.entries(inputs)) {
    const parsed = parseInputRef(ref);
    let value: unknown = undefined;
    if (typeof parsed !== "string") {
      for (const p of parsed) {
        if ("literal" in p) {
          value = p.literal;
          break;
        }
        if (p.source !== INPUT_REF && !Object.prototype.hasOwnProperty.call(from, p.source)) continue;
        value = walk(p.source === INPUT_REF ? input : from[p.source], p.path);
        if (value !== undefined) break;
      }
    }
    out[name] = value;
  }
  return out;
};
