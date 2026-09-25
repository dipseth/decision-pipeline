import { describe, expect, it } from "vitest";
import { z } from "zod";
import { definePipeline, validatePipeline, type PipelineSpec } from "./define";
import { PipelineContractError } from "./errors";
import { buildScalePipeline, SCALE_LINE_LANE } from "./test-fixtures";

const noop = () => ({ ok: true });

/** The smallest manifest that satisfies the contract. Each test breaks ONE clause. */
const base = (): PipelineSpec<{ id: string }, { ok: boolean }> => ({
  id: "demo",
  fact: "demo_fact",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
  trigger: ["on-demand"],
  group: (i) => `demo-${i.id}`,
  result: "yes",
  nodes: {
    gate: {
      kind: "code",
      role: "gate",
      run: () => "yes",
      branches: ["yes", "no"],
      thresholds: { t: 0.5 },
      version: "1",
    },
    yes: { kind: "code", role: "derive", run: noop, version: "1" },
    no: { kind: "code", role: "derive", run: noop, version: "1" },
  },
  edges: [
    { from: "gate", to: "yes", when: { gate: "gate", branch: "yes" } },
    { from: "gate", to: "no", when: { gate: "gate", branch: "no" } },
  ],
  feedback: [
    {
      id: "rating",
      from: "surface:demo",
      to: "gate",
      source: "explicit",
      scope: "user",
      form: "score",
      latency: "deferred",
      score: { name: "demo_score", dataType: "NUMERIC" },
    },
  ],
  eval: { dataset: "demo-eval", gateMetric: "score_positive" },
});

const problemsFor = (mutate: (spec: ReturnType<typeof base>) => void): string[] => {
  const spec = base();
  mutate(spec);
  return validatePipeline(spec);
};

describe("a manifest that satisfies the contract", () => {
  it("loads, and the doc's worked example loads too", () => {
    expect(validatePipeline(base())).toEqual([]);
    expect(() => buildScalePipeline()).not.toThrow();
  });

  it("exposes a topological order and a plain-data export", () => {
    const scale = buildScalePipeline();
    expect(scale.order.indexOf("classify")).toBeLessThan(scale.order.indexOf("gate"));

    const json = scale.toJSON();
    expect(json.id).toBe("scale");
    expect(json.fact).toBe("scaled_recipe");
    expect(json.nodes.map((n) => n.id)).toContain("writer");
    // YAML/JSON is an EXPORT: no function survives into it.
    expect(JSON.stringify(json)).not.toContain("function");
    expect(json.feedback.every((f) => typeof f.key === "boolean")).toBe(true);
  });

  it("defaults decidedBy to llm and normalises result to a list", () => {
    const p = definePipeline(base());
    expect(p.decidedBy).toBe("llm");
    expect(p.result).toEqual(["yes"]);
  });

  it("throws a PipelineContractError listing EVERY problem, not just the first", () => {
    const spec = base();
    spec.feedback = [];
    spec.nodes = { only: { kind: "code", role: "derive", run: noop, version: "1" } };
    spec.edges = [];
    spec.result = "only";
    try {
      definePipeline(spec);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineContractError);
      const problems = (err as PipelineContractError).problems;
      expect(problems.length).toBeGreaterThan(1);
      expect(problems.join("\n")).toContain("no gate node");
      expect(problems.join("\n")).toContain("no feedback edge");
    }
  });
});

describe("clause 2 — at least one code gate", () => {
  it("rejects a chain", () => {
    const problems = problemsFor((spec) => {
      spec.nodes = { yes: { kind: "code", role: "derive", run: noop, version: "1" } };
      spec.edges = [];
    });
    expect(problems.join("\n")).toContain("not a decision pipeline");
  });

  it("refuses a guard on a node that is not a gate", () => {
    const problems = problemsFor((spec) => {
      spec.nodes.reader = { kind: "read", load: noop, version: "1" };
      spec.edges.push({ from: "reader", to: "yes", when: { gate: "reader", branch: "yes" } });
    });
    expect(problems.join("\n")).toContain("only a code gate may branch");
  });

  it("refuses a branch the gate never declared", () => {
    const problems = problemsFor((spec) => {
      spec.edges[0] = { from: "gate", to: "yes", when: { gate: "gate", branch: "maybe" } };
    });
    expect(problems.join("\n")).toContain('has no branch "maybe"');
  });
});

