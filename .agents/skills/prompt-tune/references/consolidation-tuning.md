# Consolidation Prompt Tuning

Reference for prompt tuning results for the consolidation prompt. For the general prompt eval methodology, see `references/prompt-eval-methodology.md`.

## Results: Model Comparison (2026-03-20)

Evaluated 10 Ollama models against 3 fixtures (should-consolidate, should-reject, partial-consolidate).

| Model | Size | consolidate | reject | partial | Score |
|-------|------|:---:|:---:|:---:|:---:|
| **phi4** | 14.7B | PASS | PASS | PASS | **3/3** |
| **gemma3:27b** | 27.4B | PASS | PASS | PASS | **3/3** |
| **glm-4.7-flash** | 29.9B | PASS | PASS | PASS | **3/3** |
| deepseek-r1:32b | 32.8B | PASS | PASS | FAIL | 2/3 |
| gpt-oss:120b | 116.8B | PASS | PASS | FAIL | 2/3 |
| qwen3.5:27b | 27.8B | PASS | PASS | FAIL | 2/3 |
| gpt-oss:latest | 20.9B | FAIL | PASS | FAIL | 1/3 |
| qwen3.5:latest | 9.7B | PASS | FAIL | PASS | 2/3 |
| qwen3.5:35b | 36B | TIMEOUT | PASS | TIMEOUT | 1/3 |
| qwen3-coder | 30.5B | TIMEOUT | TIMEOUT | TIMEOUT | 0/3 |

**Recommendation:** phi4 (14.7B) — best quality-to-compute ratio.

## Prompt Iteration History

### v1 (initial): Too conservative
- "When NOT to consolidate" section was too strong
- Stated "complementary rather than overlapping" should NOT consolidate
- Result: Model rejected clear consolidation cases (3 WAL gotchas treated as "different failure modes")

### v2 (tuned): Correct bias
- Added "Default: consolidate" section — flipped the bias since items were pre-selected by semantic similarity
- Added concrete examples matching fixture patterns
- Tightened rejection criteria to "genuinely unrelated topics only"
- Added the "reader test": would someone looking up one topic benefit from seeing the others?
- Removed the "complementary = don't consolidate" rule
- Result: phi4, gemma3, glm-4.7-flash pass all 3 fixtures

## Lessons Learned

1. **Default bias matters.** When observations are pre-filtered by semantic similarity, the model should lean toward consolidation. The escape hatch is for genuinely unrelated items, not complementary ones.

2. **Concrete examples in prompts dramatically improve compliance.** Adding "3 gotchas about SQLite WAL mode → consolidate" directly to the prompt eliminated the over-conservative rejection pattern.

3. **The "reader test" is an effective heuristic.** "Would a reader looking up one topic benefit from seeing the others in the same note?" gives the model a practical decision criterion instead of abstract rules.

4. **Bigger is not always better.** phi4 (14.7B) outperforms deepseek-r1 (32B), gpt-oss (120B), and all qwen3.5 variants. Instruction-following quality matters more than parameter count for structured tasks.

5. **Partial consolidation is the hardest case.** Most models struggle when a cluster contains both related and unrelated items. Only 3 of 10 models handle it correctly. This is acceptable — the system naturally avoids mixed clusters because vector search tends to surface homogeneous groups.

## Running the Eval

```bash
# Run against default model (phi4)
EVAL_LLM=true npx vitest run tests/prompts/consolidation-eval.test.ts

# Run against a specific model
EVAL_LLM=true EVAL_MODEL="gemma3:27b" npx vitest run tests/prompts/consolidation-eval.test.ts
```
