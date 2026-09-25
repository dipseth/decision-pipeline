/**
 * Zod over the DECLARATIVE half of a manifest.
 *
 * The other half — `run:` bodies, `group()`, `key()` — is real code and always
 * will be, so it is checked structurally in define.ts instead. This file is
 * what "a TS manifest validated by zod" actually means: the plain data gets
 * the same treatment a YAML file would have got, without a string->function
 * registry standing between an author and their own code.
 */

import { z } from "zod";
import { MAX_PROBES } from "./probes";
import { SCOPES, RANKS } from "./types";

export const scopeSchema = z.enum(SCOPES);
export const rankSchema = z.enum(RANKS);
export const triggerSchema = z.enum(["ingest", "cron", "on-demand"]);
export const onFailureSchema = z.enum(["fallback", "skip", "revert", "fail"]);
export const cacheSchema = z.enum(["none", "per-run", "per-key-forever"]);
export const nodeKindSchema = z.enum(["read", "decide", "generate", "code", "store"]);
export const codeRoleSchema = z.enum(["transform", "validate", "derive", "gate"]);

export const thresholdSchema = z.union([
  z.number(),
  z.object({ env: z.string().min(1), default: z.number() }),
  z.object({ promptConfig: z.string().min(1), default: z.number() }),
]);

export const toolSpecSchema = z.object({
  static: z.union([z.array(z.string().min(1)), z.literal("prompt-config")]).optional(),
  selectable: z
    .object({
      candidates: z.array(z.string().min(1)).min(1),
      from: z.string().min(1),
      gate: z.string().min(1),
      threshold: thresholdSchema.optional(),
    })
    .optional(),
  allow: z.array(z.string().min(1)).optional(),
});

export const edgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  when: z
    .object({ gate: z.string().min(1), branch: z.string().min(1) })
    .optional(),
});

export const feedbackFormSchema = z.enum([
  "override",
  "feature",
  "queue",
  "derived",
  "score",
]);

export const scoreConfigSchema = z
  .object({
    name: z.string().min(1),
    dataType: z.enum(["NUMERIC", "CATEGORICAL", "BOOLEAN"]),
    categories: z.array(z.object({ label: z.string().min(1), value: z.number() }).strict()).optional(),
    description: z.string().optional(),
  })
  .strict();

export const feedbackEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  source: z.enum(["explicit", "implicit"]),
  scope: scopeSchema,
  form: feedbackFormSchema,
  latency: z.enum(["immediate", "next-run", "deferred"]),
  promoteVia: z.string().min(1).optional(),
  score: scoreConfigSchema.optional(),
  key: z.custom<(input: never) => string>((v) => typeof v === "function").optional(),
});

export const probeSpecSchema = z.object({
  from: z.string().min(1),
  max: z.number().int().min(1).max(MAX_PROBES),
  paths: z.array(z.string().min(1)).min(1).optional(),
  maxChars: z.number().int().min(40).optional(),
});

/** The parts of a node zod can see. Bodies are checked in define.ts. */
export const nodeDeclarationSchema = z
  .object({
    kind: nodeKindSchema,
    version: z.string().min(1),
    inputs: z.record(z.string(), z.string().min(1)).optional(),
    onFailure: onFailureSchema.optional(),
    cache: cacheSchema.optional(),
    describe: z.string().optional(),
    // read
    providesFeatures: z.boolean().optional(),
    // decide
    questions: z.string().min(1).optional(),
    state: z.array(z.string().min(1)).optional(),
    acceptsFeatures: z.boolean().optional(),
    batched: z.boolean().optional(),
    probes: probeSpecSchema.optional(),
    // generate
    prompt: z.string().min(1).optional(),
    route: z.string().min(1).optional(),
    submit: z.string().min(1).optional(),
    tools: toolSpecSchema.optional(),
    // code
    role: codeRoleSchema.optional(),
    thresholds: z.record(z.string(), thresholdSchema).optional(),
    branches: z.array(z.string().min(1)).optional(),
    // store
    target: z.string().min(1).optional(),
    scope: scopeSchema.optional(),
    ttl: z.string().min(1).optional(),
  })
  .loose();

export const evalSchema = z.object({
  dataset: z.string().min(1),
  gateMetric: z.string().min(1),
});

export const manifestPatchSchema = z.object({
  thresholds: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  prompts: z.record(z.string(), z.string().min(1)).optional(),
  questions: z.record(z.string(), z.string().min(1)).optional(),
  routes: z.record(z.string(), z.string().min(1)).optional(),
  tools: z.record(z.string(), toolSpecSchema).optional(),
  guards: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        when: z
          .object({ gate: z.string().min(1), branch: z.string().min(1) })
          .nullable(),
      }),
    )
    .optional(),
});

export const experimentSchema = z.object({
  id: z.string().min(1),
  unit: scopeSchema,
  mode: z.enum(["replay", "replay-redecide", "shadow", "split"]),
  champion: z.string().min(1),
  arms: z.record(z.string().min(1), manifestPatchSchema),
  weights: z.record(z.string(), z.number().min(0)).optional(),
  enabled: z.boolean().optional(),
});

/** Everything zod can see about a manifest, in one schema. */
export const pipelineDeclarationSchema = z.object({
  id: z.string().min(1),
  fact: z.string().min(1),
  trigger: z.array(triggerSchema).min(1),
  nodes: z.record(z.string().min(1), nodeDeclarationSchema),
  edges: z.array(edgeSchema),
  feedback: z.array(feedbackEdgeSchema),
  result: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  overridable: z.object({ scope: scopeSchema }).loose().optional(),
  eval: evalSchema,
  experiments: z.array(experimentSchema).optional(),
  decidedBy: rankSchema.optional(),
  precedence: z.object({ over: z.array(z.string().min(1)) }).optional(),
  knowledgeVersion: z.string().min(1).optional(),
});

/** Flatten zod issues into the same `string[]` shape the contract checks use. */
export const zodProblems = (error: z.ZodError): string[] =>
  error.issues.map(
    (issue) =>
      `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`,
  );
