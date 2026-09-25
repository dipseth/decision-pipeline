import { describe, expect, it } from "vitest";
import {
  assignArm,
  mergePatches,
  shadowChallenger,
  widestDirectFeedbackScope,
  type ExperimentSpec,
} from "./experiments";
import { validatePipeline } from "./define";
import { buildScalePipeline } from "./test-fixtures";
import { z } from "zod";
import type { PipelineSpec } from "./define";

const split = (over: Partial<ExperimentSpec> = {}): ExperimentSpec => ({
  id: "gate-0.7-vs-0.6",
  unit: "user",
  mode: "split",
  champion: "control",
  enabled: true,
  arms: {
    control: {},
    b: { thresholds: { gate: { category: 0.6 } } },
  },
  ...over,
});

describe("assignArm", () => {
  it("is the champion until the experiment is enabled — declared is not running", () => {
    expect(assignArm(split({ enabled: false }), "u1").arm).toBe("control");
    expect(assignArm(split({ enabled: false }), "u1").reason).toBe("disabled");
  });

  it("is the champion for the offline modes — they never touch a live run", () => {
    for (const mode of ["replay", "replay-redecide"] as const) {
      expect(assignArm(split({ mode }), "u1").arm).toBe("control");
    }
  });

  it("is the champion when the unit has no id", () => {
    const a = assignArm(split(), undefined);
    expect(a.arm).toBe("control");
    expect(a.reason).toBe("no-unit-id");
  });

  it("is deterministic and recomputable from the recorded hash", () => {
    const first = assignArm(split(), "user-42");
    const second = assignArm(split(), "user-42");
    expect(first).toEqual(second);
    expect(first.hash).toBe("gate-0.7-vs-0.6:user:user-42");
  });

  it("splits roughly evenly across two arms", () => {
    let b = 0;
    for (let i = 0; i < 1000; i += 1) if (assignArm(split(), `u${i}`).arm === "b") b += 1;
    expect(b).toBeGreaterThan(400);
    expect(b).toBeLessThan(600);
  });

  it("honours weights", () => {
    const spec = split({ weights: { control: 9, b: 1 } });
    let b = 0;
    for (let i = 0; i < 2000; i += 1) if (assignArm(spec, `u${i}`).arm === "b") b += 1;
    expect(b).toBeGreaterThan(120);
    expect(b).toBeLessThan(280);
  });

  it("ships the champion in shadow mode — the challenger runs separately", () => {
    const live = assignArm(split({ mode: "shadow" }), "u1");
    expect(live.arm).toBe("control");
    expect(live.ships).toBe(true);

    const challenger = shadowChallenger(split({ mode: "shadow" }), "b", "u1");
    expect(challenger.arm).toBe("b");
    // Without this the first shadow test overwrites production facts.
    expect(challenger.ships).toBe(false);
  });

  it("independent experiments stay orthogonal", () => {
    const a = split({ id: "exp-a" });
    const b = split({ id: "exp-b" });
    let agree = 0;
    for (let i = 0; i < 500; i += 1) {
      if (assignArm(a, `u${i}`).arm === assignArm(b, `u${i}`).arm) agree += 1;
    }
    expect(agree).toBeGreaterThan(200);
    expect(agree).toBeLessThan(300);
  });
});

describe("widestDirectFeedbackScope", () => {
  it("looks only at override and feature forms", () => {
    expect(
      widestDirectFeedbackScope([
        { form: "override", scope: "device" },
        { form: "feature", scope: "user" },
        { form: "queue", scope: "global" },
      ]),
    ).toBe("user");
    expect(widestDirectFeedbackScope([{ form: "score", scope: "global" }])).toBeNull();
  });
});

describe("assignment unit validation", () => {
  const specWith = (unit: ExperimentSpec["unit"]): PipelineSpec<{ id: string }, { ok: boolean }> => ({
    id: "demo",
    fact: "f",
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    trigger: ["on-demand"],
    group: () => "g",
    result: "yes",
    nodes: {
      gate: {
        kind: "code", role: "gate", run: () => "yes",
        branches: ["yes"], thresholds: { category: 0.7 }, version: "1",
      },
      yes: { kind: "code", role: "derive", run: () => ({ ok: true }), version: "1" },
    },
    edges: [{ from: "gate", to: "yes", when: { gate: "gate", branch: "yes" } }],
    feedback: [
      {
        id: "drag", from: "surface:x", to: "gate", source: "implicit",
        scope: "user", form: "override", latency: "immediate",
      },
    ],
    eval: { dataset: "d", gateMetric: "score_positive" },
    experiments: [split({ unit })],
  });

  it("refuses an assignment unit narrower than the widest feedback scope", () => {
    // Otherwise a row written under arm B could be read by an arm-A run.
    expect(validatePipeline(specWith("device")).join("\n")).toContain("contaminate");
  });

  it("accepts the widest feedback scope itself, or wider", () => {
    expect(validatePipeline(specWith("user"))).toEqual([]);
    expect(validatePipeline(specWith("tenant"))).toEqual([]);
  });
});

describe("a variant patches only the declarative half", () => {
  it("accepts a threshold patch on a gate that declares it", () => {
    expect(() => buildScalePipeline({ experiments: [split()] })).not.toThrow();
  });

  it("refuses a threshold the gate never declared", () => {
    expect(() =>
      buildScalePipeline({
        experiments: [split({ arms: { control: {}, b: { thresholds: { gate: { nope: 0.1 } } } } })],
      }),
    ).toThrow(/not a threshold the node declares/);
  });

  it("refuses patching a prompt onto a node that is not a generate node", () => {
    expect(() =>
      buildScalePipeline({
        experiments: [split({ arms: { control: {}, b: { prompts: { table: "p" } } } })],
      }),
    ).toThrow(/not a generate node/);
  });

  it("refuses a guard patch on an edge that does not exist — a variant does not add edges", () => {
    expect(() =>
      buildScalePipeline({
        experiments: [
          split({
            arms: { control: {}, b: { guards: [{ from: "table", to: "writer", when: null }] } },
          }),
        ],
      }),
    ).toThrow(/no such edge/);
  });

  it("refuses an experiment with one arm, or a champion that is not an arm", () => {
    expect(() => buildScalePipeline({ experiments: [split({ arms: { control: {} } })] })).toThrow(
      /at least two arms/,
    );
    expect(() => buildScalePipeline({ experiments: [split({ champion: "ghost" })] })).toThrow(
      /is not one of its arms/,
    );
  });
});

describe("mergePatches", () => {
  it("merges per key and concatenates guards", () => {
    const merged = mergePatches([
      { thresholds: { gate: { category: 0.6 } }, guards: [{ from: "a", to: "b", when: null }] },
      { thresholds: { gate: { tools: 0.9 } }, prompts: { writer: "p2" } },
    ]);
    expect(merged.thresholds).toEqual({ gate: { category: 0.6, tools: 0.9 } });
    expect(merged.prompts).toEqual({ writer: "p2" });
    expect(merged.guards).toHaveLength(1);
  });

  it("lets a later patch win on the same key", () => {
    const merged = mergePatches([
      { thresholds: { gate: { category: 0.6 } } },
      { thresholds: { gate: { category: 0.4 } } },
    ]);
    expect(merged.thresholds?.gate?.category).toBe(0.4);
  });
});
