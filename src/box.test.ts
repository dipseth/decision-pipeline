import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  boxArea,
  boxFromTile,
  boxIoU,
  boxToPixels,
  checkBoxAnswer,
  edgeCheckQuestions,
  expandBoxEdges,
  padBox,
  tileBoxes,
} from "./box";
import { definePipeline, type PipelineSpec } from "./define";
import { runPipeline } from "./run";
import { testPorts } from "./testing";
import type { Box, BoxAnswer } from "./types";

const MUG: Box = { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 };

describe("box geometry", () => {
  it("accepts the docs' mug and names what is wrong with a bad box", () => {
    expect(checkBoxAnswer({ box: MUG, confidence: 0.92 })).toBeNull();
    expect(checkBoxAnswer({ box: { ...MUG, left: 0.9 }, confidence: 0.9 })).toMatch(/left 0.9 is not less than right/);
    expect(checkBoxAnswer({ box: { ...MUG, bottom: 1.2 }, confidence: 0.9 })).toMatch(/bottom 1.2 is not in 0..1/);
    expect(checkBoxAnswer({ box: MUG, confidence: 2 })).toMatch(/confidence/);
    expect(checkBoxAnswer({ confidence: 0.5 })).toBe("no box");
  });

  it("converts to pixels in PIL crop order", () => {
    expect(boxToPixels(MUG, 960, 654)).toEqual({ left: 422, top: 164, right: 806, bottom: 536 });
  });

  it("pads outward and stays inside the image", () => {
    const padded = padBox({ top: 0.02, bottom: 0.99, left: 0.3, right: 0.6 }, 0.05);
    expect(padded).toEqual({ top: 0, bottom: 1, left: expect.closeTo(0.25, 10), right: expect.closeTo(0.65, 10) });
  });

  it("scores overlap as IoU", () => {
    expect(boxIoU(MUG, MUG)).toBeCloseTo(1, 10);
    expect(boxIoU(MUG, { top: 0, bottom: 0.1, left: 0, right: 0.1 })).toBe(0);
    const half = { ...MUG, right: (MUG.left + MUG.right) / 2 };
    expect(boxIoU(MUG, half)).toBeCloseTo(0.5, 10);
  });

  it("tiles the image and maps a box on a tile back to the full image", () => {
    const tiles = tileBoxes(2, 2);
    expect(Object.keys(tiles)).toEqual(["r0c0", "r0c1", "r1c0", "r1c1"]);
    const full = boxFromTile(tiles.r1c1!, { top: 0, bottom: 0.5, left: 0.5, right: 1 });
    expect(full).toEqual({ top: 0.5, bottom: 0.75, left: 0.75, right: 1 });
    expect(boxArea(full)).toBeCloseTo(0.0625, 10);
    expect(() => tileBoxes(0, 2)).toThrow(/positive integers/);
  });

  it("writes one Noul per edge and moves out the edges the target continues past", () => {
    const qs = edgeCheckQuestions("the mug", "crop");
    expect(Object.keys(qs)).toEqual(["past_top", "past_bottom", "past_left", "past_right"]);
    expect(qs.past_left?.instructions).toBe("Does the mug in `crop` continue past the left edge of the image?");

    const { box, moved } = expandBoxEdges(MUG, { left: 0.8, right: 0.3, top: 0.7, bottom: 0.99 }, 0.6, 0.05);
    expect(moved).toEqual(["top", "bottom", "left"]);
    expect(box.left).toBeCloseTo(0.39, 10);
    expect(box.right).toBe(MUG.right);
    // An edge already at the image's border cannot move, and is not reported as moved.
    expect(expandBoxEdges({ ...MUG, top: 0 }, { top: 0.9 }, 0.5, 0.1).moved).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A Box inside a pipeline: the Noul says whether it is there, the Box says
// where, the gate decides on both confidences, code crops.
// ---------------------------------------------------------------------------

const Input = z.object({ id: z.string(), width: z.number(), height: z.number() });
type In = z.infer<typeof Input>;
const Output = z.object({ crop: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }).nullable() });
type Out = z.infer<typeof Output>;

type Located = { visible: number; mug: BoxAnswer | undefined };

const spec = (seen: { boxes?: Readonly<Record<string, BoxAnswer>> } = {}): PipelineSpec<In, Out> => ({
  id: "mug-finder",
  fact: "mug_crop",
  input: Input,
  output: Output,
  trigger: ["on-demand"],
  group: (i) => `photo-${i.id}`,
  result: ["crop", "pad_crop", "none"],
  nodes: {
    locate: {
      kind: "decide",
      questions: "jev-mug-locate",
      state: ["photo"],
      interpret: (d, _args, boxes): Located => {
        seen.boxes = boxes;
        return { visible: d.mug_visible?.[0] ?? 0, mug: boxes.mug };
      },
      version: "1",
    },
    gate: {
      kind: "code",
      role: "gate",
      run: ({ primary, thresholds }) => {
        const { visible, mug } = primary as Located;
        if (visible < thresholds.visible! || !mug) return { branch: "none", reason: `mug_visible ${visible}` };
        return mug.confidence >= thresholds.box!
          ? { branch: "crop", confidence: mug.confidence }
          : { branch: "pad_crop", reason: `box confidence ${mug.confidence}`, confidence: mug.confidence };
      },
      branches: ["crop", "pad_crop", "none"],
      thresholds: { visible: 0.5, box: 0.6 },
      version: "1",
    },
    crop: {
      kind: "code",
      role: "derive",
      // A gate passes its primary input through: this is `locate`'s value.
      run: ({ primary, input }) => ({ crop: boxToPixels((primary as Located).mug!.box, input.width, input.height) }),
      version: "1",
    },
    pad_crop: {
      kind: "code",
      role: "derive",
      thresholds: { pad: 0.05 },
      run: ({ primary, input, thresholds }) => ({
        crop: boxToPixels(padBox((primary as Located).mug!.box, thresholds.pad!), input.width, input.height),
      }),
      version: "1",
    },
    none: { kind: "code", role: "derive", run: () => ({ crop: null }), version: "1" },
    persist: { kind: "store", target: "memory", scope: "user", version: "1" },
  },
  edges: [
    { from: "locate", to: "gate" },
    { from: "gate", to: "crop", when: { gate: "gate", branch: "crop" } },
    { from: "gate", to: "pad_crop", when: { gate: "gate", branch: "pad_crop" } },
    { from: "gate", to: "none", when: { gate: "gate", branch: "none" } },
    { from: "crop", to: "persist" },
    { from: "pad_crop", to: "persist" },
    { from: "none", to: "persist" },
  ],
  feedback: [
    {
      id: "redraw",
      from: "surface:crop-editor",
      to: "gate",
      source: "explicit",
      scope: "user",
      form: "score",
      latency: "deferred",
      score: { name: "crop_iou", dataType: "NUMERIC" },
    },
  ],
  eval: { dataset: "mug-eval", gateMetric: "score_positive" },
});

const photo = { id: "p1", width: 960, height: 654 };

describe("runPipeline with Box answers", () => {
  it("records the box, mirrors its confidence for the gate, and adds geometry features", async () => {
    const seen: Parameters<typeof spec>[0] = {};
    const ports = testPorts({
      decide: { locate: { distributions: { mug_visible: [0.97] }, boxes: { mug: { box: MUG, confidence: 0.92 } } } },
    });
    const { output, record, route } = await runPipeline(definePipeline(spec(seen)), photo, ports);

    expect(route).toBe("crop");
    expect(output.crop).toEqual({ left: 422, top: 164, right: 806, bottom: 536 });
    const node = record.nodes.find((n) => n.id === "locate")!;
    expect(node.boxes).toEqual({ mug: { box: MUG, confidence: 0.92 } });
    expect(node.distributions?.mug).toEqual([0.92]);
    expect(node.distribution_options?.mug).toEqual(["confidence"]);
    expect(seen.boxes?.mug?.confidence).toBe(0.92);
    expect(record.features["locate.mug.top"]).toBe(0.92);
    expect(record.features["locate.mug.box_area"]).toBeCloseTo(0.4 * 0.57, 10);
    expect(record.features["locate.mug.box_cx"]).toBeCloseTo(0.64, 10);
  });

  it("pads a low-confidence box, and ignores the box when the Noul says it is absent", async () => {
    const low = testPorts({
      decide: { locate: { distributions: { mug_visible: [0.9] }, boxes: { mug: { box: MUG, confidence: 0.4 } } } },
    });
    const padded = await runPipeline(definePipeline(spec()), photo, low);
    expect(padded.route).toBe("pad_crop");
    expect(padded.output.crop).toEqual({ left: 374, top: 131, right: 854, bottom: 569 });

    const absent = testPorts({
      decide: { locate: { distributions: { mug_visible: [0.1] }, boxes: { mug: { box: MUG, confidence: 0.95 } } } },
    });
    const none = await runPipeline(definePipeline(spec()), photo, absent);
    expect(none.route).toBe("none");
    expect(none.record.nodes.find((n) => n.id === "gate")?.branch_reason).toBe("mug_visible 0.1");
  });

  it("fails the node on a box whose edges cross", async () => {
    const ports = testPorts({
      decide: { locate: { distributions: { mug_visible: [0.9] }, boxes: { mug: { box: { ...MUG, top: 0.9 }, confidence: 0.9 } } } },
    });
    await expect(runPipeline(definePipeline(spec()), photo, ports)).rejects.toThrow(/bad box answer: mug \(top 0.9 is not less than bottom/);
  });

  it("keeps a decide node's value shape and hands the edges on as `args.boxes`", async () => {
    let seen: { primary?: unknown; boxes?: unknown } = {};
    const pipeline = definePipeline({
      ...spec(),
      nodes: {
        ...spec().nodes,
        locate: { kind: "decide", questions: "jev-mug-locate", version: "1" },
        gate: {
          kind: "code",
          role: "gate",
          run: ({ primary, boxes, thresholds }) => {
            seen = { primary, boxes };
            const d = primary as Record<string, number[]>;
            return d.mug_visible![0]! >= thresholds.visible! && d.mug![0]! >= thresholds.box! ? "crop" : "none";
          },
          branches: ["crop", "pad_crop", "none"],
          thresholds: { visible: 0.5, box: 0.6 },
          version: "1",
        },
        crop: {
          kind: "code",
          role: "derive",
          run: ({ boxes, input }) => ({ crop: boxToPixels(boxes.locate!.mug!.box, input.width, input.height) }),
          version: "1",
        },
      },
    });
    const ports = testPorts({
      decide: { locate: { distributions: { mug_visible: [0.97] }, boxes: { mug: { box: MUG, confidence: 0.92 } } } },
    });
    const { output } = await runPipeline(pipeline, photo, ports);
    expect(seen.primary).toEqual({ mug_visible: [0.97], mug: [0.92] });
    expect(seen.boxes).toEqual({ locate: { mug: { box: MUG, confidence: 0.92 } } });
    expect(output.crop).toEqual({ left: 422, top: 164, right: 806, bottom: 536 });
  });
});
