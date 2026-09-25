/**
 * TypeSafe's "Autoresearch feature discovery" cookbook, re-run on
 * decision-pipeline: the same 2,000 wine reviews (1,200 dev / 800 held out,
 * the cookbook's seeded sample), the same brief, Claude Sonnet 5 as the
 * author, Jev answering. Then `discoverForSpec` turns the result into a spec,
 * and the compiled pipeline scores held-out notes through a real decide port.
 *
 *   python3 examples/wine/sample.py                  # once: data/wine.json
 *   TYPESAFE_API_KEY=… ANTHROPIC_API_KEY=… npx tsx examples/wine/run.ts --run r1
 *
 * Two departures from the cookbook, on purpose:
 *   - the learner is ridge regression, not CatBoost, because the model has to
 *     be writable into the spec as one expression (src/learned.ts);
 *   - the intensity rubric says "the text" (the package's INTENSITY_LEVELS),
 *     because the production decide node asks the same wording the loop did.
 *
 * Every Jev answer is cached in data/cache.jsonl, and each run's loop in
 * data/runs/<run>/discovery.json, so a re-run replays without calling anything.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  INTENSITY_LEVELS, defineRegistry, designMatrix, discoverFeatures, discoverForSpec, fitRidge, learnedImportance,
  learnedQuestionSet, pipelineFromSpec, predictLinear, questionId, rmse, runPipeline, scoreLearned, spearman,
  type DiscoverAction, type DiscoveredQuestion, type DiscoverResult, type DiscoverRow, type PipelineSpecJSON, type ProbeQuestion,
} from "../../src/index";
import { jsonataEngine } from "../../src/jsonata";
import { testPorts } from "../../src/testing";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");
const JEV_MODEL = process.env.JEV_MODEL ?? "jev-1.13.0";
const AUTHOR_MODEL = process.env.AUTHOR_MODEL ?? "claude-sonnet-5";
const USD_PER_JEV_TOKEN = 0.042e-6;
const N_DEV = 1200, N_TEST = 800, EXAMPLES = 60, PROPOSALS = 18, WORKERS = 16;
const PRESENCE = { true: "The note states this or clearly implies it", false: "The note gives no indication of this" };
const SCORE_LEVELS = [
  "Faulty or unpleasant - the note is mostly criticism",
  "Barely acceptable - drinkable, with nothing to recommend it",
  "Simple and sound - correct, plain, forgettable",
  "Pleasant everyday wine - some appeal, little depth",
  "Good - clear varietal character, well made",
  "Very good - balanced, with something to say",
  "Excellent - complex and structured",
  "Outstanding - depth and length, built to age",
  "Superb - among the best of its type",
  "Profound - the note treats it as exceptional",
];

// ---------------------------------------------------------------- the author (Claude)

// The cookbook's brief, with the learner named truthfully.
const BRIEF = `You are designing numeric features for a linear (ridge) regression model that
predicts the score a wine critic gave (an integer from 80 to 100) from the tasting note alone.
The model sees nothing but the features you design.

Return up to ${PROPOSALS} actions. Each action is one of:

- {"op": "add", "target": "", "name": ..., "kind": ..., "question": ...}
  A new feature.
- {"op": "revise", "target": <name of an existing feature>, "name": ..., "kind": ..., "question": ...}
  Replace that feature's question with better wording. Use this when a feature measures the
  right thing badly: too narrow, too vague, or worded so nearly every note answers the same.
- {"op": "drop", "target": <name of an existing feature>, "name": "", "kind": "intensity", "question": ""}
  Remove a feature that is not earning its place.

\`kind\` is "intensity" for something with a degree, or "presence" for a yes/no fact.
\`question\` is what gets asked about one tasting note.

An "intensity" question is graded against this fixed five-level rubric, so word it so that the
levels make sense:
${INTENSITY_LEVELS.map((l, i) => `  ${i}. ${l}`).join("\n")}

A "presence" question is answered as the probability that it is true of the note.

Good features can be judged from the note's own words, vary from note to note, and carry
information about quality that the other features do not. Reviewers describe structure, fruit,
oak, length, complexity, and drinkability, and they also signal quality through word choice.`;

const Actions = z.object({
  actions: z.array(z.object({
    op: z.enum(["add", "revise", "drop"]),
    target: z.string(),
    name: z.string(),
    kind: z.enum(["intensity", "presence"]),
    question: z.string(),
  })),
});

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

/** One Messages API call with a forced `submit` tool, so the actions come back as validated JSON. */
const author = async (req: { accepted: DiscoveredQuestion[]; examples: string; feedback: string }): Promise<DiscoverAction[]> => {
  const prompt = [
    req.examples,
    req.accepted.length ? `\nThe features you have now. \`add\` must not duplicate one of these; \`revise\` and \`drop\` refer to one by name:\n${req.accepted.map((q) => `- ${q.name} (${q.kind}): ${q.question}`).join("\n")}` : "",
    req.feedback ? `\nHow the model did with those features:\n${req.feedback}` : "",
  ].join("\n");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": need("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: AUTHOR_MODEL,
        max_tokens: 16000,
        system: BRIEF,
        messages: [{ role: "user", content: prompt }],
        tools: [{ name: "submit", description: "Submit this round's actions once.", input_schema: z.toJSONSchema(Actions) }],
        tool_choice: { type: "tool", name: "submit" },
      }),
    });
    if (!res.ok) { console.warn(`author: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); continue; }
    const body = (await res.json()) as { content: Array<{ type: string; input?: unknown }> };
    const parsed = Actions.safeParse(body.content.find((b) => b.type === "tool_use")?.input);
    if (parsed.success) return parsed.data.actions;
  }
  throw new Error("author made no valid submit call");
};

// ---------------------------------------------------------------- Jev, cached

interface JevAnswer { noul?: number; score?: number; probabilities?: Record<string, number> }

const CACHE = join(DATA, "cache.jsonl");
const cache = new Map<string, number[]>();
const usage = { calls: 0, tokens: 0 };
const keyOf = (note: string, q: ProbeQuestion) => createHash("sha256").update(`${JEV_MODEL}|${JSON.stringify(q)}|${note}`).digest("hex").slice(0, 32);

/** presence → [P(true)]; score → one probability per level. The shape learned.ts expects. */
const parseAnswer = (q: ProbeQuestion, a: JevAnswer | undefined): number[] => {
  if (q.type === "noul") return [a?.noul ?? 0.5];
  const levels = q.type === "score" ? q.criteria : Object.keys(q.criteria);
  return levels.map((lvl, k) => a?.probabilities?.[String(k)] ?? a?.probabilities?.[lvl] ?? (a?.score === k ? 1 : 0));
};

const jev = async (state: string, questions: Record<string, ProbeQuestion>): Promise<Record<string, JevAnswer>> => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${need("TYPESAFE_API_KEY")}` },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: AbortSignal.timeout(60_000),
    }).catch((e: unknown) => e as Error);
    if (!(res instanceof Error) && res.ok) {
      const body = (await res.json()) as { answers: Record<string, JevAnswer>; usage?: { input_tokens?: number } };
      usage.calls++;
      usage.tokens += body.usage?.input_tokens ?? 0;
      return body.answers;
    }
    const retryable = res instanceof Error || res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 4) throw new Error(`Jev: ${res instanceof Error ? res.message : `HTTP ${res.status} ${await res.text()}`}`);
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
};

