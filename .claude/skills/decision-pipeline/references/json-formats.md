# JSON formats (shared by both languages, camelCase keys)

## Pipeline spec

Compiled by `compilePipelineSpec` / `compile_pipeline_spec` against a **registry** (primitives, expression
functions, named schemas, feature extractors) and an **expression engine** (JSONata). The compiler never
throws: it returns every problem (shape, unknown primitive, expression syntax, a root name that does not
flow into the node, then the full contract), which is what a model's repair loop reads. A compiled node's
version is `<version>~<8-hex body hash>`: editing an expression is a new node version.

```jsonc
{
  "id": "spec-demo", "fact": "demo", "input": "demo.input", "output": "demo.output",   // schema names
  "trigger": ["on-demand"], "group": "demo-{id}", "result": ["loud", "plain"],
  "nodes": {
    "evidence": { "kind": "read", "call": "demo.load@1", "version": "1" },
    "bundle":   { "kind": "code", "role": "transform",
                  "inputs": { "p": "evidence.row.p", "title": "evidence.title", "missing": "evidence.nope | 0" }, "version": "1" },
    "gate":     { "kind": "code", "role": "gate", "inputs": { "p": "bundle.p" }, "thresholds": { "p": 0.5 },
                  "branches": ["loud", "plain"],
                  "rules": [ { "when": "p >= $t.p", "branch": "loud", "reason": "'p ' & $string(p)", "confidence": "p" },
                             { "branch": "plain", "reason": "'under'" } ], "version": "1" },
    "loud":     { "kind": "code", "role": "derive", "call": "demo.shout@1",
                  "args": { "title": "gate.title", "n": "$half($input.factor)" }, "version": "1" },
    "plain":    { "kind": "code", "role": "derive", "expr": "{ \"text\": gate.title, \"n\": 0 }", "version": "1" },
    "check":    { "kind": "code", "role": "validate",
                  "assert": [ { "that": "$string(loud.text ? loud.text : plain.text) != ''", "message": "empty text" } ], "version": "1" },
    "persist":  { "kind": "store", "target": "memory", "scope": "user", "version": "1" }
  },
  "edges": [ { "from": "evidence", "to": "bundle" }, { "from": "bundle", "to": "gate" },
             { "from": "gate", "to": "loud", "when": { "gate": "gate", "branch": "loud" } },
             { "from": "gate", "to": "plain", "when": { "gate": "gate", "branch": "plain" } },
             { "from": "loud", "to": "check" }, { "from": "plain", "to": "check" }, { "from": "check", "to": "persist" } ],
  "feedback": [ { "id": "rating", "from": "surface:demo", "to": "gate", "source": "explicit", "scope": "user",
                  "form": "score", "latency": "deferred", "score": { "name": "demo_feedback", "dataType": "NUMERIC" } } ],
  "eval": { "dataset": "demo-eval", "gateMetric": "score_positive" }
}
```

Code-node bodies, exactly one of: `call` (+ optional `args`, each a JSONata expression; without `args`
the node's `inputs` are the args), `rules` (gates only: ordered, first match wins, the LAST rule has no
`when`, every branch has a rule), `expr`, `assert` (every `that` truthy or the node fails with `message`),
or `inputs` alone (output = the bindings). `fallback` is `{ "value" }`, `{ "expr" }` or `{ "call", "args" }`.

Expression root: the node's `inputs` when declared, else an object keyed by the ids of nodes with an
edge into it (a gate passes its input through, so downstream of gate `g` read `g.<name>`). Bindings:
`$input`, `$t` (thresholds), `$primary`, `$branches`, `$probes` (never inside a gate), `$boxes` (decide node id →
its Box answers, e.g. `$boxes.locate.mug.box.left`), and the registry's `$functions`. JSONata habits: a path over a one-element array yields the element (`x[]` keeps the array);
a missing path is `undefined`, test with `$exists`. Expressions are time- and depth-boxed.

`describeRegistry(registry)` and `pipelineSpecJsonSchema()` are what a model is handed to write a spec.

## Manifest patch (an experiment arm, or a replay override)

```json
{ "thresholds": { "gate": { "sure": 0.85 } }, "prompts": { "writer": "support-reply-v2" },
  "questions": { "classify": "is-refund-request-v2" }, "routes": { "writer": "fast-model" },
  "tools": { "writer": { "static": ["lookup"] } },
  "guards": [ { "from": "gate", "to": "writer", "when": { "gate": "gate", "branch": "writer" } } ] }
```

Only declarative fields; never a node body. `guards[].when: null` removes a guard; the edge must exist.

## Hypothesis

