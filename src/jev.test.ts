import { describe, expect, it } from "vitest";
import {
  JEV_IMAGES_HEADER,
  JEV_LONG_CONTEXT_HEADER,
  JEV_MODEL,
  checkJevRequest,
  jevAnswersToDecideResult,
  jevHeaders,
  jevNeedsImages,
  jevSupportsBox,
} from "./jev";

const mugRequest = {
  model: JEV_MODEL,
  state: { photo: "6e1d0b7c-kitchen" },
  assets: { "6e1d0b7c-kitchen": { type: "image", part: "kitchen-photo" } },
  questions: {
    mug_visible: { type: "noul" as const, instructions: "Is there a coffee mug in `photo`?" },
    mug: { type: "box" as const, instructions: "the coffee mug in `photo`" },
  },
};

describe("jev", () => {
  it("knows which models answer a box", () => {
    expect(JEV_MODEL).toBe("jev-1.14.0");
    expect(jevSupportsBox("jev-1.14.0")).toBe(true);
    expect(jevSupportsBox("jev-1.15.2")).toBe(true);
    expect(jevSupportsBox("jev-preview")).toBe(true);
    expect(jevSupportsBox("jev-latest")).toBe(true);
    expect(jevSupportsBox("jev-1.13.0")).toBe(false);
  });

  it("sends the images header only when an image or a box is in the request", () => {
    expect(jevNeedsImages(mugRequest)).toBe(true);
    expect(jevHeaders("k", mugRequest)).toEqual({ authorization: "Bearer k", [JEV_IMAGES_HEADER]: "true" });
    const textOnly = { questions: { q: { type: "noul" as const, instructions: "Is `note` dry?" } } };
    expect(jevHeaders("k", textOnly)).toEqual({ authorization: "Bearer k" });
    expect(jevHeaders("k", textOnly, { longContext: true })).toEqual({ authorization: "Bearer k", [JEV_LONG_CONTEXT_HEADER]: "true" });
  });

  it("lets images through on 1.13 but refuses a box there, and a box with criteria", () => {
    expect(checkJevRequest(mugRequest)).toEqual([]);
    const imagesOn113 = { ...mugRequest, model: "jev-1.13.0", questions: { mug_visible: mugRequest.questions.mug_visible } };
    expect(checkJevRequest(imagesOn113)).toEqual([]);
    expect(jevNeedsImages(imagesOn113)).toBe(true);
    const problems = checkJevRequest({
      ...mugRequest,
      model: "jev-1.13.0",
      questions: { mug: { type: "box", instructions: "the mug in `photo`", criteria: { a: "b" } } as never },
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/takes no criteria/);
    expect(problems[1]).toMatch(/does not answer box questions/);
  });

  it("maps noul, choice and box answers onto the decide port's result", () => {
    const result = jevAnswersToDecideResult(
      {
        mug_visible: { type: "noul", noul: 0.97 },
        room: { type: "choice", probabilities: { kitchen: 0.8, office: 0.2 } },
        mug: { type: "box", box: { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 }, confidence: 0.92 },
      },
      { usage: { input_tokens: 290, output_tokens: 21 }, costUsd: (u) => (u.input_tokens ?? 0) * 1e-6 },
    );
    expect(result.distributions).toEqual({ mug_visible: [0.97], room: [0.8, 0.2], mug: [0.92] });
    expect(result.distributionOptions).toEqual({ mug_visible: ["true"], room: ["kitchen", "office"], mug: ["confidence"] });
    expect(result.boxes?.mug?.box.left).toBe(0.44);
    expect(result.costUsd).toBeCloseTo(0.00029, 10);
  });
});
