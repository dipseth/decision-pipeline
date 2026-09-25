import { describe, expect, it } from "vitest";
import { runPipeline } from "./run";
import { runShadow } from "./shadow";
import { testPorts } from "./testing";
import { buildScalePipeline, confidentDistributions, type ScaledRecipeT, type ScaleInputT } from "./test-fixtures";
import type { DecisionPipeline } from "./define";

const input: ScaleInputT = {
  recipeId: "r-1",
  factor: 2,
  notes: "",
  substitutionCount: 0,
  ingredients: ["1 cup flour", "1 tsp salt"],
};

const writerOutput: ScaledRecipeT = {
  scaledIngredients: ["2 cup flour", "2 tsp salt"],
  scalingNotes: ["the writer's prose"],
  factor: 2,
  changes: [],
};

/** Jev is confident (0.95), so the champion goes direct. */
const ports = () =>
  testPorts({
    decide: { classify: { distributions: confidentDistributions(2), costUsd: 0.0002 } },
    generate: { writer: { value: writerOutput, costUsd: 0.004 } },
    prompts: { "jev-scale-classify": { version: "12" }, "recipe-scale": { version: "7", tools: [] } },
    scope: { ids: { user: "u-1", tenant: "t-1" }, grants: ["recipes:read"] },
  });

/** The same pipeline with a gate 0.95 cannot clear — a stand-in for a proposed spec. */
const stricter = (): DecisionPipeline<ScaleInputT, ScaledRecipeT> => {
  const base = buildScalePipeline();
  const gate = base.nodes.gate as Extract<(typeof base.nodes)[string], { role: "gate" }>;
  return { ...base, nodes: { ...base.nodes, gate: { ...gate, thresholds: { category: 0.99, tools: 0.5 }, version: "2" } } };
};

describe("runShadow", () => {
  it("ships the champion, keeps the challenger's store from the host, and says where they parted", async () => {
    const p = ports();
    const out = await runShadow({ champion: buildScalePipeline(), challenger: stricter(), input, ports: p, label: "strict", options: { runKey: "job-1" } });

    expect(out.champion.route).toBe("direct");
    expect(out.challenger?.route).toBe("writer");
    // Only the champion's fact reached the host store.
    expect(p.storeWrites).toHaveLength(1);
    expect(p.storeWrites[0]!.writesFact).toBe(true);
    expect(out.challengerStores).toHaveLength(1);
    expect(out.challengerStores[0]!.writesFact).toBe(false);

    expect(out.comparison).toMatchObject({
      sameOutput: false,
      sameRoute: false,
      onlyChampion: ["direct"],
      onlyChallenger: ["writer", "guard"],
      branchChanged: [{ id: "gate", champion: "direct", challenger: "writer" }],
    });
    expect(out.comparison!.costDeltaUsd).toBeCloseTo(0.004);
  });

  it("shares the champion's model answers, so the shadow pays only for what differs", async () => {
    const p = ports();
    const out = await runShadow({ champion: buildScalePipeline(), challenger: stricter(), input, ports: p, label: "strict" });

    expect(p.decideCalls).toHaveLength(1);
    expect(p.generateCalls).toHaveLength(1);
    expect(out.calls).toEqual({ shared: 1, fresh: 1, freshCostUsd: 0.004 });
    // The challenger's record still states what its path costs.
    expect(out.challenger!.record.cost_usd).toBeCloseTo(0.0042);
  });

  it("asks again when sharing is off", async () => {
    const p = ports();
    const out = await runShadow({ champion: buildScalePipeline(), challenger: stricter(), input, ports: p, label: "strict", share: false });
    expect(p.decideCalls).toHaveLength(2);
    expect(out.calls.fresh).toBe(2);
  });

  it("tags the challenger as a shadow and gives it its own run key", async () => {
    const p = ports();
    const out = await runShadow({ champion: buildScalePipeline(), challenger: stricter(), input, ports: p, label: "strict", options: { runKey: "job-1", tags: ["t"] } });

    const [champ, chall] = p.tracer.roots;
    expect(champ!.tags).not.toContain("shadow");
    expect(chall!.tags).toEqual(expect.arrayContaining(["shadow", "challenger:strict", "t"]));
    expect(chall!.metadata).toMatchObject({ writes_fact: false, challenger: "strict", shadow_of: out.champion.runId });
    expect(out.champion.runKey).toBe("job-1");
    expect(out.challenger!.runKey).toBe("job-1:shadow:strict");
  });

  it("never fails the champion when the challenger throws", async () => {
    const base = buildScalePipeline();
    const failing = { ...base, nodes: { ...base.nodes, direct: { ...base.nodes.direct!, run: () => { throw new Error("boom"); } } as never } };
    const out = await runShadow({ champion: buildScalePipeline(), challenger: failing, input, ports: ports(), label: "broken" });
    expect(out.champion.route).toBe("direct");
    expect(out.challenger).toBeNull();
    expect(out.challengerError).toMatch(/boom/);
    expect(out.comparison).toBeNull();
  });
});

describe("RunOptions.shadow", () => {
  it("clears writesFact whatever the arms say", async () => {
    const p = ports();
    await runPipeline(buildScalePipeline(), input, p, { shadow: true });
    expect(p.storeWrites[0]!.writesFact).toBe(false);
    expect(p.tracer.roots[0]!.tags).toContain("shadow");
  });
});