```jsonc
{
  "id": "stricter-gate-keeps-answers",
  "claim": "The challenger keeps the champion's answer on ≥ 90% of inputs.",
  "population": { "describe": "held-out tickets", "unit": "meta.user",
                  "where": [ { "path": "meta.route", "in": ["canned", "writer"] } ],
                  "split": { "salt": "stricter-gate", "holdout": 0.3, "use": "holdout" } },
  "metric":   { "ref": "exact_match@1", "prediction": "prediction.text", "truth": "truth" },   // or { "expr": "...", "binary": true, "direction": "higher" }
  "estimand": { "kind": "difference", "treatment": "challenger", "control": "champion", "paired": true },  // or { "kind": "level", "arm": "challenger" }
  "test":     { "kind": "greater", "than": 0.9 },   // greater | less | equivalent { around, within } | different { from }
  "alpha": 0.05, "interval": "auto",                 // auto | wilson | newcombe | newcombe_paired | normal | bootstrap
  "plan":     { "minEffect": 0.05, "baseline": 0.95, "power": 0.8, "n": 400 },
  "guardrails": [ { "name": "cost", "metric": { "ref": "value@1", "prediction": "meta.cost_usd" },
                    "test": { "kind": "less", "than": 0.0005 } } ],
  "segments": [ { "name": "by route", "by": "meta.route" } ]
}
```

Rows are `ObservationRow { id, arm?, unit?, prediction, truth?, recordedAt?, meta? }`; rows of two arms
sharing an `id` are a pair; `observationFromRun` / `observationsFromShadow` build them from runs with
`meta.route`, `meta.cost_usd`, `meta.ms`, `meta.version`, `meta.user`, `meta.features`. Built-in metric
refs (36): `exact_match@1`, `top_k@1`, `log_loss@1`, `brier@1`, `prob_of_truth@1`, `crps_gaussian@1`,
`reciprocal_rank@1`, `hit_at_k@1`, `precision_at_k@1`, `recall_at_k@1`, `average_precision@1`, `ndcg_at_k@1`,
`kendall_tau@1`, `jaccard@1`, `set_f1@1`, `set_exact@1`, `abs_error@1`, `squared_error@1`, `signed_error@1`,
`abs_pct_error@1`, `log_ratio_error@1`, `within_tolerance@1`, `interval_covers@1`, `interval_width@1`,
`interval_score@1`, `pinball@1`, `value@1`, `truthy@1`, `equals@1`, `cohen_kappa@1`, `macro_f1@1`, `auc@1`,
`ece@1`, `pearson@1`, `spearman@1`, `r2@1`. `metricCatalog(BUILTIN_METRICS)` lists them with arg schemas.

Verdict: `{ status: supported | refuted | inconclusive | invalid, reason, preregistered, final, primary, guardrails,
segments, excluded, warnings, stats_version }`. Each claim reports its interval, p-value, counts, the
smallest detectable effect and the sample size `plan.minEffect` would need.

## Run record (identical in both languages)

```jsonc
{ "pipeline": "scale", "version": "da0fa8d2497e5f76", "run_id": "trace-0001", "run_key": "trace-0001",
  "group": "cook-r1", "tenant": null, "user": null, "trigger": "on-demand", "input_hash": "b5ebcd859d389e60",
  "cost_usd": 0, "ms": 17, "fact": "scaled_recipe", "fact_route": "direct", "fact_confidence": 0.92,
  "nodes": [ { "id": "classify", "kind": "decide", "version": "3", "input_hash": "1dd4…", "ms": 2, "cost_usd": 0,
               "cost_reported": false, "distributions": { "dish": [0.95], "line:0": [0.92, 0.08] } },
             { "id": "gate", "kind": "code", "version": "1", "input_hash": "afa5…", "ms": 2, "cost_usd": 0,
               "branch": "direct", "thresholds": { "category": 0.7, "tools": 0.5 } },
             { "id": "writer", "kind": "generate", "version": "7", "input_hash": "", "ms": 0, "cost_usd": 0,
               "skipped": "gate took \"direct\", needed \"writer\"" } ],
  "features": { "classify.dish.margin": 0.95, "classify.line:0.entropy": 0.402, "nodes_ran": 6, "nodes_skipped": 2, "cost_usd": 0 },
  "consumed_feedback_ids": [], "arms": {}, "parent_run_id": null, "assignment_unit": null, "assignment_hash": null,
  "created_at": "2023-11-14T22:13:20.000Z" }
```

A decide node that asked a Box (Jev 1.14) also carries `"boxes": { "<question>": { "box": { "top", "bottom",
"left", "right" }, "confidence" } }`; its confidence appears in `distributions` as `[confidence]` with option
`"confidence"`, and `features` gains `<node>.<question>.box_area`, `.box_cx`, `.box_cy` beside `.top`.
