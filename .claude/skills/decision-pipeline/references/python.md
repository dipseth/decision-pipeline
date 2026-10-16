# Python API (`decision_pipeline`, github.com/dipseth/decision-pipeline-python)

Install: `pip install "decision-pipeline[jsonata] @ git+https://github.com/dipseth/decision-pipeline-python"`
(Python 3.10+, pydantic 2; the `jsonata` extra brings `jsonata-python` for JSON specs). Develop with
`uv sync --extra jsonata && uv run pytest` in that repo.

Same functions as TypeScript in snake_case, same contract, same record, same JSON formats, identical
hashes. Two renames because of Python keywords: TS `from` → `from_`, TS `in` → `in_`.

## A manifest

```python
from pydantic import BaseModel
from decision_pipeline import (CodeNode, DecideNode, Edge, EdgeGuard, EvalSpec, FeedbackEdge, GateNode,
                               GenerateNode, ScoreConfigSpec, StoreNode, define_pipeline, run_pipeline)
from decision_pipeline import testing

class Ticket(BaseModel):
    id: str
    text: str

class Reply(BaseModel):
    text: str

def gate(args):
    p = (args.primary.get("refund") or [0])[0]
    if p >= args.thresholds["sure"]:
        return {"branch": "canned", "confidence": p}
    return {"branch": "writer", "reason": "not sure it's a refund", "confidence": p}

triage = define_pipeline(
    id="triage", fact="reply", input=Ticket, output=Reply, trigger=["on-demand"],
    group=lambda t: f"ticket-{t.id}", result=["canned", "check"],
    nodes={
        "classify": DecideNode(questions="is-refund-request", version="1"),
        "gate": GateNode(run=gate, branches=["canned", "writer"], thresholds={"sure": 0.8}, version="1"),
        "canned": CodeNode(role="derive", run=lambda a: {"text": "Your refund is on its way."}, version="1"),
        "writer": GenerateNode(prompt="support-reply", route="support-writer", version="1"),
        "check": CodeNode(role="validate", run=lambda a: a.primary, on_failure="revert", version="1"),
        "save": StoreNode(target="tickets-db", scope="user", version="1"),
    },
    edges=[
        Edge(from_="classify", to="gate"),
        Edge(from_="gate", to="canned", when=EdgeGuard(gate="gate", branch="canned")),
        Edge(from_="gate", to="writer", when=EdgeGuard(gate="gate", branch="writer")),
        Edge(from_="writer", to="check"), Edge(from_="canned", to="save"), Edge(from_="check", to="save"),
    ],
    feedback=[FeedbackEdge(id="thumbs", from_="surface:reply", to="gate", source="explicit", scope="user",
                           form="score", latency="deferred",
                           score=ScoreConfigSpec(name="reply_helpful", data_type="BOOLEAN"))],
    eval=EvalSpec(dataset="triage-eval", gate_metric="score_positive"),
)

ports = testing.test_ports(decide={"classify": {"distributions": {"refund": [0.93, 0.07]}}})
result = await run_pipeline(triage, {"id": "t-42", "text": "charged twice"}, ports)
result.route            # "canned"
result.output.text      # "Your refund is on its way."
result.record.nodes     # dataclasses: id, kind, version, input_hash, branch, branch_reason, thresholds, skipped, ...
```

Nodes, edges and feedback edges may also be dict literals with camelCase or snake_case keys
(`{"kind": "decide", "questions": "...", "version": "1"}`), which is handy when porting a TS manifest.
`define_pipeline` takes keyword arguments or a `PipelineSpec(...)`.

## Conventions a Python host must know

- **Sync or async anywhere.** Node bodies, `interpret`, every port, every observer hook, `prompt_config`,
  `cache.get/set` may be plain functions or coroutines. `run_pipeline`, `run_shadow`, `submit_feedback`,
  `propose_pipeline_spec`, `evaluate_hypothesis`, `collect_trial`, `judge_trial`, `discover_features`,
  `discover_for_spec`, `record_pipeline_eval_run` are `async def`.
