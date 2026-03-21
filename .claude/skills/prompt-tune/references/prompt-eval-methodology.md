# Prompt Evaluation Methodology

Standard process for tuning any LLM prompt in Myco. Every prompt template in `src/prompts/` should have corresponding eval fixtures and documented tuning results.

## The Process

### 1. Build Fixtures

Create 3+ test cases in `tests/prompts/<prompt-name>-fixtures/` as JSON files:

- **Positive case** — input where the prompt should produce the desired behavior (e.g., consolidate, extract observations, generate summary)
- **Negative case** — input where the prompt should decline or produce minimal output (e.g., don't consolidate unrelated items, no observations to extract)
- **Edge case** — ambiguous input that tests the prompt's judgment (e.g., partial consolidation, mixed-quality observations)

Each fixture has:
```json
{
  "description": "Human-readable description of what this tests",
  "input": { "...prompt-specific input fields..." },
  "expected": { "...expected behavior, not exact output..." }
}
```

Use real data from vaults where possible — synthetic examples may not surface the failure modes that real data does.

### 2. Write the Eval Test

Create `tests/prompts/<prompt-name>-eval.test.ts`:

- Gated behind an env var (`EVAL_LLM=true`) so it doesn't run in CI
- Accepts `EVAL_MODEL` to test different models
- Accepts `EVAL_BASE_URL` for non-default Ollama endpoints
- Uses `describe.skipIf(!process.env.EVAL_LLM)` to skip gracefully
- Each fixture gets its own `it()` block with a 60s timeout
- Logs the raw response for manual inspection
- Assertions check behavior, not exact text:
  - Did it make the right decision? (consolidate/reject, extract/skip)
  - Are structured fields valid? (IDs exist, no hallucinations)
  - Are specifics preserved? (file names, error messages, values)

```bash
# Run against default model
EVAL_LLM=true npx vitest run tests/prompts/<prompt-name>-eval.test.ts

# Run against a specific model
EVAL_LLM=true EVAL_MODEL="phi4:latest" npx vitest run tests/prompts/<prompt-name>-eval.test.ts
```

### 3. Run Across Models

Test every available model to find the best performer. Use a shell loop:

```bash
MODELS=("qwen3.5:latest" "phi4:latest" "gemma3:27b" "glm-4.7-flash:latest")

for model in "${MODELS[@]}"; do
  echo "=== $model ==="
  EVAL_LLM=true EVAL_MODEL="$model" npx vitest run tests/prompts/<prompt-name>-eval.test.ts 2>&1 | grep -E "(✓|×|passed|failed)"
done
```

Build a results table:

| Model | Size | case-1 | case-2 | case-3 | Score |
|-------|------|:---:|:---:|:---:|:---:|
| phi4 | 14.7B | PASS | PASS | PASS | 3/3 |
| ... | ... | ... | ... | ... | ... |

### 4. Tune the Prompt

When a fixture fails:

1. **Read the model's response** — understand WHY it made the wrong decision
2. **Identify the prompt weakness** — which instruction was ambiguous or missing?
3. **Apply targeted fixes:**
   - If the model is too conservative → add "default: yes" framing, add examples of what SHOULD match
   - If the model is too aggressive → tighten the rejection criteria, add examples of what should NOT match
   - If the model hallucinates structure → add explicit format examples and validation rules
   - If the model ignores instructions → move critical rules earlier in the prompt, use bold/caps for emphasis
4. **Re-run the full fixture suite** — a fix for one case must not break others
5. **Track iterations** — document what changed and why in the prompt-specific tuning doc

### 5. Document Results

Create/update `skills/myco/references/<prompt-name>-tuning.md` with:

- Model comparison table
- Prompt iteration history (what changed, why, what it fixed)
- Lessons learned (applicable to other prompts)
- Recommended model

## Key Principles

### Bias framing matters
When input is pre-filtered (e.g., by semantic similarity), the default should lean toward action. The prompt should explain that candidates were selected for a reason — the escape hatch is for genuinely wrong groupings, not borderline cases.

### Concrete examples beat abstract rules
"Consolidate when observations share a root cause" is vague. "3 gotchas about SQLite WAL mode → one note" is specific. Models follow examples better than rules.

### The "reader test" works across prompt types
"Would someone looking for this information benefit from this output?" gives the model a practical decision criterion. Applicable to consolidation, extraction, summarization.

### Test for false positives AND false negatives
A prompt that always says "yes" passes all positive fixtures. A prompt that always says "no" passes all negative fixtures. You need both to know the prompt actually works.

### Model selection is part of prompt tuning
The same prompt produces different results on different models. The prompt and model are tuned together. Document which models work and which don't — this informs model recommendations in the setup skill.

## Current Prompt Status

| Prompt | Fixtures | Tuned | Recommended Model |
|--------|:---:|:---:|---|
| `consolidation.md` | 3 | Yes | phi4 (14.7B) |
| `supersession.md` | 0 | No | — |
| `extraction.md` | 0 | No | — |
| `summary.md` | 0 | No | — |
| `title.md` | 0 | No | — |
| `classification.md` | 0 | No | — |
| `session-similarity.md` | 0 | No | — |
| `digest-*.md` (4 tiers) | 0 | No | — |

Each prompt should go through this process. Consolidation is the reference implementation.
