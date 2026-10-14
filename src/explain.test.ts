import { describe, expect, it } from "vitest";
import type { DiagramInput } from "./diagram";
import {
  EXPLAIN_LEVELS,
  explainBrief,
  explainCacheKey,
  explainPipeline,
  explainPrompt,
  explainVersion,
  isExplainLevel,
} from "./explain";

const scale: DiagramInput = {
  id: "scale",
  fact: "scaled_recipe",
  trigger: ["on-demand"],
  result: ["changes"],
  decidedBy: "llm",
  nodes: [
    { id: "classify", kind: "decide", questions: "jev-scale-classify", onFailure: "fallback", version: "3", timeoutMs: 4000 },
    { id: "gate", kind: "code", role: "gate", branches: ["direct", "writer"], thresholds: { direct_line: { env: "X", default: 0.8 } }, version: "1" },
    { id: "direct", kind: "code", role: "derive", describe: "Arithmetic on the table", version: "1" },
    { id: "writer", kind: "generate", prompt: "recipe-scale", route: "scale-writer", version: "7" },
    { id: "persist", kind: "store", target: "turso", scope: "tenant", version: "1" },
  ],
  edges: [
    { from: "classify", to: "gate" },
    { from: "gate", to: "direct", when: { gate: "gate", branch: "direct" } },
    { from: "gate", to: "writer", when: { gate: "gate", branch: "writer" } },
    { from: "direct", to: "persist" },
    { from: "writer", to: "persist" },
  ],
  feedback: [
    { id: "rating", from: "scaling-notes", to: "gate", source: "explicit", scope: "tenant", form: "score", latency: "next-run" },
  ],
  order: ["classify", "gate", "direct", "writer", "persist"],
};

const clone = (): DiagramInput => JSON.parse(JSON.stringify(scale)) as DiagramInput;

describe("explainVersion", () => {
  it("is stable across calls and ignores operational knobs", () => {
    const a = clone();
    const b = clone();
    (b.nodes[0] as Record<string, unknown>).timeoutMs = 9000;
    (b.nodes[0] as Record<string, unknown>).cache = "run";
    expect(explainVersion(a)).toBe(explainVersion(scale));
    expect(explainVersion(b)).toBe(explainVersion(scale));
  });

  it("changes when what the pipeline does changes", () => {
    const describe = clone();
    (describe.nodes[2] as Record<string, unknown>).describe = "Different words";
    const threshold = clone();
    (threshold.nodes[1] as Record<string, unknown>).thresholds = { direct_line: { env: "X", default: 0.5 } };
    const bump = clone();
    (bump.nodes[3] as Record<string, unknown>).version = "8";
    const noFeedback = clone();
    noFeedback.feedback = [];
    const base = explainVersion(scale);
    for (const changed of [describe, threshold, bump, noFeedback]) {
      expect(explainVersion(changed)).not.toBe(base);
    }
  });
});

describe("explainCacheKey", () => {
  it("names pipeline, version, level and language, with the prompt version when given", () => {
    const v = explainVersion(scale);
    expect(explainCacheKey(scale, { level: "eli5" })).toBe(`scale:${v}:eli5:en`);
    expect(explainCacheKey(scale, { level: "expert", language: "pt-BR", promptVersion: 4 })).toBe(
      `scale:${v}:expert:pt:p4`,
    );
  });
});

describe("explainBrief", () => {
  it("walks every node in order with its branch, and the feedback", () => {
    const brief = explainBrief(scale, { title: "Scale", summary: "Resizes a recipe." });
    const at = (s: string) => brief.indexOf(s);
    expect(brief).toContain('Pipeline: Scale (id "scale")');
    expect(brief).toContain("Establishes the fact: scaled_recipe");
    for (const id of scale.order ?? []) expect(brief).toContain(`- ${id} ·`);
    expect(at("- classify")).toBeLessThan(at("- gate"));
    expect(at("- gate")).toBeLessThan(at("- persist"));
    expect(brief).toContain('(reached on branch "writer")');
    expect(brief).toContain("branches: direct | writer");
    expect(brief).toContain("thresholds: direct_line=0.8");
    expect(brief).toContain("on failure: fallback");
    expect(brief).toContain("stores to turso at tenant scope");
    expect(brief).toContain('"scaling-notes" → gate as a score');
  });

  it("says so when there is no feedback", () => {
    const none = clone();
    none.feedback = [];
    expect(explainBrief(none)).toContain("Feedback from people: none");
  });
});

describe("explainPrompt", () => {
  it("has one brief for every level and level-specific instructions", () => {
    const prompts = EXPLAIN_LEVELS.map((level) => explainPrompt(scale, { level }));
    const briefs = new Set(prompts.map((p) => p.user.slice(p.user.indexOf("Brief:"))));
    expect(briefs.size).toBe(1);
    expect(prompts[0]?.user).toContain("five-year-old");
    expect(prompts[3]?.user).toContain("engineer");
    expect(prompts.every((p) => p.system.length > 0)).toBe(true);
  });

  it("asks for the language by name", () => {
    expect(explainPrompt(scale, { level: "eli10", languageName: "Spanish" }).user).toContain("Language: Spanish.");
  });
});

describe("explainPipeline", () => {
  it("runs the host's generate port once and labels the result", async () => {
    const seen: string[] = [];
    const result = await explainPipeline(scale, { level: "eli15" }, async (p) => {
      seen.push(p.user);
      return "  It checks, then picks.  ";
    });
    expect(seen).toHaveLength(1);
    expect(result).toEqual({ pipeline: "scale", level: "eli15", version: explainVersion(scale), text: "It checks, then picks." });
  });
});

describe("isExplainLevel", () => {
  it("accepts the four levels only", () => {
    expect(EXPLAIN_LEVELS.every(isExplainLevel)).toBe(true);
    expect(isExplainLevel("eli99")).toBe(false);
    expect(isExplainLevel(undefined)).toBe(false);
  });
});
