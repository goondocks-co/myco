# Model Recommendations

Hardware-based guidance for choosing intelligence and embedding models during Myco setup.

## Intelligence Model (LLM)

One model handles all intelligence tasks — hooks, extraction, summaries, and digest. Size for digestion, the most demanding task (largest context window). The same model runs at 8192 context for hooks and at the digest context window below for synthesis.

| RAM | Recommended Model | Digest Context Window |
|-----|-------------------|-----------------------|
| **64GB+** | `qwen3.5:35b` (MoE, recommended) | 65536 |
| **32–64GB** | `qwen3.5:27b` | 32768 |
| **16–32GB** | `qwen3.5:latest` (~10B) | 16384 |
| **8–16GB** | `qwen3.5:4b` | 8192 |

### Why Qwen 3.5?

Qwen 3.5 models offer strong instruction-following and synthesis quality on local hardware. The MoE variant (`35b`) runs efficiently on 64GB+ systems because only a subset of parameters activate per token. Any instruction-tuned model that handles JSON output works — prefer what the user already has loaded, but recommend Qwen 3.5 for new setups.

### Pulling Models

**Ollama:**
```bash
ollama pull qwen3.5         # pulls latest tag (~10B)
ollama pull qwen3.5:4b      # 4B variant
ollama pull qwen3.5:27b     # 27B variant
ollama pull qwen3.5:35b     # 35B MoE variant
```

**LM Studio:** Search for `qwen3.5` in the model browser. Download the variant matching the RAM tier above.

## Embedding Model

Embedding models are separate from the intelligence model. Anthropic does not support embeddings — only Ollama and LM Studio provide embedding models.

Recommended embedding models:
- `bge-m3` — strong multilingual embeddings, good default
- `nomic-embed-text` — lightweight alternative

**Ollama:**
```bash
ollama pull bge-m3
ollama pull nomic-embed-text
```

**LM Studio:** Filter the model list for names containing `text-embedding`. If none are available, search for and download an embedding model through the model browser.

## Inject Tier

Controls how much pre-computed context the agent receives at session start. Agents can always request a different tier on-demand via the `myco_context` MCP tool.

| RAM | Available Tiers | Default |
|-----|-----------------|---------|
| **64GB+** | 1500, 3000, 5000, 10000 | 3000 |
| **32–64GB** | 1500, 3000, 5000 | 3000 |
| **16–32GB** | 1500, 3000 | 1500 |
| **8–16GB** | 1500 | 1500 |

### Tier Descriptions

- **1500** — executive briefing (fastest, lightest)
- **3000** — team standup (recommended for most setups)
- **5000** — deep onboarding
- **10000** — institutional knowledge (richest, most context)

## Advanced: Separate Digestion Model

The guided setup configures one intelligence model for all tasks. Power users who want a separate, larger model specifically for digest can configure it via CLI:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-digest \
  --provider lm-studio \
  --model "qwen/qwen3.5-35b-a3b" \
  --context-window 65536
```

This is not exposed in the guided setup to avoid resource exhaustion from running two large models simultaneously.
