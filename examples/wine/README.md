# Wine: feature discovery into a spec

TypeSafe's [autoresearch feature discovery](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery) cookbook, re-run on this package. Its job is to predict a wine critic's score (80–100) from the tasting note alone.

1. **Discover.** Claude proposes questions about a note, and Jev answers them for 1,200 dev notes. Ridge regression learns from the answers, and the notes it predicts worst go back to Claude. This runs for five rounds.
2. **Score once.** Each round's question set is scored on 800 held-out notes that the loop never saw.
3. **Ship as a spec.** `discoverForSpec` writes the result into a pipeline spec with three nodes:
   - a `decide` node that asks the questions;
   - a `derive` node whose expression is the fitted model;
   - a gate at 90 that routes each wine to `notable` or `everyday`.

   The compiled pipeline then scores held-out notes through a decide port that calls Jev. The run fails if those scores don't match the offline model.

## Run it

```bash
python3 examples/wine/sample.py        # the cookbook's exact 2,000-review sample → data/wine.json
TYPESAFE_API_KEY=… ANTHROPIC_API_KEY=… npx tsx examples/wine/run.ts --run r1 [--rounds 5]
```

A full run takes about 5 minutes and costs under $1 of Jev, plus 5 Sonnet calls. Every Jev answer is cached in `data/cache.jsonl`, and each run's loop is saved in `data/runs/<run>/discovery.json`, so a re-run replays for free. `data/runs/<run>/` also gets `spec.json`, `question-set.json` and `report.json`.

## What we got (Jev 1.13, Claude Sonnet 5)

| Held-out RMSE, critic points | Cookbook (CatBoost) | Here (ridge) |
|---|---|---|
| Predict the average | 3.09 | 3.09 |
| Ask Jev for the score outright, then rescale | 2.15 | 1.98 |
| Round 1 questions only | 1.87 | 1.80 (18 questions) |
| After 5 rounds | 1.77 (38 questions) | **1.73** (32 questions) |

The compiled pipeline matched the offline model to 1e-8 on all 25 notes checked, and took the same route on each. The author model varies from run to run: a second one-round run reached 1.84.

## Two differences from the cookbook

- **Ridge instead of CatBoost.** The model has to live in the spec as one JSONata expression that a person can review.
- **The rubric says "the text".** The five intensity levels are the package's `INTENSITY_LEVELS`, because the published question set has to be exactly the wording the loop asked. `answerRows` builds its questions with `learnedQuestionSet`, and the attach gets the same `presence` criteria.
