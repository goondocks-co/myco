# Results Template

Use this template when documenting model comparison results.

## Model Comparison Table

```markdown
## Results: [Prompt Name] Model Comparison (YYYY-MM-DD)

Evaluated N models against M fixtures.

| Model | Size | fixture-1 | fixture-2 | fixture-3 | Score |
|-------|------|:---:|:---:|:---:|:---:|
| **best-model** | XB | PASS | PASS | PASS | **3/3** |
| model-2 | XB | PASS | PASS | FAIL | 2/3 |
| model-3 | XB | PASS | FAIL | FAIL | 1/3 |

**Recommendation:** best-model (XB) — [reason].
```

## Prompt Iteration History

```markdown
## Prompt Iteration History

### v1 (initial): [Brief description of problem]
- [What was wrong with the prompt]
- Result: [What happened — which fixtures failed and why]

### v2 (tuned): [Brief description of fix]
- [What changed in the prompt]
- Result: [Which fixtures now pass, on which models]
```

## Multi-Model Eval Script

```bash
#!/bin/bash
# Run eval across recommended models for <prompt-name>
PROMPT="<prompt-name>"
MODELS=("phi4:latest" "gemma3:27b" "glm-4.7-flash:latest" "qwen3.5:latest")

for model in "${MODELS[@]}"; do
  echo ""
  echo "========================================="
  echo "MODEL: $model"
  echo "========================================="
  EVAL_LLM=true EVAL_MODEL="$model" npx vitest run "tests/prompts/${PROMPT}-eval.test.ts" 2>&1 \
    | grep -E "(✓|×|passed|failed|Response:|Decline reason:|WARNING)"
done
```
