/**
 * The JSONata `ExpressionEngine` for ./spec — a subpath
 * (`@rivers/decision-pipeline/jsonata`), so the core's only runtime dep stays
 * zod and a host that never compiles a spec never loads JSONata. The host
 * brings `jsonata` itself (recipes-core depends on it).
 *
 * Why JSONata: one language for predicates (`row.confidence >= $t.gate`) AND
 * reshaping (`{ "slug": top[0].slug }`); pure JS, MIT, no I/O. JSON Logic
 * cannot map; CEL predicates well but reshapes poorly.
 *
 * Two JSONata habits a spec author (or model) should know:
 *   - a path over an array of ONE element yields the element, not the array;
 *     `cuisines[]` keeps it an array. Plumbing belongs in `inputs`, whose
 *     resolver has no such rule.
 *   - a missing path is `undefined`, never an error; `$exists(x)` tests it.
 *
 * Every evaluation is timeboxed (time and depth) through JSONata's
 * evaluate entry/exit hooks. JSONata 2.x looks those up by `Symbol.for(...)`,
 * which `evaluate`'s bindings cannot carry (it copies them with `for…in`), so
 * they have to be `assign`ed onto an expression — and a compiled pipeline is
 * shared by concurrent requests, where counters on one shared expression
 * would be summed across them. So `compile` parses once to fail a bad spec at
 * load, and each evaluation parses its own copy (microseconds for
 * expressions this size) with its own counters.
 */

import jsonata from "jsonata";
import type { CompiledExpression, ExpressionEngine } from "./spec";

export interface JsonataEngineOptions {
  /** Wall-clock budget per evaluation. Default 250 ms — these are small expressions over one run's state. */
  timeoutMs?: number;
  /** Evaluation depth ceiling (runaway recursion). Default 500. */
  maxDepth?: number;
}

interface JsonataFailure {
  code?: string;
  message?: string;
  position?: number;
}

const asError = (err: unknown, source: string): Error => {
  if (err instanceof Error) return err;
  const e = err as JsonataFailure;
  return new Error(`${e.code ?? "JSONata"}: ${e.message ?? String(err)}${e.position === undefined ? "" : ` at ${e.position}`} in \`${source}\``);
};

/**
 * JSONata marks the arrays it builds as sequences (extra own properties).
 * Hand back plain arrays and objects so nothing downstream — zod, a record,
 * a Langfuse payload — ever sees the marker.
 */
const plain = (v: unknown): unknown => {
  if (Array.isArray(v)) return Array.from(v, plain);
  if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  }
  return v;
};

interface AstNode {
  type?: string;
  value?: unknown;
  steps?: AstNode[];
  lhs?: AstNode | Array<[AstNode, AstNode]>;
  rhs?: AstNode;
  expression?: AstNode;
  expressions?: AstNode[];
  condition?: AstNode;
  then?: AstNode;
  else?: AstNode;
  arguments?: AstNode[];
}

/**
 * Names read off the ROOT. Descends only where JSONata keeps the root as the
 * context (operators, conditions, blocks, object/array constructors, function
 * arguments, the first step of a path). Later path steps, filters, sorts and
 * lambda bodies are relative to something else, so their names are fields,
 * not roots, and are left alone — the walk can miss a root, never invent one.
 */
const rootNames = (node: unknown, out: Set<string>): void => {
  if (!node || typeof node !== "object") return;
  const n = node as AstNode;
  const walk = (x: unknown): void => rootNames(x, out);
  switch (n.type) {
    case "path": {
      const first = n.steps?.[0];
      if (first?.type === "name" && typeof first.value === "string") out.add(first.value);
      else walk(first);
      return;
    }
    case "name":
      if (typeof n.value === "string") out.add(n.value);
      return;
    case "binary":
      walk(n.lhs);
      walk(n.rhs);
      return;
    case "unary":
      if (n.value === "{" && Array.isArray(n.lhs)) {
        for (const pair of n.lhs as Array<[AstNode, AstNode]>) {
          walk(pair[0]);
          walk(pair[1]);
        }
      } else if (n.value === "[") n.expressions?.forEach(walk);
      else walk(n.expression);
      return;
    case "condition":
      walk(n.condition);
      walk(n.then);
      walk(n.else);
      return;
    case "block":
      n.expressions?.forEach(walk);
      return;
    case "function":
    case "partial":
      n.arguments?.forEach(walk);
      return;
    case "bind":
      walk(n.rhs);
      return;
    case "apply":
      walk(n.lhs);
      walk(n.rhs);
      return;
    default:
      return;
  }
};

const ENTRY = Symbol.for("jsonata.__evaluate_entry");
const EXIT = Symbol.for("jsonata.__evaluate_exit");

export const jsonataEngine = (opts: JsonataEngineOptions = {}): ExpressionEngine => {
  const timeoutMs = opts.timeoutMs ?? 250;
  const maxDepth = opts.maxDepth ?? 500;
  return {
    compile(source: string): CompiledExpression {
      let ast: unknown;
      try {
        ast = jsonata(source).ast();
      } catch (err) {
        throw asError(err, source);
      }
      return {
        roots: () => {
          const out = new Set<string>();
          rootNames(ast, out);
          return [...out];
        },
        async evaluate(root, bindings) {
          const started = Date.now();
          let depth = 0;
          const check = (): void => {
            if (depth > maxDepth) throw new Error(`expression exceeded depth ${maxDepth}: \`${source}\``);
            if (Date.now() - started > timeoutMs) throw new Error(`expression exceeded ${timeoutMs} ms: \`${source}\``);
          };
          try {
            const expression = jsonata(source);
            // Symbol keys, not strings — see the header. `assign` is typed for strings only.
            const assign = expression.assign as unknown as (name: symbol, value: unknown) => void;
            assign(ENTRY, () => {
              depth += 1;
              check();
            });
            assign(EXIT, () => {
              depth -= 1;
              check();
            });
            const out: unknown = await expression.evaluate(root, bindings);
            return plain(out);
          } catch (err) {
            throw asError(err, source);
          }
        },
      };
    },
  };
};