- **Schemas** are pydantic `BaseModel` subclasses, `TypeAdapter`s, dataclass types or anything with
  `parse()`. The parsed input is a model instance inside node bodies (`args.input.text`) and plain data
  inside JSONata expressions.
- **Ports** are callables; `PipelinePorts(decide=..., generate=..., store=..., tracer=..., ...)` is a
  dataclass, as is `RunOptions(run_key=, force_arm=, shadow=, patch=, tags=, metadata=)`. `TracePort`
  is an object with `async root(opts, fn)` / `async span(opts, fn)` that await `fn(span_handle)`.
- **Results** are dataclasses (`DecideResult(distributions=..., distribution_options=, value=, cost_usd=)`,
  `GenerateResult(value=, cost_usd=, tools_called=, prompt_version=, tags=)`); a port may also return a
  dict with those keys (camelCase accepted).
- **Hashing** (`stable_stringify`, `short_hash`, `hash_to_unit`) matches TS byte for byte for JSON-like
  data; pydantic models hash by alias. Composite versions, cache keys, fingerprints and arm assignments
  therefore agree across the two implementations.
- **Timestamps** are ISO strings with milliseconds and `Z`; clocks return milliseconds.
- **Deadlines and skips.** `timeout_ms=` on a node: past it the node fails with `NodeTimeoutError`
  (its `on_failure` decides) and `args.signal` / `request.signal` (an `AbortSignal` with `.aborted`) is
  aborted; a late answer is discarded. Raise `NodeSkipped("reason")` from a body or port to be recorded
  as skipped. Observers may implement `on_run_fail(event)` for a run that threw.
- **Box answers** (Jev 1.14) come back from the decide port as `boxes=` on `DecideResult` (or a `boxes` key);
  the runtime checks and records them and mirrors each confidence into `distributions`. `interpret` may be
  `(distributions, args)` or `(distributions, args, boxes)`; a two-argument one reads them as
  `args.boxes[args.node.id]`. Downstream bodies read `args.boxes["<decide node>"]["<question>"]`.
- `record.to_dict()` gives the JSON record; `pipeline.to_json()` gives the TS `PipelineJSON` dict.

## Surface, by module

