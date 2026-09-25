/**
 * Thresholds on a transform (added for Break it down, #321).
 *
 * `apply` turns Jev's Nouls into cuts at seven thresholds and never branches.
 * Before this, only a gate could own a threshold, so those numbers were module
 * constants a replay could not see or re-tune. These tests pin the rule that a
 * transform's thresholds behave exactly like a gate's.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { definePipeline, validatePatch } from "./define";
import { runPipeline } from "./run";
import { testPorts } from "./testing";

const Input = z.object({ p: z.number() });
type InputT = z.infer<typeof Input>;

const build = () =>
  definePipeline<InputT, { kept: boolean }>({
    id: "transform-thresholds",
    fact: "kept",
    input: Input,
    output: z.object({ kept: z.boolean() }),
    trigger: ["on-demand"],
    group: () => "g",
    result: ["apply"],
    nodes: {
      apply: {
        kind: "code",
        role: "transform",
        thresholds: { keep: { env: "TT_KEEP_P", default: 0.5 } },
        run: (args) => ({ kept: args.input.p >= args.thresholds.keep! }),
        version: "1",
      },
      gate: { kind: "code", role: "gate", thresholds: {}, branches: ["done"], run: () => "done", version: "1" },
      sink: { kind: "code", role: "derive", run: (args) => args.primary, version: "1" },
    },
    edges: [
      { from: "apply", to: "gate" },
      { from: "gate", to: "sink", when: { gate: "gate", branch: "done" } },
    ],
    feedback: [
      {
        id: "vote",
        from: "surface:test",
        to: "apply",
        source: "explicit",
        scope: "user",
        form: "score",
        latency: "deferred",
        score: { name: "tt_vote", dataType: "NUMERIC" },
      },
    ],
    eval: { dataset: "tt", gateMetric: "score_positive" },
  });

describe("a transform may own thresholds", () => {
  it("hands the resolved number to the body and records it on the node", async () => {
    const run = await runPipeline(build(), { p: 0.6 }, testPorts());
    expect(run.output).toEqual({ kept: true });
    expect(run.record.nodes.find((n) => n.id === "apply")?.thresholds).toEqual({ keep: 0.5 });
  });

  it("reads the env override the same way a gate does", async () => {
    const run = await runPipeline(build(), { p: 0.6 }, testPorts({ env: { TT_KEEP_P: "0.7" } }));
    expect(run.output).toEqual({ kept: false });
    expect(run.record.nodes.find((n) => n.id === "apply")?.thresholds).toEqual({ keep: 0.7 });
  });

  it("is patchable by a replay, and the patch moves the version", async () => {
    const base = await runPipeline(build(), { p: 0.6 }, testPorts());
    const tuned = await runPipeline(build(), { p: 0.6 }, testPorts(), {
      patch: { thresholds: { apply: { keep: 0.9 } } },
    });
    expect(tuned.output).toEqual({ kept: false });
    expect(tuned.patchApplied).toEqual(["apply.thresholds.keep=0.9"]);
    expect(tuned.version).not.toBe(base.version);
  });

  it("refuses a patch naming a threshold the transform never declared", () => {
    const problems = validatePatch(build(), { thresholds: { apply: { nope: 1 } } });
    expect(problems.join("\n")).toContain('"apply.nope" is not a threshold the node declares');
  });

  it("still refuses a thresholds patch on a transform that declares none", () => {
    const problems = validatePatch(build(), { thresholds: { sink: { x: 1 } } });
    expect(problems.join("\n")).toContain("not a code node that declares thresholds");
  });

  it("exports the thresholds in toJSON", () => {
    const apply = build().toJSON().nodes.find((n) => n.id === "apply");
    expect(apply?.thresholds).toEqual({ keep: { env: "TT_KEEP_P", default: 0.5 } });
  });
});
