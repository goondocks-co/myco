# Model Recommendations

Hardware-based guidance for choosing models during Myco setup. Myco uses three model tiers that load simultaneously in Ollama.

## Three-Tier Architecture

| Tier | Purpose | Speed vs Quality |
|------|---------|-----------------|
| **Embedding** | Vector search, semantic similarity | Dedicated small model, always loaded |
| **Processor** | Extraction, summarization, titles, classification | Speed matters — fast model, 8K context |
| **Digest** | Synthesize vault knowledge into tiered extracts | Quality matters — large model, up to 65K context |

The processor and digest can be the same model on smaller machines. On larger machines, splitting them gives the best speed/quality balance — processor tasks complete in seconds instead of minutes.

## Recommended Configurations

| RAM | Processor Model | Digest Model | Digest Context | Inject Tier | Est. VRAM |
|-----|----------------|--------------|----------------|-------------|-----------|
| **64GB+** | `qwen3.5:latest` (~8B) | `qwen3.5:35b` (MoE) | 65536 | 3000 | ~35GB |
| **48GB** | `qwen3.5:latest` (~8B) | `qwen3.5:27b` | 32768 | 3000 | ~26GB |
| **32GB** | `qwen3.5:4b` | `qwen3.5:latest` (~8B) | 16384 | 1500 | ~11GB |
| **16GB** | `qwen3.5:4b` | `qwen3.5:4b` | 8192 | 1500 | ~6GB |

Embedding model (`bge-m3`, ~1.3GB) is included in all VRAM estimates.

When processor and digest use the same model (16GB tier), Ollama loads it once — no extra VRAM.

### Why Qwen 3.5?

Qwen 3.5 models offer strong instruction-following and synthesis quality on local hardware. The MoE variant (`35b`) runs efficiently on 64GB+ systems because only a subset of parameters activate per token. Any instruction-tuned model that handles JSON output works — prefer what the user already has loaded, but recommend Qwen 3.5 for new setups.

### Important: Reasoning Token Suppression

Qwen 3.5 models are reasoning models that generate `<think>` tokens before output. Myco automatically suppresses this via `reasoning: 'off'` on all LLM calls. No user configuration needed — this is handled in code via the `LLM_REASONING_MODE` constant.

### Ollama Performance Settings

Recommend users add these to their Ollama service configuration for best performance:

```
OLLAMA_FLASH_ATTENTION=1    # Required for KV cache quantization
OLLAMA_KV_CACHE_TYPE=q8_0   # Halves KV cache memory — makes large digest context affordable
```

These are system-wide Ollama settings (launchd plist on macOS, systemd on Linux), not Myco-controlled.

## Pulling Models

**Ollama:**
```bash
ollama pull qwen3.5         # pulls latest tag (~8B)
ollama pull qwen3.5:4b      # 4B variant
ollama pull qwen3.5:27b     # 27B variant
ollama pull qwen3.5:35b     # 35B MoE variant
ollama pull bge-m3           # embedding model
```

**LM Studio:** Search for `qwen3.5` in the model browser. Download the variants matching the RAM tier above.

## Embedding Model

Separate from the intelligence models. Anthropic does not support embeddings — only Ollama and LM Studio provide embedding models.

Recommended:
- `bge-m3` — strong multilingual embeddings, good default
- `nomic-embed-text` — lightweight alternative

## Inject Tier

Controls how much pre-computed context the agent receives at session start. All tiers are available at all RAM levels — smaller models still support large context windows, they just use more KV cache memory. The default recommendation is based on what works best out of the box.

| RAM | Default Tier |
|-----|-------------|
| **48GB+** | 3000 |
| **32GB** | 3000 |
| **16GB** | 1500 |

### Tier Descriptions

- **1500** — executive briefing (fastest, lightest)
- **3000** — team standup (recommended for most setups)
- **5000** — deep onboarding
- **10000** — institutional knowledge (richest, most context)
