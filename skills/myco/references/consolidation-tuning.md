# Consolidation Prompt Tuning

Reference for prompt tuning methodology and results. Updated as the consolidation prompt is evaluated and refined against different models.

## Methodology

1. Build test fixtures with known expected outcomes (see `tests/prompts/consolidation-fixtures/`)
2. Run fixtures against target model: `EVAL_LLM=true npx vitest run tests/prompts/consolidation-eval.test.ts`
3. Score on: correct decision, correct source IDs, detail preservation, no hallucinated connections
4. Tune prompt wording, re-run, iterate

## Eval Criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| Consolidate/reject decision | Matches expected | Wrong decision |
| Source IDs | Exact match or valid subset | Hallucinated IDs or missing valid ones |
| Detail preservation | Specific file names, error messages, values retained | Generalized away |
| Nuance | Distinct insights kept separate | Forced into one note |

## Results

_To be populated during prompt tuning phase._

## Lessons Learned

_To be populated as prompt is refined._