| Module | What you call |
|---|---|
| `define` | `define_pipeline(spec | **kwargs)`, `validate_pipeline`, `validate_patch`, `ancestors_of`, `PipelineSpec`, `EvalSpec`, `Overridable`, `DecisionPipeline.to_json()` / `.order` |
| `run` | `await run_pipeline(pipeline, raw_input, ports=None, options=None, **options)` → `RunResult(output, run_id, run_key, version, route, confidence, decided_by, arms, record, skipped, scope_rejections, patch_applied)`; `apply_override` |
| `types` | `ReadNode`, `DecideNode`, `GenerateNode`, `CodeNode`, `GateNode`, `StoreNode`, `Edge`, `EdgeGuard`, `FeedbackEdge`, `ScoreConfigSpec`, `ProbeSpec`, `ToolSpec`, `ToolSelectable`, `NodeRunArgs(input, from_, in_, primary, ctx, thresholds, node, branches, probes, boxes, signal)`, `BranchTaken`, `FeatureRow`, `OverrideRow`, `SCOPES`, `RANKS` |
| `ports` | `PipelinePorts`, `RunOptions`, `DecideRequest/DecideResult`, `GenerateRequest/GenerateResult`, `StoreRequest`, `ScoreRequest`, `QueueRequest/QueueResult`, `DatasetRunRequest`, `PromptResolution`, `RootSpanOpts`, `NodeSpanOpts` |
| `testing` | `test_ports(decide=, generate=, scope=, prompts=, registry=, env=, prompt_config=, knowledge_version=, trace_id=)` → `TestPorts` (+ `tracer.spans/roots`, `observed`, `store_writes`, `recorded`, `decide_calls`, `generate_calls`, `scores_written`, `queue_items`, `dataset_runs`); `recording_tracer`, `scripted_decide`, `scripted_generate`, `collecting_store`, `memory_cache`, `collecting_records`, `collecting_observer`, `throwing_observer`, `collecting_scores`, `collecting_queue`, `collecting_dataset`, `memory_trial_store`, `static_scope`, `static_prompts`, `static_registry`, `stepping_clock` |
| `feedback` | `await submit_feedback(pipeline, FeedbackSubmission(...) | dict, ports)`, `enqueue_for_hand_read(pipeline, run_id=, reason=, lane=, ports=)`, `category_value` |
| `review` | `define_review_queue`, `define_review_lane(lane=, queue=, score_config=)`, `PIPELINE_REVIEW_QUEUE`, `PIPELINE_HAND_READ_QUEUE`, `clear_review_registry`, `snapshot_review_registry`, `restore_review_registry` |
| `record` | `RunRecord`, `RunRecordNode`, `RunLabel`, `define_gate_metric`, `aggregate_gate_metric`, `clear_gate_metrics` |
| `evals` | `await record_pipeline_eval_run(pipeline, PipelineEvalRun(rows=[EvalRow(...)]), ports)`, `eval_run_name` |
| `probes` | `collect_probes`, `probe_answers`, `probe_features`, `MAX_PROBES`, `probe_question_schema` |
| `box` | `check_box_answer`, `box_width`, `box_height`, `box_area`, `box_center`, `pad_box`, `box_to_pixels`, `box_iou`, `tile_boxes`, `box_from_tile`, `edge_check_questions`, `expand_box_edges`, `box_features`, `BOX_CONFIDENCE_OPTION`; `Box`, `BoxAnswer` |
| `jev` | `JEV_MODEL` (`jev-1.14.0`), `JEV_PREVIEW_MODEL`, `JEV_ENDPOINT`, `JEV_IMAGES_HEADER`, `JEV_LONG_CONTEXT_HEADER`, `jev_supports_box`, `jev_needs_images`, `check_jev_request(body) -> list[str]`, `jev_headers(api_key, body, *, long_context=False)`, `jev_answers_to_decide_result(answers, usage=, cost_usd=)` |
| `bindings` | `parse_input_ref`, `resolve_inputs`, `binding_problems` |
| `experiments` / `patch` | `ManifestPatch`, `GuardPatch`, `ExperimentSpec`, `assign_arm`, `merge_patches`, `apply_manifest_patch`, `manifest_patch_from_dict` |
| `spec` | `compile_pipeline_spec(spec_dict, registry, engine)` → `CompileResult(pipeline, problems)`, `pipeline_from_spec`, `define_registry(primitives=, functions=, schemas=, features=)`, `define_primitive(id=, version=, describe=, args=, run=)`, `describe_registry`, `pipeline_spec_json_schema()`, `merge_registries` |
| `jsonata` | `jsonata_engine(timeout_ms=250, max_depth=500)` (extra `jsonata`) |
| `propose` | `await propose_pipeline_spec(goal=, registry=, engine=, author=, base=, vocabulary=, max_rounds=)`, `extract_spec_json`, `diff_specs`, `spec_vocabulary` |
| `shadow` | `await run_shadow(champion=, challenger=, input=, ports=, options=, label=, share=True)` → `ShadowResult(champion, challenger, challenger_error, challenger_stores, calls, comparison)`; `compare_runs` |
| `metrics` | `BUILTIN_METRICS`, `define_metric`, `metric_registry`, `metric_catalog`, `ObservationRow`, `pick_path` |
| `hypothesis` | `compile_hypothesis(json, metrics=, engine=)`, `lock_hypothesis`, `await evaluate_hypothesis(h, rows, lock=, now=)`, `plan_hypothesis`, `split_of`, `partition_rows`, `observation_from_run`, `observations_from_shadow`, `hypothesis_json_schema()` |
| `trial` | `lock_trial`, `await register_trial(store, lock)`, `await collect_trial(hypothesis=, store=, champion=, challenger=, inputs=, id=, unit=, ports=, truth=, meta=, concurrency=)`, `await judge_trial(h, store)`, `pipeline_fingerprint` |
| `discover` / `learned` | `await discover_features(rows=, base_names=, ports=DiscoverPorts(author=, answer=), target=, rounds=, ...)`, `await discover_for_spec(spec=, attach=, discovery=, check=, ...)`, `attach_learned_gate`, `learned_question_set`, `learned_expression`, `score_learned`, `fit_ridge`, `fit_logistic`, `design_matrix`, `INTENSITY_LEVELS`, `DiscoverResult.to_dict()/from_dict()` |
| `diagram` | `render_pipeline_svg(json, title=, standalone=, header=, legend=)`, `layout_pipeline`, `node_subtitle` |
| `explain` | `await explain_pipeline(json, level=, title=, summary=, language_name=, generate=)`, `explain_prompt`, `explain_brief`, `explain_version`, `explain_cache_key`, `EXPLAIN_LEVELS`, `EXPLAIN_SYSTEM_PROMPT` |
| `stats` | `wilson_interval`, `newcombe_interval`, `newcombe_paired_interval`, `mcnemar_exact`, `cluster_bootstrap`, `seeded_random`, `required_sample_size` |