/** One Jev request per note, carrying every question not already cached. */
const askNote = async (note: string, qs: Record<string, ProbeQuestion>): Promise<Record<string, number[]>> => {
  const missing = Object.entries(qs).filter(([, q]) => !cache.has(keyOf(note, q)));
  if (missing.length) {
    const answers = await jev(note, Object.fromEntries(missing));
    for (const [k, q] of missing) {
      const key = keyOf(note, q);
      const p = parseAnswer(q, answers[k]);
      cache.set(key, p);
      appendFileSync(CACHE, JSON.stringify({ key, p }) + "\n");
    }
  }
  return Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, cache.get(keyOf(note, q))!]));
};

/** Run `fn` over `items` with a fixed number of requests in flight. */
const pool = async <T, R>(items: T[], fn: (item: T, i: number) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
      if (++done % 300 === 0) console.log(`    ${done}/${items.length}`);
    }
  }));
  return out;
};

// One source of wording for the loop AND the question set the spec publishes.
const answerRows = async (notes: string[], qs: DiscoveredQuestion[]): Promise<Record<string, number[][]>> => {
  const set = learnedQuestionSet(qs, PRESENCE);
  const got = await pool(notes, (note) => askNote(note, set));
  return Object.fromEntries(qs.map((q) => [q.name, got.map((g) => g[q.name]!)]));
};