describe("clause 3 — every branch has somewhere to go", () => {
  it("rejects a declared branch with no outbound edge", () => {
    const problems = problemsFor((spec) => {
      spec.edges = [{ from: "gate", to: "yes", when: { gate: "gate", branch: "yes" } }];
    });
    expect(problems.join("\n")).toContain('branch "no" with no outbound edge');
  });
});

describe("clause 4 — a feedback edge, landing on a real node", () => {
  it("rejects a pipeline with none", () => {
    expect(problemsFor((s) => { s.feedback = []; }).join("\n")).toContain("no feedback edge");
  });

  it("rejects an edge landing nowhere", () => {
    const problems = problemsFor((s) => {
      s.feedback[0]!.to = "ghost";
    });
    expect(problems.join("\n")).toContain('lands on unknown node "ghost"');
  });

  it("rejects duplicate feedback ids", () => {
    const problems = problemsFor((s) => {
      s.feedback.push({ ...s.feedback[0]!, to: "gate" });
    });
    expect(problems.join("\n")).toContain("duplicate feedback edge id");
  });
});

describe("the form x scope rule", () => {
  it.each(["tenant", "cohort", "global"] as const)(
    "refuses an override at %s",
    (scope) => {
      const problems = problemsFor((s) => {
        s.feedback[0] = { ...s.feedback[0]!, form: "override", scope };
      });
      expect(problems.join("\n")).toContain("only queue / derived / score");
    },
  );

  it.each(["session", "device", "user", "associated"] as const)(
    "allows a feature at %s",
    (scope) => {
      const problems = problemsFor((s) => {
        s.feedback[0] = { ...s.feedback[0]!, form: "feature", scope };
      });
      expect(problems).toEqual([]);
    },
  );

  it("requires a review queue for `derived` — a structural change is never silent drift", () => {
    const problems = problemsFor((s) => {
      s.feedback[0] = { ...s.feedback[0]!, form: "derived", scope: "tenant" };
    });
    expect(problems.join("\n")).toContain("promoteVia");
  });

  it("requires a queue name for `queue`", () => {
    const problems = problemsFor((s) => {
      s.feedback[0] = { ...s.feedback[0]!, form: "queue" };
    });
    expect(problems.join("\n")).toContain("promoteVia");
  });
});

describe("clause 6 — separability", () => {
  it("refuses `overridable` with nothing persisting the pipeline's own answer", () => {
    const problems = problemsFor((s) => {
      s.overridable = { scope: "device", key: () => "k" };
    });
    expect(problems.join("\n")).toContain("not separable");
  });

  it("accepts it once a store node exists", () => {
    const problems = problemsFor((s) => {
      s.overridable = { scope: "device", key: () => "k" };
      s.nodes.persist = { kind: "store", target: "qdrant", scope: "tenant", version: "1" };
      s.edges.push({ from: "yes", to: "persist" });
    });
    expect(problems).toEqual([]);
  });
});

describe("structure", () => {
  it("rejects a cycle", () => {
    const problems = problemsFor((s) => {
      s.edges.push({ from: "yes", to: "gate" });
    });
    expect(problems.join("\n")).toContain("cycle");
  });

  it("rejects an edge to a node that does not exist", () => {
    const problems = problemsFor((s) => {
      s.edges.push({ from: "yes", to: "ghost" });
    });
    expect(problems.join("\n")).toContain('unknown node "ghost"');
  });

  it("refuses a result that names the store node rather than the producer", () => {
    const problems = problemsFor((s) => {
      s.nodes.persist = { kind: "store", target: "qdrant", scope: "tenant", version: "1" };
      s.edges.push({ from: "yes", to: "persist" });
      s.result = "persist";
    });
    expect(problems.join("\n")).toContain("not the one that writes it");
  });

  it("refuses onFailure fallback with no fallback body, and a cached store node", () => {
    const problems = problemsFor((s) => {
      s.nodes.yes = { kind: "code", role: "derive", run: noop, version: "1", onFailure: "fallback" };
      s.nodes.persist = {
        kind: "store", target: "qdrant", scope: "tenant", version: "1", cache: "per-key-forever",
      };
      s.edges.push({ from: "yes", to: "persist" });
    });
    expect(problems.join("\n")).toContain("needs a `fallback` body");
    expect(problems.join("\n")).toContain("a cached write is a missing write");
  });
});

