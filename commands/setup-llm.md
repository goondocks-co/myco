---
name: myco-setup-llm
description: Configure or change the intelligence backend (Ollama, LM Studio, or Anthropic)
---

# LLM Backend Setup

Guide the user through configuring their intelligence backend. This command can be run at any time to change providers or models.

## Prerequisites

Read the existing `myco.yaml` from the vault directory to show current settings before making changes.

## Step 1: Detect available providers

Check which providers are reachable:

- **Ollama** — fetch `http://localhost:11434/api/tags`, list model names
- **LM Studio** — fetch `http://localhost:1234/v1/models`, list model names
- **Anthropic** — check if `ANTHROPIC_API_KEY` is set in the environment

Report which are available and which are not.

## Step 2: Choose LLM provider

Ask the user to select from available providers:

- **Ollama** — list available models
- **LM Studio** — list available models
- **Anthropic** — verify API key works, default model `claude-haiku-4-5-20251001`

Recommended models by hardware tier. Qwen 3.5 is preferred for its strong instruction-following and synthesis quality — extraction data feeds into the digest, so higher quality here means better project understanding:

| Tier | Models | RAM |
|------|--------|-----|
| **High** | `qwen3.5:35b` (MoE, recommended), `qwen3.5:27b`, `gpt-oss` (~20B) | 32GB+ |
| **Mid** | `qwen3.5:latest` (~10B), `gemma3:12b`, `qwen3:30b` | 16GB+ |
| **Light** | `qwen3.5:4b`, `gemma3:4b` | 8GB+ |

Any instruction-tuned model that handles JSON output works. Prefer what the user already has loaded, but recommend Qwen 3.5 if they're starting fresh.

For local providers (Ollama, LM Studio), also configure:
- `context_window` — ask or accept default of 8192 for hooks. Digest uses its own `context_window` (default 32768, configurable in Step 5)
- `max_tokens` — ask or accept default of 1024

If the chosen model isn't installed, offer to pull it:
- **Ollama**: `ollama pull qwen3.5` (pulls latest tag automatically)
- **LM Studio**: search for `qwen3.5` in the model browser

These settings do not apply to Anthropic (API-managed).

## Step 3: Choose embedding provider

Ask the user to select from available providers — **Anthropic is not an option** (it doesn't support embeddings):

- **Ollama** (recommended for embeddings) — list available models, recommend **`bge-m3`** or `nomic-embed-text`
- **LM Studio** — possible but not recommended for embeddings; better suited for LLM work

If the embedding model isn't installed: `ollama pull bge-m3`

**Important:** If the user changes the embedding model, the vector index must be rebuilt. Warn them:
> "Changing the embedding model will require a full rebuild of the vector index. Run `node dist/src/cli.js rebuild` after this change."

## Step 4: Update `myco.yaml`

Write both `intelligence.llm` and `intelligence.embedding` sections with all values explicit:

```yaml
intelligence:
  llm:
    provider: ollama
    model: qwen3.5
    base_url: http://localhost:11434
    context_window: 8192
    max_tokens: 1024
  embedding:
    provider: ollama
    model: bge-m3
    base_url: http://localhost:11434
```

If migrating from a v1 config (has `backend: local/cloud` structure), bump `version` to `2` and rewrite the entire intelligence section. The loader auto-maps `provider: haiku` to `anthropic`.

## Step 5: Configure digest (continuous reasoning)

Myco's digest engine continuously synthesizes vault knowledge into pre-computed context extracts. It runs in the daemon on an adaptive timer.

**Detect system capabilities** to recommend appropriate settings:
- **macOS**: `sysctl -n hw.memsize` (bytes → GB)
- **Linux**: parse `/proc/meminfo` for `MemTotal`

| Available Memory | Recommended Tiers | Context Window |
|-----------------|-------------------|----------------|
| < 16GB | `[1500]` | 8192 |
| 16–32GB | `[1500, 3000]` | 16384 |
| 32–64GB | `[1500, 3000, 5000]` | 24576 |
| 64GB+ | `[1500, 3000, 5000, 10000]` | 32768 |

Ask the user:

**Question:** "Configure digest (continuous reasoning)?"

**Options:**
- "Accept recommended settings" — use the RAM-based recommendation above
- "Customize" — let the user pick tiers, context window, and optionally a separate model
- "Disable" — set `digest.enabled: false`

If customizing, ask these one at a time:

1. **Tiers**: "Which tiers to generate?" — options: [1500], [1500, 3000], [1500, 3000, 5000], [1500, 3000, 5000, 10000]
2. **Inject tier**: "Which tier to auto-inject at session start?" — options: 1500, 3000, 5000, 10000, or "None (MCP tool only)"
3. **Separate model**: "Use a different model for digestion?" — if yes, ask provider and model from the detected providers. This allows a larger/better model for digest while keeping a fast model for hooks.
4. **Context window**: "Context window for digest?" — suggest based on RAM tier from the table above. If using LM Studio, note that the model will be pre-loaded with this context size.
5. **KV cache**: "Offload KV cache to GPU?" — default No (safer for large contexts). Only relevant for LM Studio.
6. **Keep alive**: "How long to keep model loaded between cycles?" — default "30m". Only relevant for Ollama.

Also ask about capture token budgets:

7. **Extraction tokens**: "Max tokens for spore extraction?" — default 2048
8. **Summary tokens**: "Max tokens for session summaries?" — default 1024

Write all settings to `myco.yaml`. Example with all fields explicit:

```yaml
capture:
  extraction_max_tokens: 2048
  summary_max_tokens: 1024
  title_max_tokens: 32
  classification_max_tokens: 1024

digest:
  enabled: true
  tiers: [1500, 3000, 5000, 10000]
  inject_tier: 3000
  intelligence:
    provider: null          # null = inherit from main LLM
    model: null             # null = inherit from main LLM
    base_url: null          # null = inherit from main LLM
    context_window: 32768
    keep_alive: 30m         # Ollama: keep model loaded between cycles
    gpu_kv_cache: false     # LM Studio: KV cache in system RAM
  metabolism:
    active_interval: 300
    cooldown_intervals: [900, 1800, 3600]
    dormancy_threshold: 7200
  substrate:
    max_notes_per_cycle: 50
```

Use the CLI command to write settings deterministically:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-digest \
  --tiers 1500,3000,5000,10000 \
  --inject-tier 3000 \
  --provider lm-studio \
  --model "qwen/qwen3.5-35b-a3b" \
  --context-window 65536 \
  --gpu-kv-cache false \
  --keep-alive 30m \
  --summary-tokens 1024 \
  --extraction-tokens 2048
```

Only pass flags the user explicitly changed — Zod defaults handle the rest. Use `--show` to display current settings.

## Step 6: Verify and restart

1. Test the LLM provider with a simple prompt
2. Test the embedding provider with a test embedding
3. Restart the daemon to pick up the new config: `node dist/src/cli.js restart`
4. Report success or issues found
