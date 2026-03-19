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
    model: gpt-oss
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

If customizing:
- **Tiers**: which token budgets to generate (1500, 3000, 5000, 10000)
- **Context window**: how much context the digest model can handle
- **Separate model**: optionally use a different (larger/reasoning) model for digest than for hook-based extraction. Show available models from the detected providers.
- **Inject tier**: which tier to auto-inject at session start (or null for MCP-tool-only)

Write the `digest` section to `myco.yaml`:

```yaml
digest:
  enabled: true
  tiers: [1500, 3000, 5000, 10000]
  inject_tier: 3000
  intelligence:
    provider: null     # null = inherit from main LLM
    model: null        # null = inherit from main LLM
    base_url: null     # null = inherit from main LLM
    context_window: 32768
  metabolism:
    active_interval: 300
    cooldown_intervals: [900, 1800, 3600]
    dormancy_threshold: 7200
  substrate:
    max_notes_per_cycle: 50
```

Only write fields the user explicitly changed — Zod defaults handle the rest.

## Step 6: Verify and restart

1. Test the LLM provider with a simple prompt
2. Test the embedding provider with a test embedding
3. Restart the daemon to pick up the new config: `node dist/src/cli.js restart`
4. Report success or issues found