// ---------------------------------------------------------------- stats

const mulberry = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** Paired bootstrap of the held-out RMSE change, after − before. */
const pairedGain = (y: number[], before: number[], after: number[]) => {
  const rnd = mulberry(0);
  const draws: number[] = [];
  for (let b = 0; b < 2000; b++) {
    let s0 = 0, s1 = 0;
    for (let k = 0; k < y.length; k++) { const i = Math.floor(rnd() * y.length); s0 += (y[i]! - before[i]!) ** 2; s1 += (y[i]! - after[i]!) ** 2; }
    draws.push(Math.sqrt(s1 / y.length) - Math.sqrt(s0 / y.length));
  }
  draws.sort((a, b) => a - b);
  return { diff: rmse(y, after) - rmse(y, before), lo: draws[49]!, hi: draws[1949]! };
};

// ---------------------------------------------------------------- main

const main = async () => {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const run = flag("--run");
  if (!run) throw new Error("--run <name> required");
  const rounds = Number(flag("--rounds") ?? 5);
  const dir = join(DATA, "runs", run);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(DATA, "wine.json"))) throw new Error("no data/wine.json: run python3 examples/wine/sample.py first");
  if (existsSync(CACHE)) for (const l of readFileSync(CACHE, "utf8").split("\n").filter(Boolean)) { const c = JSON.parse(l) as { key: string; p: number[] }; cache.set(c.key, c.p); }

  const data = JSON.parse(readFileSync(join(DATA, "wine.json"), "utf8")) as { notes: string[]; points: number[] };
  const all: DiscoverRow[] = data.notes.map((text, i) => ({ id: `w${i}`, group: `w${i}`, label: data.points[i]!, base: [], text }));
  const dev = all.slice(0, N_DEV), test = all.slice(N_DEV, N_DEV + N_TEST);
  const yDev = dev.map((r) => r.label), yTest = test.map((r) => r.label);
  console.log(`dev ${dev.length}, held out ${test.length}; Jev ${JEV_MODEL}, author ${AUTHOR_MODEL}`);

  // 1. The loop reads dev rows only.
  const resultFile = join(dir, "discovery.json");
  const t0 = Date.now();
  const reused = existsSync(resultFile);
  const discovery: DiscoverResult = reused
    ? JSON.parse(readFileSync(resultFile, "utf8"))
    : await discoverFeatures({
        rows: dev, baseNames: [], target: "numeric", rounds, examples: EXAMPLES, maxActions: PROPOSALS, folds: 5, repeats: 3, minSpread: 0.05,
        log: (l) => console.log(l),
        ports: { author: (req) => author(req), answer: (rows, qs) => answerRows(rows.map((r) => r.text), qs) },
      });
  if (!reused) writeFileSync(resultFile, JSON.stringify(discovery));
  console.log(`discovery: ${discovery.accepted.length} questions${reused ? " (reused)" : `, ${((Date.now() - t0) / 60000).toFixed(1)} min`}`);

  // 2. Held out, once: each round's question set fitted on dev and scored on test.
  const snapshotQs = [...new Map(discovery.snapshots.flat().map((q) => [questionId(q), q])).values()];
  console.log(`answering ${snapshotQs.length} questions on ${test.length} held-out notes`);
  const testAnswers: Record<string, number[][]> = {};
  for (const round of [...new Set(snapshotQs.map((q) => q.round))]) {
    const qs = snapshotQs.filter((q) => q.round === round);
    const got = await answerRows(test.map((r) => r.text), qs);
    for (const q of qs) testAnswers[questionId(q)] = got[q.name]!;
  }
  const curve = discovery.snapshots.map((qs, i) => {
    const m = fitRidge(designMatrix(dev, qs, discovery.answers).X, yDev, 1);
    const p = designMatrix(test, qs, testAnswers).X.map((x) => predictLinear(m, x));
    return { round: i + 1, questions: qs.length, dev: discovery.history[i]!.rmse!, test: rmse(yTest, p), spearman: spearman(yTest, p), p };
  });
  const gain = pairedGain(yTest, curve[0]!.p, curve.at(-1)!.p);

  // 3. Baselines: the dev mean, and asking Jev for the score outright.
  console.log("baseline: asking Jev for the score on all 2,000 notes");
  const devMean = yDev.reduce((a, v) => a + v, 0) / yDev.length;
  const askQ: ProbeQuestion = { type: "score", instructions: "Judging only by what this tasting note says, how good is the wine?", criteria: SCORE_LEVELS };
  const ask = (rows: DiscoverRow[]) => pool(rows, async (r) => {
    const p = (await askNote(r.text, { quality: askQ })).quality!;
    const t = p.reduce((a, v) => a + v, 0) || 1;
    return 80 + (20 * p.reduce((a, v, k) => a + k * v, 0)) / t / (SCORE_LEVELS.length - 1);
  });
  const askDev = await ask(dev), askTest = await ask(test);
  const cal = fitRidge(askDev.map((v) => [v]), yDev, 1e-6);
  const askCal = askTest.map((v) => predictLinear(cal, [v]));

  // 4. The spec. A decision pipeline needs a gate and a human signal: the learned
  // score is cut at 90 (Wine Enthusiast's "outstanding"), and the critic's score is
  // the feedback edge.
  console.log("spec: discoverForSpec → compile → run on held-out notes");
  const registry = defineRegistry({
    schemas: {
      "wine.input": z.object({ id: z.string(), note: z.string() }),
      "wine.output": z.object({ score: z.number(), tier: z.enum(["notable", "everyday"]) }),
    },
  });
  const engine = jsonataEngine();
  const base: PipelineSpecJSON = {
    id: "wine-score", fact: "wine_tier", input: "wine.input", output: "wine.output", trigger: ["on-demand"], group: "wine-{id}",
    result: ["notable", "everyday"],
    nodes: {
      note: { kind: "code", role: "transform", inputs: { note: "$input.note" }, version: "1" },
      notable: { kind: "code", role: "derive", expr: '{ "score": wine_gate.score, "tier": "notable" }', version: "1" },
      everyday: { kind: "code", role: "derive", expr: '{ "score": wine_gate.score, "tier": "everyday" }', version: "1" },
      persist: { kind: "store", target: "memory", scope: "global", version: "1" },
    },
    edges: [{ from: "notable", to: "persist" }, { from: "everyday", to: "persist" }],
    feedback: [{ id: "critic", from: "surface:wine", to: "wine_gate", source: "explicit", scope: "user", form: "score", latency: "deferred", score: { name: "wine_critic_score", dataType: "NUMERIC" } }],
    eval: { dataset: "wine-eval", gateMetric: "score_positive" },
  };
  const out = await discoverForSpec({
    spec: base, rows: dev, baseNames: [], target: "numeric", discovery, ports: { author: async () => [], answer: async () => ({}) },
    attach: { prefix: "wine", after: "note", questionsName: "jev-wine-quality", presence: PRESENCE, gate: { cut: 90, above: "notable", below: "everyday", routes: { notable: ["notable"], everyday: ["everyday"] } } },
    check: { registry, engine },
  });
  writeFileSync(join(dir, "spec.json"), JSON.stringify(out.spec, null, 1));
  writeFileSync(join(dir, "question-set.json"), JSON.stringify(out.questionSet, null, 1));
  if (out.problems.length) throw new Error(`spec problems:\n  ${out.problems.join("\n  ")}`);

  // The decide port resolves the question-set name the spec carries, and asks Jev.
  const pipeline = pipelineFromSpec<{ id: string; note: string }, { score: number; tier: string }>(out.spec, registry, engine);
  const finalP = curve.at(-1)!.p;
  let maxDiff = 0, routeAgree = 0;
  const probe = test.slice(0, 25);
  for (const [k, r] of probe.entries()) {
    const ports = testPorts({
      decide: {
        wine_ask: async (req) => {
          if (req.questions !== "jev-wine-quality") throw new Error(`unknown question set ${req.questions}`);
          return { distributions: await askNote((req.from.note as { note: string }).note, out.questionSet) };
        },
      },
    });
    const res = await runPipeline(pipeline, { id: r.id, note: r.text }, ports);
    const offline = scoreLearned(out.model, Object.fromEntries(discovery.accepted.map((q) => [q.name, testAnswers[questionId(q)]![k]!])));
    maxDiff = Math.max(maxDiff, Math.abs(res.output.score - offline), Math.abs(res.output.score - finalP[k]!));
    if ((res.route === "notable") === (offline >= 90)) routeAgree++;
  }

  // 5. Report.
  const imp = Object.entries(learnedImportance(out.model)).sort((a, b) => b[1] - a[1]);
  const report = {
    run, at: new Date().toISOString(), jev: JEV_MODEL, author: AUTHOR_MODEL, jevUsage: usage,
    heldOut: {
      mean: { rmse: rmse(yTest, yTest.map(() => devMean)) },
      askRaw: { rmse: rmse(yTest, askTest), spearman: spearman(yTest, askTest) },
      askCalibrated: { rmse: rmse(yTest, askCal), spearman: spearman(yTest, askCal) },
      rounds: curve.map(({ p: _p, ...c }) => c),
      round1ToFinal: gain,
    },
    final: { questions: discovery.accepted.length, intensity: discovery.accepted.filter((q) => q.kind === "intensity").length, presence: discovery.accepted.filter((q) => q.kind === "presence").length },
    importance: imp.slice(0, 12).map(([k, v]) => ({ question: k, share: Math.round(v * 1000) / 10 })),
    spec: { applied: out.applied, pipelineVsOfflineMaxDiff: maxDiff, routeAgree, checkedRows: probe.length },
    journal: discovery.journal,
  };
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 1));

  const row = (name: string, r: number, s?: number) => console.log(`  ${name.padEnd(46)} ${r.toFixed(3)}   ${s === undefined ? "" : s.toFixed(3)}`);
  console.log(`\nheld out (${N_TEST} notes)                           RMSE    Spearman`);
  row("predict the dev mean", report.heldOut.mean.rmse);
  row("ask Jev for the score, rescaled 80-100", report.heldOut.askRaw.rmse, report.heldOut.askRaw.spearman);
  row("ask Jev for the score, calibrated on dev", report.heldOut.askCalibrated.rmse, report.heldOut.askCalibrated.spearman);
  for (const c of curve) row(`round ${c.round} (${c.questions} questions), ridge`, c.test, c.spearman);
  console.log(`\nround 1 → ${curve.length}: ${gain.diff >= 0 ? "+" : ""}${gain.diff.toFixed(3)} points, 95% CI [${gain.lo.toFixed(3)}, ${gain.hi.toFixed(3)}]`);
  console.log(`dev CV RMSE per round: ${curve.map((c) => c.dev.toFixed(3)).join(" → ")}`);
  console.log(`top questions: ${imp.slice(0, 6).map(([k, v]) => `${k} ${(100 * v).toFixed(1)}%`).join(", ")}`);
  console.log(`spec: ${out.applied.join("; ")}`);
  console.log(`compiled pipeline vs offline on ${probe.length} held-out notes: max |diff| ${maxDiff.toExponential(2)}, same route on ${routeAgree}/${probe.length}`);
  console.log(`Jev this run: ${usage.calls} calls, ${usage.tokens} tokens (~$${(usage.tokens * USD_PER_JEV_TOKEN).toFixed(2)})`);
};

main().catch((e) => { console.error(e); process.exit(1); });
