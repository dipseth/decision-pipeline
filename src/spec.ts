/**
 * Pipelines as data — a JSON spec that compiles into the same manifest a TS
 * author writes with `definePipeline`, so every contract check still runs.
 *
 * docs/decision-pipelines.md chose TS manifests over YAML because "a YAML
 * runner would just add a string->function registry for a single author".
 * A model proposing a DAG is the second author that premise ruled out. This
 * file is that registry, kept small by what the three shipped pipelines
 * showed: every code node is a 3-27 line wrapper that picks fields out of
 * upstream outputs, calls ONE domain function, and reshapes the answer. So a
 * spec's code node is one of
 *
 *   call    a registered PRIMITIVE (`cuisine.jevLeafResult@1`) — the domain
 *           function with a zod schema on its args. Side effects live only here
 *           and in the host's ports, so a spec can do nothing a primitive
 *           author did not write.
 *   rules   a gate as an ordered list of `{ when, branch, reason }`, first
 *           match wins, the last rule a catch-all (the deterministic-fallback
 *           rule, checked).
 *   expr    a pure expression, for mapping and validation.
 *   inputs  alone: a node whose output is its bindings (./bindings) — the
 *           "bundle what the branches need" node every pipeline has.
 *
 * Expressions go through an injected `ExpressionEngine` (JSONata in
 * ./jsonata) so this file stays zod-only. An expression sees the node's
 * resolved `inputs` as its root (or `from`, by node id, when it declares
 * none) and `$input`, `$t` (thresholds), `$primary`, `$branches`, `$probes`
 * (never for a gate) and the registry's functions as bindings.
 *
 * A compiled node's version is the declared one plus a hash of its body
 * (`1~3fa9…`): editing an expression IS a new node version — the cache key
 * and the run record's composite version both move with it.
 */

import { z, type ZodType } from "zod";
import { definePipeline, type DecisionPipeline, type FeatureExtractionArgs, type PipelineSpec } from "./define";
import { PipelineContractError } from "./errors";
import { shortHash } from "./hash";
import {
  cacheSchema,
  codeRoleSchema,
  edgeSchema,
  evalSchema,
  experimentSchema,
  feedbackEdgeSchema,
  onFailureSchema,
  probeSpecSchema,
  rankSchema,
  scopeSchema,
  thresholdSchema,
  toolSpecSchema,
  triggerSchema,
  zodProblems,
} from "./schema";
import type { GateResult, NodeBody, NodeRunArgs, PipelineNode } from "./types";

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export interface CompiledExpression {
  evaluate(root: unknown, bindings: Record<string, unknown>): unknown | Promise<unknown>;
  /**
   * Top-level names the expression reads off its ROOT (`bundle` in
   * `bundle.title`), when the engine can tell. Lets the compiler refuse a read
   * of something that never flows into the node, instead of it silently
   * evaluating to nothing. Conservative: a name it cannot place is left out.
   */
  roots?(): string[];
}

