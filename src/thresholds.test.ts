import { describe, expect, it } from "vitest";
import { resolveThreshold, resolveThresholds, thresholdValues } from "./thresholds";

describe("resolveThreshold", () => {
  it("passes a literal straight through", async () => {
    expect(await resolveThreshold(0.7)).toEqual({ value: 0.7, source: "literal" });
  });

  it("reads an env override and records where it came from", async () => {
    const r = await resolveThreshold(
      { env: "RECIPES_SCALE_CATEGORY_GATE", default: 0.7 },
      { env: () => "0.6" },
    );
    expect(r).toEqual({ value: 0.6, source: "env", ref: "RECIPES_SCALE_CATEGORY_GATE" });
  });

  it("falls back to the default when env is unset, empty or not a number", async () => {
    for (const raw of [undefined, "", "   ", "not-a-number"]) {
      const r = await resolveThreshold({ env: "X", default: 0.7 }, { env: () => raw });
      expect(r).toEqual({ value: 0.7, source: "default", ref: "X" });
    }
  });

  it("reads a Langfuse prompt-config value", async () => {
    const r = await resolveThreshold(
      { promptConfig: "direct_gate", default: 0.7 },
      { promptConfig: async () => 0.45 },
    );
    expect(r).toEqual({ value: 0.45, source: "prompt-config", ref: "direct_gate" });
  });

  it("falls back when the prompt config has no such key", async () => {
    const r = await resolveThreshold(
      { promptConfig: "missing", default: 0.7 },
      { promptConfig: () => undefined },
    );
    expect(r.source).toBe("default");
    expect(r.value).toBe(0.7);
  });

  it("resolves a whole set and flattens it to numbers for a gate body", async () => {
    const resolved = await resolveThresholds(
      { category: { env: "GATE", default: 0.7 }, tools: 0.5 },
      { env: () => "0.8" },
    );
    expect(thresholdValues(resolved)).toEqual({ category: 0.8, tools: 0.5 });
  });
});
