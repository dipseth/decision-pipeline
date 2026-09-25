import { describe, expect, it } from "vitest";
import { resolveTools, toolNoul } from "./tools";
import { staticRegistry } from "./testing";

const registry = staticRegistry({
  lookup_pan_conversion: "recipes:read",
  lookup_cooking_adjustment: "cook:assist",
  lookup_scaling_rule: null,
  sync_list: "list:sync",
});

describe("toolNoul", () => {
  it("reads the `tool:<name>` key, and a bare name as a fallback", () => {
    expect(toolNoul({ "tool:a": [0.9] }, "a")).toBe(0.9);
    expect(toolNoul({ a: [0.4] }, "a")).toBe(0.4);
    expect(toolNoul({}, "a")).toBeNull();
    expect(toolNoul(undefined, "a")).toBeNull();
  });
});

describe("resolveTools", () => {
  it("offers nothing when the node declares no tools", () => {
    expect(resolveTools({ spec: undefined }).offered).toEqual([]);
  });

  it("resolves `prompt-config` to what the Langfuse prompt says — Langfuse wins", () => {
    const r = resolveTools({
      spec: { static: "prompt-config" },
      promptConfigTools: ["lookup_scaling_rule"],
      registry,
      grants: [],
    });
    expect(r.offered).toEqual(["lookup_scaling_rule"]);
  });

  it("offers static UNION selected, and records the Noul that selected each", () => {
    const r = resolveTools({
      spec: {
        static: ["lookup_scaling_rule"],
        selectable: {
          candidates: ["lookup_pan_conversion", "lookup_cooking_adjustment"],
          from: "classify",
          gate: "gate",
        },
      },
      distributions: {
        "tool:lookup_pan_conversion": [0.81],
        "tool:lookup_cooking_adjustment": [0.12],
      },
      selectThreshold: 0.5,
      registry,
      grants: ["recipes:read", "cook:assist"],
    });
    expect(r.offered).toEqual(["lookup_scaling_rule", "lookup_pan_conversion"]);
    expect(r.selected).toEqual({ lookup_pan_conversion: 0.81 });
  });

  it("selects nothing when the decide node never ran", () => {
    const r = resolveTools({
      spec: {
        selectable: { candidates: ["lookup_pan_conversion"], from: "classify", gate: "gate" },
      },
      distributions: undefined,
      registry,
      grants: ["recipes:read"],
    });
    expect(r.offered).toEqual([]);
    expect(r.selected).toEqual({});
  });

  it("drops a tool whose MCP scope the run was not granted, and records the drop", () => {
    const r = resolveTools({
      spec: { static: ["lookup_pan_conversion", "sync_list", "lookup_scaling_rule"] },
      registry,
      grants: ["recipes:read"],
    });
    // A pipeline running on a user's behalf can never offer a tool wider than
    // that user's grant. `lookup_scaling_rule` needs no scope at all.
    expect(r.offered).toEqual(["lookup_pan_conversion", "lookup_scaling_rule"]);
    expect(r.dropped_for_scope).toEqual(["sync_list"]);
  });

  it("enforces the allow ceiling against a prompt-config set resolved at RUN time", () => {
    const r = resolveTools({
      spec: { static: "prompt-config", allow: ["lookup_scaling_rule"] },
      promptConfigTools: ["lookup_scaling_rule", "sync_list"],
      registry,
      grants: ["list:sync"],
    });
    expect(r.offered).toEqual(["lookup_scaling_rule"]);
    expect(r.dropped_for_allow).toEqual(["sync_list"]);
  });

  it("drops a name the registry does not know", () => {
    const r = resolveTools({
      spec: { static: ["no_such_tool"] },
      registry,
      grants: [],
    });
    expect(r.offered).toEqual([]);
    expect(r.dropped_unknown).toEqual(["no_such_tool"]);
  });

  it("never offers the same tool twice", () => {
    const r = resolveTools({
      spec: {
        static: ["lookup_pan_conversion"],
        selectable: { candidates: ["lookup_pan_conversion"], from: "c", gate: "g" },
      },
      distributions: { "tool:lookup_pan_conversion": [0.99] },
      registry,
      grants: ["recipes:read"],
    });
    expect(r.offered).toEqual(["lookup_pan_conversion"]);
  });
});