export interface ExpressionEngine {
  /** Throws on a syntax error — so a bad expression fails at load, not mid-run. */
  compile(source: string): CompiledExpression;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface PrimitiveContext {
  input: unknown;
  thresholds: Readonly<Record<string, number>>;
  node: { id: string; version: string };
  signal?: AbortSignal;
}

/** A primitive as the registry holds it, whatever its arg type. */
export interface RegisteredPrimitive {
  id: string;
  version: string;
  describe: string;
  args: ZodType;
  run: (args: never, ctx: PrimitiveContext) => unknown;
}

export interface Primitive<A = unknown, R = unknown> {
  /** Dotted, domain first: `cuisine.jevLeafResult`. Referenced as `id@version`. */
  id: string;
  version: string;
  /** What it does, for the catalog a model reads. One or two sentences. */
  describe: string;
  /** Validated on every call — a spec wires values it cannot type-check. */
  args: ZodType<A>;
  run: (args: A, ctx: PrimitiveContext) => R | Promise<R>;
}

export interface ExpressionFunction {
  describe: string;
  // Called from inside expressions with whatever the expression passes.
  fn: (...args: never[]) => unknown;
}

export type FeatureFn = (args: FeatureExtractionArgs<never>) => Record<string, number>;

export interface SpecRegistry {
  /** Keyed `id@version`. */
  primitives: Readonly<Record<string, RegisteredPrimitive>>;
  /** Exposed to expressions as `$<name>`. */
  functions: Readonly<Record<string, ExpressionFunction>>;
  /** Input / output schemas a spec names. */
  schemas: Readonly<Record<string, ZodType>>;
  features: Readonly<Record<string, FeatureFn>>;
}

export const primitiveRef = (p: Pick<Primitive, "id" | "version">): string => `${p.id}@${p.version}`;

/** Names an expression already has — a registry function may not shadow them. */
const RESERVED_BINDINGS = ["input", "t", "primary", "branches", "probes"];

export const definePrimitive = <A, R>(p: Primitive<A, R>): Primitive<A, R> => p;

export const defineRegistry = (parts: {
  primitives?: RegisteredPrimitive[];
  functions?: Record<string, ExpressionFunction>;
  schemas?: Record<string, ZodType>;
  features?: Record<string, FeatureFn>;
}): SpecRegistry => {
  const primitives: Record<string, RegisteredPrimitive> = {};
  for (const p of parts.primitives ?? []) {
    const ref = primitiveRef(p);
    if (primitives[ref]) throw new Error(`registry: primitive "${ref}" registered twice`);
    primitives[ref] = p;
  }
  for (const name of Object.keys(parts.functions ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`registry: function name "${name}" is not an identifier`);
    if (RESERVED_BINDINGS.includes(name)) throw new Error(`registry: function "$${name}" would shadow a reserved binding`);
  }
  return {
    primitives,
    functions: { ...parts.functions },
    schemas: { ...parts.schemas },
    features: { ...parts.features },
  };
};

/** Later registries win nothing — a clash is an error, like a double registration. */
export const mergeRegistries = (...registries: SpecRegistry[]): SpecRegistry => {
  const out = { primitives: {}, functions: {}, schemas: {}, features: {} } as {
    [K in keyof SpecRegistry]: Record<string, SpecRegistry[K][string]>;
  };
  for (const r of registries) {
    for (const k of Object.keys(out) as Array<keyof SpecRegistry>) {
      for (const [name, v] of Object.entries(r[k])) {
        if (name in out[k]) throw new Error(`registry: ${k} "${name}" defined twice`);
        (out[k] as Record<string, unknown>)[name] = v;
      }
    }
  }
  return out as SpecRegistry;
};

// ---------------------------------------------------------------------------
// The spec's shape
// ---------------------------------------------------------------------------

const expr = z.string().min(1);
const primitiveRefSchema = z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/, "a primitive is referenced as id@version");
const inputsSchema = z.record(z.string(), z.string().min(1));

const fallbackSpecSchema = z.union([
  z.object({ value: z.unknown() }).strict(),
  z.object({ expr }).strict(),
  z.object({ call: primitiveRefSchema, args: z.record(z.string(), expr).optional() }).strict(),
]);

const common = {
  version: z.string().min(1),
  describe: z.string().optional(),
  onFailure: onFailureSchema.optional(),
  cache: cacheSchema.optional(),
  inputs: inputsSchema.optional(),
  fallback: fallbackSpecSchema.optional(),
};

export const readSpecSchema = z
  .object({
    kind: z.literal("read"),
    ...common,
    call: primitiveRefSchema,
    args: z.record(z.string(), expr).optional(),
    providesFeatures: z.boolean().optional(),
  })
  .strict();

export const decideSpecSchema = z
  .object({
    kind: z.literal("decide"),
    ...common,
    questions: z.string().min(1).optional(),
    probes: probeSpecSchema.optional(),
    state: z.array(z.string().min(1)).optional(),
    acceptsFeatures: z.boolean().optional(),
    batched: z.boolean().optional(),
  })
  .strict();

export const generateSpecSchema = z
  .object({
    kind: z.literal("generate"),
    ...common,
    prompt: z.string().min(1),
    route: z.string().min(1),
    submit: z.string().min(1).optional(),
    tools: toolSpecSchema.optional(),
  })
  .strict();

export const codeSpecSchema = z
  .object({
    kind: z.literal("code"),
    ...common,
    role: codeRoleSchema.exclude(["gate"]),
    thresholds: z.record(z.string(), thresholdSchema).optional(),
    call: primitiveRefSchema.optional(),
    args: z.record(z.string(), expr).optional(),
    expr: expr.optional(),
    /** Every `that` must be truthy or the node fails with `message` (its onFailure decides the rest). */
    assert: z.array(z.object({ that: expr, message: z.string().min(1) }).strict()).min(1).optional(),
  })
  .strict();