## A decide port backed by Jev

The wire helpers ship with the package (same names as TS in snake_case); the port is just the HTTP call.

```python
import os, httpx
from decision_pipeline import (JEV_ENDPOINT, JEV_MODEL, DecideRequest, DecideResult,
                               check_jev_request, jev_answers_to_decide_result, jev_headers)

async def jev_decide(req: DecideRequest) -> DecideResult:
    probes = {slot: {k: v for k, v in q.items() if k != "why"} for slot, q in req.probes.items()}  # `why` is for humans
    body = {
        "model": JEV_MODEL,                                          # "jev-1.14.0"; pin it once thresholds are tuned
        "state": build_state(req.input),
        "questions": {**load_questions(req.questions), **probes},  # your fixed set + this run's probes
    }
    if problems := check_jev_request(body):                          # e.g. a Box sent to jev-1.13.0
        raise ValueError("; ".join(problems))
    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(JEV_ENDPOINT, headers=jev_headers(os.environ["TYPESAFE_API_KEY"], body), json=body)
    data = res.json()
    # noul -> [p], choice/score -> one probability per option, box -> boxes=
    return jev_answers_to_decide_result(data["answers"], usage=data["usage"],
                                        cost_usd=lambda u: u.get("input_tokens", 0) * 0.042e-6)
```

`jev_headers` adds the images header when the request carries an image asset or a Box, and the long-context
header only with `long_context=True`; `check_jev_request` refuses a Box on a pre-1.14 model.

## Box (Jev 1.14)

`DecideResult.boxes = {"mug": {"box": {"top", "bottom", "left", "right"}, "confidence"}}`; the runtime checks,
records (`RunRecordNode.boxes`) and mirrors confidence into `distributions`. Later nodes read
`args.boxes["locate"]["mug"]["box"]`; `interpret` may take a third `boxes` argument (a two-argument
`interpret` still works and reads `args.boxes[args.node.id]`). A `derive` node after a Box does
`box_to_pixels(pad_box(args.boxes["locate"]["mug"]["box"], args.thresholds["pad"]), w, h)`. Helpers:
`box_to_pixels` (JS-style half-up rounding, so pixels match TS), `pad_box`, `box_iou`, `tile_boxes`,
`box_from_tile`, `edge_check_questions`, `expand_box_edges`, `check_box_answer`. Fixture to copy: `tests/test_box.py`.

## Develop

`uv sync --extra jsonata && uv run pytest -q` in the Python repo. Fixtures: `decision_pipeline/fixtures.py`
(`build_scale_pipeline`, `demo_registry`, `demo_spec`). Its `PORTING.md` records the TS → Python
conventions; keep new code consistent with it, and port every change to `src/` there (same module name,
same test). `examples/wine/run.py` is a complete consumer.
