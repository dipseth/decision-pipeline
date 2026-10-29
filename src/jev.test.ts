import { describe, expect, it } from "vitest";
import {
  JEV_IMAGES_HEADER,
  JEV_LONG_CONTEXT_HEADER,
  JEV_MODEL,
  checkJevRequest,
  jevAnswersToDecideResult,
  jevExtraHeaders,
  jevHeaders,
  jevNeedsImages,
  jevResponseToDecideResult,
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

  // @typesafe-ai/sdk objects, faked by shape: the helpers never import the SDK.
  const sdkImage = () => ({ type: "image" as const, data: new Uint8Array([0xff, 0xd8, 0xff]), toJSON: () => "<asset:1>" });
  const sdkText = (text: string, assets: unknown[]) => ({ text, assets, toJSON: () => text });

  it("reads SDK requests: images placed in state, in questions, in withAssets text, or in assets", () => {
    const textOnly = { q: { type: "noul", instructions: "Is `note` dry?" } };
    expect(jevExtraHeaders({ questions: textOnly, state: { note: "wet" } })).toEqual({});
    expect(jevExtraHeaders({ questions: textOnly }, { longContext: true })).toEqual({ [JEV_LONG_CONTEXT_HEADER]: "true" });
    expect(jevExtraHeaders({ questions: textOnly }, { images: true })).toEqual({ [JEV_IMAGES_HEADER]: "true" });
    const needs = { [JEV_IMAGES_HEADER]: "true" };
    expect(jevExtraHeaders({ questions: textOnly, state: { claim: "chipped rim", photo: sdkImage() } })).toEqual(needs);
    expect(jevExtraHeaders({ questions: { q: { type: "noul", instructions: ["Is this damaged?", sdkImage()] } } })).toEqual(needs);
    expect(jevExtraHeaders({ questions: textOnly, state: sdkText("A seller uploaded <asset:1>.", [sdkImage()]) })).toEqual(needs);
    expect(jevNeedsImages({ questions: textOnly, assets: { "<photo>": sdkImage() } })).toBe(true);
    // A plain object with `data` is not an image.
    expect(jevNeedsImages({ questions: textOnly, state: { type: "image", data: "x" } })).toBe(false);
  });

  it("checks SDK box questions: content instructions pass, a missing one is flagged, no model is no version check", () => {
    expect(checkJevRequest({ model: JEV_MODEL, questions: { mug: { type: "box", instructions: ["the mug in", sdkImage()] } } })).toEqual([]);
    expect(checkJevRequest({ questions: { mug: { type: "box" } } })[0]).toMatch(/needs instructions/);
    expect(checkJevRequest({ questions: { mug: { type: "box", instructions: "the mug" } } })).toEqual([]);
  });

  it("maps an SDK systemOne result, dropping null usage counts", () => {
    const seen: unknown[] = [];
    const result = jevResponseToDecideResult(
      {
        answers: {
          mug_visible: { type: "noul", noul: 0.97 },
          urgency: { type: "score", score: 1.7, probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 } },
          mug: { type: "box", box: { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 }, confidence: 0.92 },
        },
        usage: { input_tokens: 290, output_tokens: null },
      },
      { costUsd: (u) => (seen.push(u), (u.input_tokens ?? 0) * 1e-6) },
    );
    expect(result.distributions).toEqual({ mug_visible: [0.97], urgency: [0.1, 0.1, 0.8], mug: [0.92] });
    expect(result.distributionOptions).toEqual({ mug_visible: ["true"], urgency: ["0", "1", "2"], mug: ["confidence"] });
    expect(seen).toEqual([{ input_tokens: 290 }]);
    expect(result.costUsd).toBeCloseTo(0.00029, 10);
  });
});