export const gateRuleSchema = z
  .object({
    /** Absent = always matches. Only the LAST rule may omit it. */
    when: expr.optional(),
    branch: z.string().min(1),
    reason: expr.optional(),
    confidence: expr.optional(),
  })
  .strict();

export const gateSpecSchema = z
  .object({
    kind: z.literal("code"),
    ...common,
    role: z.literal("gate"),
    thresholds: z.record(z.string(), thresholdSchema),
    branches: z.array(z.string().min(1)).min(1),
    rules: z.array(gateRuleSchema).min(1).optional(),
    call: primitiveRefSchema.optional(),
    args: z.record(z.string(), expr).optional(),
  })
  .strict();

export const storeSpecSchema = z
  .object({
    kind: z.literal("store"),
    ...common,
    target: z.string().min(1),
    scope: scopeSchema,
    ttl: z.string().min(1).optional(),
  })
  .strict();

export const nodeSpecSchema = z.union([
  readSpecSchema,
  decideSpecSchema,
  generateSpecSchema,
  gateSpecSchema,
  codeSpecSchema,
  storeSpecSchema,
]);
export type NodeSpecJSON = z.infer<typeof nodeSpecSchema>;

/** `{path}` placeholders over an object: `cuisine-{pointId}`. */
const templateSchema = z.string().min(1);

export const pipelineSpecSchema = z
  .object({
    id: z.string().min(1),
    fact: z.string().min(1),
    /** Registry schema names. */
    input: z.string().min(1),
    output: z.string().min(1),
    trigger: z.array(triggerSchema).min(1),
    /** Template over the input — the Langfuse grouping key. */
    group: templateSchema,
    result: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    decidedBy: rankSchema.optional(),
    eval: evalSchema,
    precedence: z.object({ over: z.array(z.string().min(1)) }).strict().optional(),
    knowledgeVersion: z.string().min(1).optional(),
    overridable: z
      .object({ scope: scopeSchema, key: templateSchema, keyFromInput: templateSchema.optional() })
      .strict()
      .optional(),
    nodes: z.record(z.string().min(1), nodeSpecSchema),
    edges: z.array(edgeSchema),
    feedback: z.array(feedbackEdgeSchema.omit({ key: true }).strict()),
    experiments: z.array(experimentSchema).optional(),
    /** Registry feature-extractor name. */
    features: z.string().min(1).optional(),
  })
  .strict();
export type PipelineSpecJSON = z.infer<typeof pipelineSpecSchema>;

/** The spec's JSON Schema — what a model is handed for structured output. */
export const pipelineSpecJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(pipelineSpecSchema, { unrepresentable: "any" }) as Record<string, unknown>;

/** What a model needs to know to write a spec against this registry. */
export const describeRegistry = (registry: SpecRegistry) => ({
  primitives: Object.entries(registry.primitives).map(([ref, p]) => ({
    ref,
    describe: p.describe,
    args: z.toJSONSchema(p.args, { unrepresentable: "any" }),
  })),
  functions: Object.entries(registry.functions).map(([name, f]) => ({ name: `$${name}`, describe: f.describe })),
  schemas: Object.keys(registry.schemas),
  features: Object.keys(registry.features),
});

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g;

const compileTemplate = (src: string): ((value: unknown) => string) => (value) =>
  src.replace(PLACEHOLDER_RE, (_, path: string) => {
    let v: unknown = value;
    for (const seg of path.split(".")) v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[seg] : undefined;
    return v === undefined || v === null ? "" : String(v);
  });

/** Everything that changes what a node DOES, for its version hash. */
const bodyOf = (n: Record<string, unknown>): Record<string, unknown> | null => {
  const keys = ["inputs", "call", "args", "expr", "rules", "assert", "fallback"];
  const body = Object.fromEntries(keys.filter((k) => n[k] !== undefined).map((k) => [k, n[k]]));
  return Object.keys(body).length > 0 ? body : null;
};

export interface CompileResult<I, O> {
  pipeline: DecisionPipeline<I, O> | null;
  /** Empty when `pipeline` is set. Every problem at once, so a model can fix them in one round. */
  problems: string[];
}

/**
 * JSON -> manifest. Never throws: a spec a model wrote comes back with every
 * problem listed (shape, registry refs, expression syntax, then the full
 * `definePipeline` contract), which is the repair loop's input.
 */