describe("Langfuse backing", () => {
  it("refuses a `score` edge that names no Langfuse score", () => {
    const problems = problemsFor((s) => {
      delete s.feedback[0]!.score;
    });
    expect(problems.join("\n")).toContain("no Langfuse score to land on");
  });

  it("refuses a CATEGORICAL config with no categories, and categories on a NUMERIC one", () => {
    expect(
      problemsFor((s) => {
        s.feedback[0]!.score = { name: "c", dataType: "CATEGORICAL" };
      }).join("\n"),
    ).toContain("declares no categories");

    expect(
      problemsFor((s) => {
        s.feedback[0]!.score = {
          name: "c", dataType: "NUMERIC", categories: [{ label: "ok", value: 1 }],
        };
      }).join("\n"),
    ).toContain("declares categories but is NUMERIC");
  });

  it("refuses an unregistered review LANE — queues are capped, so a queue per pipeline cannot work", () => {
    const problems = problemsFor((s) => {
      s.feedback.push({
        id: "promote", from: "surface:x", to: "gate", source: "explicit",
        scope: "tenant", form: "queue", latency: "deferred",
        promoteVia: "a-queue-nobody-registered",
      });
    });
    expect(problems.join("\n")).toContain("is not registered");
    expect(problems.join("\n")).toContain("defineReviewLane");
  });

  it("accepts a registered lane", () => {
    const problems = problemsFor((s) => {
      s.feedback.push({
        id: "promote", from: "surface:x", to: "gate", source: "explicit",
        scope: "tenant", form: "queue", latency: "deferred",
        promoteVia: SCALE_LINE_LANE,
      });
    });
    expect(problems).toEqual([]);
  });
});

describe("eval binding", () => {
  it("refuses a gateMetric that is not a registered extractor", () => {
    const problems = problemsFor((s) => {
      s.eval = { dataset: "d", gateMetric: "whatever_i_felt_like" };
    });
    expect(problems.join("\n")).toContain("not a registered gate metric");
  });

  it("refuses a manifest with no eval at all", () => {
    const problems = problemsFor((s) => {
      (s as { eval?: unknown }).eval = undefined;
    });
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe("tools", () => {
  const withWriter = (spec: ReturnType<typeof base>) => {
    spec.nodes.classify = { kind: "decide", questions: "jev-demo", version: "1" };
    spec.nodes.writer = {
      kind: "generate",
      prompt: "p",
      route: "r",
      version: "1",
      tools: {
        static: ["a"],
        selectable: { candidates: ["b"], from: "classify", gate: "gate" },
        allow: ["a", "b"],
      },
    };
    spec.edges.unshift({ from: "classify", to: "gate" });
    spec.edges.push({ from: "yes", to: "writer" });
  };

  it("accepts a well-formed selectable spec", () => {
    expect(problemsFor(withWriter)).toEqual([]);
  });

  it("refuses a static tool outside the allow ceiling", () => {
    const problems = problemsFor((s) => {
      withWriter(s);
      const writer = s.nodes.writer;
      if (writer?.kind === "generate" && writer.tools) writer.tools.static = ["z"];
    });
    expect(problems.join("\n")).toContain('static tool "z" is outside `allow`');
  });

  it("refuses selection from a node that is not a decide node", () => {
    const problems = problemsFor((s) => {
      withWriter(s);
      const writer = s.nodes.writer;
      if (writer?.kind === "generate" && writer.tools?.selectable) {
        writer.tools.selectable.from = "yes";
      }
    });
    expect(problems.join("\n")).toContain("must be a decide node");
  });

  it("refuses selection from a decide node that is not upstream", () => {
    const problems = problemsFor((s) => {
      withWriter(s);
      s.nodes.late = { kind: "decide", questions: "jev-late", version: "1" };
      s.edges.push({ from: "writer", to: "late" });
      const writer = s.nodes.writer;
      if (writer?.kind === "generate" && writer.tools?.selectable) {
        writer.tools.selectable.from = "late";
      }
    });
    expect(problems.join("\n")).toContain("is not upstream");
  });
});
