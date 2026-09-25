import { describe, expect, it } from "vitest";
import { buildScopeContext } from "./scope";
import type { FeatureRow, OverrideRow } from "./types";

const feature = (over: Partial<FeatureRow> & Pick<FeatureRow, "id" | "scope">): FeatureRow => ({
  nodeId: "classify",
  rank: "human",
  value: "cilantro is produce",
  ...over,
});

const override = (over: Partial<OverrideRow> & Pick<OverrideRow, "id" | "scope">): OverrideRow => ({
  key: "cilantro",
  rank: "human",
  value: "produce",
  ...over,
});

describe("features()", () => {
  it("concatenates every scope in the chain, narrowest first", () => {
    const { ctx } = buildScopeContext({
      features: [
        feature({ id: "f-user", scope: "user" }),
        feature({ id: "f-device", scope: "device" }),
        feature({ id: "f-assoc", scope: "associated" }),
      ],
    });
    expect(ctx.features("classify").map((f) => f.id)).toEqual([
      "f-device",
      "f-user",
      "f-assoc",
    ]);
  });

  it("only hands a node the rows addressed to it", () => {
    const { ctx } = buildScopeContext({
      features: [
        feature({ id: "a", scope: "user", nodeId: "classify" }),
        feature({ id: "b", scope: "user", nodeId: "table" }),
      ],
    });
    expect(ctx.features("classify").map((f) => f.id)).toEqual(["a"]);
    expect(ctx.features("nobody")).toEqual([]);
  });

  it("orders a stronger rank first inside one scope", () => {
    const { ctx } = buildScopeContext({
      features: [
        feature({ id: "llm", scope: "user", rank: "llm" }),
        feature({ id: "admin", scope: "user", rank: "admin" }),
      ],
    });
    expect(ctx.features("classify").map((f) => f.id)).toEqual(["admin", "llm"]);
  });
});

describe("the form x scope rule, enforced at READ", () => {
  it("drops a feature row from tenant or wider and records the drop", () => {
    const { ctx, rejected } = buildScopeContext({
      features: [
        feature({ id: "ok", scope: "associated" }),
        feature({ id: "too-wide", scope: "tenant" }),
        feature({ id: "way-too-wide", scope: "global" }),
      ],
    });
    expect(ctx.features("classify").map((f) => f.id)).toEqual(["ok"]);
    expect(rejected.map((r) => r.id).sort()).toEqual(["too-wide", "way-too-wide"]);
    expect(rejected[0]?.reason).toBe("form_scope_rule");
  });

  it("drops a wide override row too — a manifest can be edited, rows outlive it", () => {
    const { ctx, rejected } = buildScopeContext({
      overrides: [override({ id: "cohort-wide", scope: "cohort" })],
    });
    expect(ctx.override("cilantro")).toBeNull();
    expect(rejected).toHaveLength(1);
  });
});

describe("override()", () => {
  it("returns the SINGLE narrowest row", () => {
    const { ctx } = buildScopeContext({
      overrides: [
        override({ id: "user", scope: "user", value: "produce" }),
        override({ id: "device", scope: "device", value: "spices" }),
        override({ id: "assoc", scope: "associated", value: "dairy" }),
      ],
    });
    expect(ctx.override("cilantro")?.id).toBe("device");
  });

  it("prefers the stronger rank when two rows share a scope", () => {
    const { ctx } = buildScopeContext({
      overrides: [
        override({ id: "human", scope: "user", rank: "human" }),
        override({ id: "admin", scope: "user", rank: "admin" }),
      ],
    });
    expect(ctx.override("cilantro")?.id).toBe("admin");
  });

  it("returns null for an unknown key", () => {
    const { ctx } = buildScopeContext({ overrides: [override({ id: "a", scope: "user" })] });
    expect(ctx.override("basil")).toBeNull();
  });
});

describe("consumed()", () => {
  it("records every row the run actually read, and nothing it did not", () => {
    const { ctx } = buildScopeContext({
      features: [
        feature({ id: "read-me", scope: "user", nodeId: "classify" }),
        feature({ id: "never-read", scope: "user", nodeId: "table" }),
      ],
      overrides: [override({ id: "o1", scope: "user" })],
    });
    ctx.features("classify");
    ctx.override("cilantro");
    expect(ctx.consumed().sort()).toEqual(["o1", "read-me"]);
  });
});

describe("ids and grants", () => {
  it("exposes them read-only", () => {
    const { ctx } = buildScopeContext({
      ids: { user: "u1", tenant: "t1" },
      grants: ["recipes:read"],
    });
    expect(ctx.ids.user).toBe("u1");
    expect(ctx.grants).toEqual(["recipes:read"]);
    expect(() => {
      (ctx.ids as Record<string, string>).user = "u2";
    }).toThrow();
  });
});