export const compilePipelineSpec = <I = unknown, O = unknown>(
  json: unknown,
  registry: SpecRegistry,
  engine: ExpressionEngine,
): CompileResult<I, O> => {
  const parsed = pipelineSpecSchema.safeParse(json);
  if (!parsed.success) return { pipeline: null, problems: zodProblems(parsed.error) };
  const spec = parsed.data;
  const problems: string[] = [];

  /** What an expression on a node may read off its root: its inputs, or the nodes with an edge into it. */
  interface Readable {
    names: ReadonlySet<string>;
    say: string;
  }
  const readableFor = (id: string, inputs: Record<string, string> | undefined): Readable => {
    if (inputs) return { names: new Set(Object.keys(inputs)), say: `one of its inputs (${Object.keys(inputs).join(", ")})` };
    const inbound = spec.edges.filter((e) => e.to === id).map((e) => e.from);
    const gates = inbound.filter((f) => {
      const n = spec.nodes[f];
      return n?.kind === "code" && n.role === "gate";
    });
    const hint = gates.length
      ? ` — a gate passes its input through, so what reached "${gates[0]}" is read as \`${gates[0]}\``
      : "";
    return {
      names: new Set(inbound),
      say: inbound.length ? `a node with an edge into it (${inbound.join(", ")})${hint}` : "anything: it has no inbound edge and no inputs (use $input)",
    };
  };
  const compile = (where: string, source: string, readable?: Readable): CompiledExpression | null => {
    let c: CompiledExpression;
    try {
      c = engine.compile(source);
    } catch (err) {
      problems.push(`${where}: expression does not parse: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (readable && c.roots) {
      for (const name of c.roots()) {
        if (!readable.names.has(name)) problems.push(`${where}: reads \`${name}\`, which is not ${readable.say}`);
      }
    }
    return c;
  };
  const primitive = (where: string, ref: string): RegisteredPrimitive | null => {
    const p = registry.primitives[ref];
    if (!p) {
      problems.push(`${where}: unknown primitive "${ref}" (registered: ${Object.keys(registry.primitives).join(", ") || "none"})`);
      return null;
    }
    return p;
  };
  const schema = (where: string, name: string): ZodType | null => {
    const s = registry.schemas[name];
    if (!s) problems.push(`${where}: unknown schema "${name}" (registered: ${Object.keys(registry.schemas).join(", ") || "none"})`);
    return s ?? null;
  };

  const fns = Object.fromEntries(Object.entries(registry.functions).map(([k, f]) => [k, f.fn]));
  const bindingsFor = (args: NodeRunArgs, gate: boolean): Record<string, unknown> => ({
    ...fns,
    input: args.input,
    t: args.thresholds,
    primary: args.primary,
    branches: args.branches,
    probes: gate ? {} : args.probes,
  });
  const rootFor = (args: NodeRunArgs, declaresInputs: boolean): unknown => (declaresInputs ? args.in : args.from);
  const ctxFor = (args: NodeRunArgs): PrimitiveContext => ({
    input: args.input,
    thresholds: args.thresholds,
    node: args.node,
    ...(args.signal ? { signal: args.signal } : {}),
  });

  /** A body that calls a primitive with `args` expressions, or with the node's bindings. */
  const callBody = (
    where: string,
    ref: string,
    argExprs: Record<string, string> | undefined,
    readable: Readable,
    declaresInputs: boolean,
    gate = false,
  ): NodeBody | null => {
    const p = primitive(where, ref);
    const compiled = Object.entries(argExprs ?? {}).map(([k, src]) => [k, compile(`${where}.args.${k}`, src, readable)] as const);
    if (!p || compiled.some(([, c]) => c === null)) return null;
    return async (args) => {
      let raw: unknown;
      if (argExprs) {
        const root = rootFor(args, declaresInputs);
        const b = bindingsFor(args, gate);
        const out: Record<string, unknown> = {};
        for (const [k, c] of compiled) out[k] = await c!.evaluate(root, b);
        raw = out;
      } else {
        raw = { ...args.in };
      }
      const checked = p.args.safeParse(raw);
      if (!checked.success) {
        throw new Error(`${where}: args for ${ref} do not match its schema — ${zodProblems(checked.error).join("; ")}`);
      }
      return p.run(checked.data as never, ctxFor(args));
    };
  };

  const exprBody = (where: string, source: string, readable: Readable, declaresInputs: boolean): NodeBody | null => {
    const c = compile(where, source, readable);
    if (!c) return null;
    return (args) => c.evaluate(rootFor(args, declaresInputs), bindingsFor(args, false));
  };

  const fallbackBody = (
    where: string,
    f: NonNullable<NodeSpecJSON["fallback"]>,
    readable: Readable,
    declaresInputs: boolean,
  ): NodeBody | null => {
    if ("value" in f) {
      const value = f.value;
      return () => structuredClone(value);
    }
    if ("expr" in f) return exprBody(`${where}.fallback`, f.expr, readable, declaresInputs);
    return callBody(`${where}.fallback`, f.call, f.args, readable, declaresInputs);
  };

  const nodes: Record<string, PipelineNode<I>> = {};
  for (const [id, n] of Object.entries(spec.nodes)) {
    const where = `nodes.${id}`;
    const declaresInputs = n.inputs !== undefined;
    const readable = readableFor(id, n.inputs);
    const body = bodyOf(n as Record<string, unknown>);
    const version = body ? `${n.version}~${shortHash(body).slice(0, 8)}` : n.version;
    const base = {
      version,
      ...(n.describe ? { describe: n.describe } : {}),
      ...(n.onFailure ? { onFailure: n.onFailure } : {}),
      ...(n.cache ? { cache: n.cache } : {}),
      ...(n.inputs ? { inputs: n.inputs } : {}),
    };
    let fallback: NodeBody | null | undefined;
    if (n.fallback) fallback = fallbackBody(where, n.fallback, readable, declaresInputs);
    if (n.onFailure === "fallback" && !n.fallback) problems.push(`${where}: onFailure "fallback" needs a \`fallback\``);
    const withFallback = fallback ? { fallback: fallback as NodeBody<I> } : {};

    switch (n.kind) {
      case "read": {
        const load = callBody(where, n.call, n.args, readable, declaresInputs);
        if (load) nodes[id] = { kind: "read", ...base, ...withFallback, load: load as NodeBody<I>, ...(n.providesFeatures ? { providesFeatures: true } : {}) };
        break;
      }
      case "decide": {
        const { kind, version: _v, describe: _d, onFailure: _o, cache: _c, inputs: _i, fallback: _f, ...rest } = n;
        nodes[id] = { kind, ...base, ...withFallback, ...rest };
        break;
      }
      case "generate": {
        const { kind, version: _v, describe: _d, onFailure: _o, cache: _c, inputs: _i, fallback: _f, ...rest } = n;
        nodes[id] = { kind, ...base, ...withFallback, ...rest };
        break;
      }
      case "store": {
        const { kind, version: _v, describe: _d, onFailure: _o, cache: _c, inputs: _i, fallback: _f, ...rest } = n;
        nodes[id] = { kind, ...base, ...withFallback, ...rest };
        break;
      }
      case "code": {
        if (n.role === "gate") {
          if (!!n.rules === !!n.call) {
            problems.push(`${where}: a gate needs exactly one of \`rules\` or \`call\``);
            break;
          }
          let run: NodeBody | null = null;
          if (n.call) run = callBody(where, n.call, n.args, readable, declaresInputs, true);
          if (n.rules) {
            const rules = n.rules;
            rules.forEach((r, i) => {
              if (!n.branches.includes(r.branch)) problems.push(`${where}.rules[${i}]: branch "${r.branch}" is not one of ${n.branches.join(", ")}`);
              if (r.when === undefined && i !== rules.length - 1) problems.push(`${where}.rules[${i}]: only the last rule may omit \`when\` — nothing after it is reachable`);
            });
            if (rules[rules.length - 1]!.when !== undefined) {
              problems.push(`${where}: the last rule must have no \`when\` — a gate needs a branch for every input`);
            }
            for (const b of n.branches) {
              if (!rules.some((r) => r.branch === b)) problems.push(`${where}: no rule produces branch "${b}"`);
            }
            const compiled = rules.map((r, i) => ({
              branch: r.branch,
              when: r.when === undefined ? null : compile(`${where}.rules[${i}].when`, r.when, readable),
              reason: r.reason === undefined ? null : compile(`${where}.rules[${i}].reason`, r.reason, readable),
              confidence: r.confidence === undefined ? null : compile(`${where}.rules[${i}].confidence`, r.confidence, readable),
            }));
            run = async (args): Promise<GateResult> => {
              const root = rootFor(args, declaresInputs);
              const b = bindingsFor(args, true);
              for (const r of compiled) {
                if (r.when && !(await r.when.evaluate(root, b))) continue;
                const reason = r.reason ? await r.reason.evaluate(root, b) : undefined;
                const confidence = r.confidence ? await r.confidence.evaluate(root, b) : undefined;
                return {
                  branch: r.branch,
                  ...(reason === undefined || reason === null ? {} : { reason: String(reason) }),
                  ...(typeof confidence === "number" ? { confidence } : {}),
                };
              }
              // Unreachable once the catch-all rule is checked; kept for a spec compiled with problems ignored.
              throw new Error(`${id}: no gate rule matched`);
            };
          }
          if (run) {
            nodes[id] = {
              kind: "code",
              role: "gate",
              ...base,
              ...withFallback,
              thresholds: n.thresholds,
              branches: n.branches,
              run: run as NodeBody<I> as never,
            };
          }
          break;
        }

        const bodies = [n.call, n.expr].filter((x) => x !== undefined).length;
        if (bodies > 1) {
          problems.push(`${where}: a code node takes \`call\` or \`expr\`, not both`);
          break;
        }
        if (n.args && !n.call) problems.push(`${where}: \`args\` only goes with \`call\``);
        if (bodies === 0 && !n.assert && !declaresInputs) {
          problems.push(`${where}: a code node needs \`call\`, \`expr\`, \`assert\` or \`inputs\``);
          break;
        }
        let main: NodeBody | null;
        if (n.call) main = callBody(where, n.call, n.args, readable, declaresInputs);
        else if (n.expr) main = exprBody(where, n.expr, readable, declaresInputs);
        else if (n.assert) main = (args) => args.primary;
        else main = (args) => ({ ...args.in });
        const asserts = (n.assert ?? []).map((a, i) => ({ message: a.message, that: compile(`${where}.assert[${i}]`, a.that, readable) }));
        if (!main) break;
        const run: NodeBody = asserts.length === 0
          ? main
          : async (args) => {
              const root = rootFor(args, declaresInputs);
              const b = bindingsFor(args, false);
              for (const a of asserts) {
                if (!(await a.that!.evaluate(root, b))) throw new Error(`${id}: ${a.message}`);
              }
              return main!(args);
            };
        nodes[id] = {
          kind: "code",
          role: n.role,
          ...base,
          ...withFallback,
          ...(n.thresholds ? { thresholds: n.thresholds } : {}),
          run: run as NodeBody<I>,
        };
        break;
      }
    }
  }

  const input = schema("input", spec.input);
  const output = schema("output", spec.output);
  let features: FeatureFn | undefined;
  if (spec.features) {
    features = registry.features[spec.features];
    if (!features) problems.push(`features: unknown extractor "${spec.features}" (registered: ${Object.keys(registry.features).join(", ") || "none"})`);
  }
  if (problems.length > 0) return { pipeline: null, problems };

  const group = compileTemplate(spec.group);
  const manifest: PipelineSpec<I, O> = {
    id: spec.id,
    fact: spec.fact,
    input: input as ZodType<I>,
    output: output as ZodType<O>,
    trigger: spec.trigger,
    group: (i) => group(i),
    nodes,
    edges: spec.edges,
    feedback: spec.feedback,
    result: spec.result,
    eval: spec.eval,
    ...(spec.decidedBy ? { decidedBy: spec.decidedBy } : {}),
    ...(spec.precedence ? { precedence: spec.precedence } : {}),
    ...(spec.knowledgeVersion ? { knowledgeVersion: spec.knowledgeVersion } : {}),
    ...(spec.experiments ? { experiments: spec.experiments } : {}),
    ...(features ? { features: features as unknown as PipelineSpec<I, O>["features"] } : {}),
    ...(spec.overridable
      ? {
          overridable: {
            scope: spec.overridable.scope,
            key: compileTemplate(spec.overridable.key),
            ...(spec.overridable.keyFromInput ? { keyFromInput: compileTemplate(spec.overridable.keyFromInput) } : {}),
          },
        }
      : {}),
  };
  try {
    return { pipeline: definePipeline(manifest), problems: [] };
  } catch (err) {
    if (err instanceof PipelineContractError) return { pipeline: null, problems: err.problems };
    throw err;
  }
};

/** `compilePipelineSpec`, throwing a `PipelineContractError` with every problem. */
export const pipelineFromSpec = <I = unknown, O = unknown>(
  json: unknown,
  registry: SpecRegistry,
  engine: ExpressionEngine,
): DecisionPipeline<I, O> => {
  const { pipeline, problems } = compilePipelineSpec<I, O>(json, registry, engine);
  if (!pipeline) {
    const id = json && typeof json === "object" && typeof (json as { id?: unknown }).id === "string" ? (json as { id: string }).id : "(spec)";
    throw new PipelineContractError(id, problems);
  }
  return pipeline;
};
