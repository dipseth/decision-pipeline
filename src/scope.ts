/**
 * Scope resolution — the runtime's job, never the pipeline's.
 *
 * Before node 0 the runtime walks `session -> device -> user -> associated ->
 * tenant -> global` for the caller and turns whatever rows come back into a
 * `ScopeContext`. Two things come out of it and nothing else:
 *
 *   ctx.features(nodeId)  all scopes CONCATENATE (features are content-free by
 *                         the form x scope rule, so nothing is dropped for being wide)
 *   ctx.override(key)     the SINGLE narrowest row, applied at read
 *
 * A pipeline's code never reads a user id.
 */

import {
  DIRECT_FORM_MAX_SCOPE,
  scopeAtMost,
  scopeIndex,
  rankIndex,
  type FeatureRow,
  type OverrideRow,
  type Scope,
  type ScopeContext,
} from "./types";

export interface ScopeContextInput {
  ids?: Partial<Record<Scope, string>>;
  grants?: readonly string[];
  features?: readonly FeatureRow[];
  overrides?: readonly OverrideRow[];
}

/** Rows the form x scope rule refuses, kept so the runtime can record the drop. */
export interface ScopeRejection {
  id: string;
  form: "feature" | "override";
  scope: Scope;
  reason: "form_scope_rule";
}

export interface BuiltScopeContext {
  ctx: ScopeContext;
  rejected: ScopeRejection[];
}

/** Narrowest scope first; within a scope the stronger rank first; then oldest first. */
const byScopeThenRank = (
  a: { scope: Scope; rank: FeatureRow["rank"]; createdAt?: string },
  b: { scope: Scope; rank: FeatureRow["rank"]; createdAt?: string },
): number => {
  const s = scopeIndex(a.scope) - scopeIndex(b.scope);
  if (s !== 0) return s;
  const r = rankIndex(b.rank) - rankIndex(a.rank);
  if (r !== 0) return r;
  return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
};

/**
 * The form x scope rule, enforced at read as well as at manifest load.
 * A manifest can only declare edges; rows outlive manifests, so a row that
 * arrives from a scope the rule forbids is dropped here and recorded — never
 * quietly honoured.
 */
const allowedDirectForm = (scope: Scope): boolean =>
  scopeAtMost(scope, DIRECT_FORM_MAX_SCOPE);

export const buildScopeContext = (
  input: ScopeContextInput = {},
): BuiltScopeContext => {
  const rejected: ScopeRejection[] = [];

  const features: FeatureRow[] = [];
  for (const row of input.features ?? []) {
    if (!allowedDirectForm(row.scope)) {
      rejected.push({ id: row.id, form: "feature", scope: row.scope, reason: "form_scope_rule" });
      continue;
    }
    features.push(row);
  }
  features.sort(byScopeThenRank);

  const overrides: OverrideRow[] = [];
  for (const row of input.overrides ?? []) {
    if (!allowedDirectForm(row.scope)) {
      rejected.push({ id: row.id, form: "override", scope: row.scope, reason: "form_scope_rule" });
      continue;
    }
    overrides.push(row);
  }
  overrides.sort(byScopeThenRank);

  const byNode = new Map<string, FeatureRow[]>();
  for (const row of features) {
    const bucket = byNode.get(row.nodeId);
    if (bucket) bucket.push(row);
    else byNode.set(row.nodeId, [row]);
  }

  const consumedIds = new Set<string>();

  const ctx: ScopeContext = {
    ids: Object.freeze({ ...(input.ids ?? {}) }),
    grants: Object.freeze([...(input.grants ?? [])]),

    features(nodeId: string): FeatureRow[] {
      const rows = byNode.get(nodeId) ?? [];
      for (const row of rows) consumedIds.add(row.id);
      return [...rows];
    },

    override(key: string): OverrideRow | null {
      // Already sorted narrowest-first, so the first match IS the narrowest.
      const hit = overrides.find((row) => row.key === key);
      if (!hit) return null;
      consumedIds.add(hit.id);
      return hit;
    },

    consumed(): string[] {
      return [...consumedIds];
    },
  };

  return { ctx, rejected };
};

/** An empty context — what an unauthenticated or unscoped run gets. */
export const emptyScopeContext = (): ScopeContext =>
  buildScopeContext().ctx;
