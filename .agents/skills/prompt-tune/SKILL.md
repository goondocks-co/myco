---
name: prompt-tune
description: This skill should be used when the user asks to "tune a prompt", "evaluate a prompt", "test prompt quality", "run prompt eval", "benchmark prompts", or mentions prompt tuning, prompt testing, or model comparison for Myco's LLM prompts. Development-only skill for the Myco project.
---

# Prompt Tuning

Evaluate and tune Myco's LLM prompt templates against local models. Run structured test fixtures, compare model performance, identify prompt weaknesses, and iterate until the prompt passes reliably.

This is a development tool for the Myco project — not shipped to end users.

## Prompt Inventory

All prompt templates live in `src/prompts/`. Current status:

| Prompt | Purpose | Has Fixtures | Tuned |
|--------|---------|:---:|:---:|
| `consolidation.md` | Consolidate related spores into wisdom notes | Yes | Yes |
| `supersession.md` | Detect when a new spore supersedes an old one | No | No |
| `extraction.md` | Extract observations from session events | No | No |
| `summary.md` | Generate session summaries | No | No |
| `title.md` | Generate session titles | No | No |
| `classification.md` | Classify artifacts | No | No |
| `session-similarity.md` | Detect parent-child session relationships | No | No |
| `digest-*.md` | Synthesize vault knowledge into tiered extracts | No | No |

## Workflow

### When fixtures exist: Run the eval

1. Check which prompts have eval fixtures: `ls tests/prompts/*-fixtures/ 2>/dev/null`
2. List available models: `curl -s http://localhost:11434/api/tags | python3 -c "import json,sys; [print(m['name'], m['details']['parameter_size']) for m in sorted(json.load(sys.stdin)['models'], key=lambda x: x['name'])]"`
3. Run the eval for a specific prompt:

```bash
# Single model
EVAL_LLM=true EVAL_MODEL="phi4:latest" npx vitest run tests/prompts/<prompt>-eval.test.ts

# All recommended models
for model in phi4:latest gemma3:27b glm-4.7-flash:latest qwen3.5:latest; do
  echo "=== $model ==="
  EVAL_LLM=true EVAL_MODEL="$model" npx vitest run tests/prompts/<prompt>-eval.test.ts 2>&1 | grep -E "(✓|×|passed|failed)"
done
```

4. Build a results table from the output. See `references/results-template.md` for the format.

### When fixtures don't exist: Create them

To create fixtures for a prompt that hasn't been tuned yet:

1. **Read the prompt template** in `src/prompts/<prompt>.md` to understand its input/output format
2. **Read existing usage** — grep for where the prompt is called in `src/` to understand the input format and how the response is parsed
3. **Create 3+ fixture files** in `tests/prompts/<prompt>-fixtures/`:
   - **positive.json** — input where the prompt should produce the desired output
   - **negative.json** — input where the prompt should decline or produce minimal output
   - **edge.json** — ambiguous input that tests the prompt's judgment
4. **Create the eval test** at `tests/prompts/<prompt>-eval.test.ts`:
   - Gate behind `EVAL_LLM=true` env var
   - Accept `EVAL_MODEL` for model selection (default: `phi4:latest`)
   - Use `describe.skipIf(!process.env.EVAL_LLM)` so CI skips it
   - 60s timeout per test (LLM calls can be slow)
   - Log raw responses for inspection
   - Assert on behavior (right decision, valid IDs) not exact text
5. **Use real vault data** where possible — synthetic data may miss real failure modes

For the response parsing pattern, follow the consolidation eval as a reference:

```typescript
import { createLlmProvider } from '@myco/intelligence/llm';
import { stripReasoningTokens } from '@myco/intelligence/response';
import { loadPrompt } from '@myco/prompts/index';

function createTestLlm() {
  return createLlmProvider({
    provider: 'ollama',
    model: process.env.EVAL_MODEL ?? 'phi4:latest',
    base_url: process.env.EVAL_BASE_URL ?? 'http://localhost:11434',
  });
}
```

See `tests/prompts/consolidation-eval.test.ts` for a complete working example.

### When a fixture fails: Tune the prompt

1. **Read the model's response** — understand WHY it made the wrong decision
2. **Identify the prompt weakness** — which instruction was ambiguous or missing?
3. **Apply targeted fixes:**
   - Too conservative → add "default: yes" framing, add concrete examples of what SHOULD match
   - Too aggressive → tighten rejection criteria, add examples of what should NOT match
   - Hallucinating structure → add explicit format examples and validation rules
   - Ignoring instructions → move critical rules earlier, use bold/caps
4. **Re-run the full fixture suite** — a fix for one case must not break others
5. **Run across models** — verify the fix works on multiple models, not just one

### After tuning: Document results

Update or create `skills/myco/references/<prompt>-tuning.md` with:
- Model comparison table (see `references/results-template.md`)
- Prompt iteration history (what changed, why, what it fixed)
- Lessons learned

Update the prompt inventory table above.

## Key Lessons from Prior Tuning

These patterns were discovered during consolidation prompt tuning and apply broadly:

1. **Default bias matters.** When input is pre-filtered (by semantic similarity, by type), lean toward action. The escape hatch is for genuinely wrong matches.

2. **Concrete examples beat abstract rules.** "Consolidate when observations share a root cause" fails. "3 gotchas about SQLite WAL mode → one note" works.

3. **The "reader test" works universally.** "Would someone looking for this information benefit from this output?" gives models a practical criterion.

4. **phi4 (14.7B) is the recommended baseline model** — outperforms models 2-8x its size on structured tasks. Test against it first.

5. **Test for both false positives AND false negatives.** A prompt that always says "yes" passes all positive fixtures. Need both positive and negative fixtures.

## Reference Files

- **`references/results-template.md`** — Template for model comparison tables
- **`references/prompt-eval-methodology.md`** — Detailed methodology documentation
- **`references/consolidation-tuning.md`** — Consolidation prompt tuning results (reference implementation)
