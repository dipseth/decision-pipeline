import { describe, expect, it } from "vitest";
import { jsonataEngine } from "./jsonata";
import { diffSpecs, extractSpecJson, proposePipelineSpec, specVocabulary, type AuthorRequest } from "./propose";
import type { PipelineSpecJSON } from "./spec";
import { demoRegistry as registry, demoSpec as base } from "./test-fixtures";

const engine = jsonataEngine();

/** An author that replies from a script, one entry per round, and keeps what it was asked. */
const scripted = (replies: unknown[]) => {
  const seen: AuthorRequest[] = [];
  const author = async (r: AuthorRequest) => {
    seen.push(r);
    return replies[r.round - 1];
  };
  return { author, seen };
};

const fenced = (spec: unknown): string => "Raise the bar for loud.\n\n```json\n" + JSON.stringify(spec) + "\n```";

/** The goal's answer: a stricter gate. */
const stricter = (): PipelineSpecJSON => {
  const s = base();
  s.nodes.gate = { ...s.nodes.gate, thresholds: { p: 0.9 }, version: "2" } as PipelineSpecJSON["nodes"][string];
  return s;
};

describe("proposePipelineSpec", () => {
  it("accepts a first-round spec that compiles and changes something", async () => {
    const { author, seen } = scripted([fenced(stricter())]);
    const out = await proposePipelineSpec({ goal: "only shout when p >= 0.9", registry, engine, author, base: base() });
    expect(out.problems).toEqual([]);
    expect(out.pipeline?.id).toBe("spec-demo");
    expect(out.rounds).toHaveLength(1);
    expect(out.diff).toEqual({ nodes: { added: [], removed: [], changed: ["gate"] }, edges: { added: [], removed: [] }, fields: [] });
    // The system prompt carries the catalog; the first prompt carries the goal and the base.
    expect(seen[0]!.system).toContain("demo.shout@1");
    expect(seen[0]!.prompt).toContain("only shout when p >= 0.9");
    expect(seen[0]!.prompt).toContain('"spec-demo"');
  });

  it("feeds every compile problem back and accepts the repair", async () => {
    const broken = stricter();
    broken.nodes.loud = { ...broken.nodes.loud, call: "demo.whisper@1" } as PipelineSpecJSON["nodes"][string];
    broken.nodes.plain = { ...broken.nodes.plain, expr: "bundle.title" } as PipelineSpecJSON["nodes"][string];
    const { author, seen } = scripted([fenced(broken), fenced(stricter())]);
    const out = await proposePipelineSpec({ goal: "stricter", registry, engine, author, base: base() });
    expect(out.pipeline).not.toBeNull();
    expect(out.rounds.map((r) => r.problems.length)).toEqual([2, 0]);
    expect(seen[1]!.round).toBe(2);
    expect(seen[1]!.prompt).toMatch(/unknown primitive "demo\.whisper@1"/);
    expect(seen[1]!.prompt).toMatch(/reads `bundle`.*read as `gate`/);
    expect(seen[1]!.prompt).toContain('"demo.whisper@1"'); // its previous spec, verbatim
    expect(seen[1]!.system).toBe(seen[0]!.system);
  });

  it("holds the base's contract and the host's vocabulary", async () => {
    const drifted = stricter();
    drifted.fact = "shouting";
    drifted.nodes.persist = { kind: "store", target: "postgres", scope: "user", version: "1" };
    const { author } = scripted([fenced(drifted)]);
    const out = await proposePipelineSpec({ goal: "g", registry, engine, author, base: base(), maxRounds: 1 });
    expect(out.pipeline).toBeNull();
    expect(out.problems).toEqual([
      'nodes.persist: unknown store target "postgres" — the host handles only "memory"',
      expect.stringMatching(/^fact: must stay "demo"/),
    ]);
  });

  it("refuses a proposal identical to the base", async () => {
    const { author } = scripted([fenced(base())]);
    const out = await proposePipelineSpec({ goal: "g", registry, engine, author, base: base(), maxRounds: 1 });
    expect(out.problems).toEqual(["the proposal is identical to the base — change something toward the goal"]);
  });

  it("repairs a reply with no JSON, and gives up after maxRounds", async () => {
    const { author, seen } = scripted(["I would raise the threshold.", "still no json", "nor here"]);
    const out = await proposePipelineSpec({ goal: "g", registry, engine, author, base: base() });
    expect(out.rounds).toHaveLength(3);
    expect(out.spec).toBeNull();
    expect(out.problems[0]).toMatch(/no JSON object found/);
    expect(seen[1]!.prompt).toContain("(none — the reply held no JSON object)");
  });

  it("without a base, only the compiler judges", async () => {
    const fresh = { ...stricter(), fact: "anything" };
    const { author } = scripted([fresh]);
    const out = await proposePipelineSpec({ goal: "g", registry, engine, author });
    expect(out.problems).toEqual([]);
    expect(out.diff).toBeNull();
  });
});

describe("helpers", () => {
  it("extractSpecJson prefers the last fenced block and reports bad JSON", () => {
    expect(extractSpecJson('```json\n{"a":1}\n```\ntext\n```json\n{"b":2}\n```')).toEqual({ value: { b: 2 } });
    expect(extractSpecJson('here: {"a": 1} done')).toEqual({ value: { a: 1 } });
    expect(extractSpecJson("```json\n{nope}\n```")).toMatchObject({ problem: expect.stringMatching(/does not parse/) });
    expect(extractSpecJson("```json\n[1]\n```")).toMatchObject({ problem: expect.stringMatching(/not an object/) });
  });

  it("specVocabulary and diffSpecs", () => {
    expect(specVocabulary(base())).toEqual({ prompts: [], routes: [], questions: [], targets: ["memory"] });
    const next = base();
    delete (next.nodes as Record<string, unknown>).check;
    next.edges = next.edges.filter((e) => e.to !== "check" && e.from !== "check");
    next.edges.push({ from: "loud", to: "persist" }, { from: "plain", to: "persist" });
    next.trigger = ["cron"];
    expect(diffSpecs(base(), next)).toEqual({
      nodes: { added: [], removed: ["check"], changed: [] },
      edges: {
        added: ["loud -> persist", "plain -> persist"],
        removed: ["loud -> check", "plain -> check", "check -> persist"],
      },
      fields: ["trigger"],
    });
  });
});
