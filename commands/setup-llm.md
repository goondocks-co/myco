---
name: myco-setup-llm
description: Configure or change the intelligence backend (Ollama, LM Studio, or Anthropic)
---

# LLM Backend Setup

Guide the user through configuring their intelligence backend. This command can be run at any time to change providers or models.

The streamlined setup asks just three questions: provider, model, and embedding model. One model handles everything — hooks, extraction, summaries, and digest — at different context windows per request. Advanced configuration is available via the CLI for power users.

## Prerequisites

Read the existing `myco.yaml` from the vault directory to show current settings before making changes.

## Step 1: Detect available providers and system capabilities

Check which providers are reachable:

- **Ollama** — fetch `http://localhost:11434/api/tags`, list model names
- **LM Studio** — fetch `http://localhost:1234/v1/models`, list model names
- **Anthropic** — check if `ANTHROPIC_API_KEY` is set in the environment

Detect system RAM for recommendations:
- **macOS**: `sysctl -n hw.memsize` (bytes → GB)
- **Linux**: parse `/proc/meminfo` for `MemTotal`

Report which providers are available and the detected RAM.

## Step 2: Choose provider and model

Ask the user to select from available providers. After picking a provider, recommend a model sized for digest (the most demanding task). The same model handles hooks and extraction at smaller context windows automatically.

Recommended models by hardware tier — Qwen 3.5 is preferred for its strong instruction-following and synthesis quality:

| RAM | Model | Context for Digest |
|-----|-------|--------------------|
| **64GB+** | `qwen3.5:35b` (MoE, recommended) | 65536 |
| **32–64GB** | `qwen3.5:27b` | 32768 |
| **16–32GB** | `qwen3.5:latest` (~10B) | 16384 |
| **8–16GB** | `qwen3.5:4b` | 8192 |

Any instruction-tuned model that handles JSON output works. Prefer what the user already has loaded, but recommend Qwen 3.5 if they're starting fresh.

If the chosen model isn't installed, offer to pull it:
- **Ollama**: `ollama pull qwen3.5` (pulls latest tag automatically)
- **LM Studio**: search for `qwen3.5` in the model browser

## Step 3: Choose embedding model

Ask the user to select an embedding model — **Anthropic is not an option** (it doesn't support embeddings):

- **Ollama** (recommended) — recommend **`bge-m3`** or `nomic-embed-text`
- **LM Studio** — possible but not recommended for embeddings

If the embedding model isn't installed: `ollama pull bge-m3`

**Important:** If the user changes the embedding model, warn them:
> "Changing the embedding model will require a full rebuild of the vector index. Run `node dist/src/cli.js rebuild` after this change."

## Step 4: Apply settings

Use the CLI commands to write settings deterministically. The context window for the main LLM stays at 8192 (hooks don't need more). The digest context window is set based on the RAM tier recommendation.

```bash
# Set provider and model
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-llm \
  --llm-provider <provider> \
  --llm-model <model> \
  --embedding-provider <embedding-provider> \
  --embedding-model <embedding-model>

# Set digest context window based on RAM tier (model inherits from main LLM)
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-digest \
  --context-window <from-ram-table>
```

Only pass flags the user explicitly changed — Zod defaults handle the rest.

If migrating from a v1 config (has `backend: local/cloud` structure), bump `version` to `2` and rewrite the entire intelligence section. The loader auto-maps `provider: haiku` to `anthropic`.

## Step 5: Verify and restart

1. Test the LLM provider with a simple prompt
2. Test the embedding provider with a test embedding
3. Restart the daemon to pick up the new config: `node dist/src/cli.js restart`
4. Report success or issues found

## Advanced Configuration

For power users who want fine-grained control, all settings are available via CLI:

```bash
# Separate digest model (e.g., larger model on LM Studio)
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-digest \
  --provider lm-studio \
  --model "qwen/qwen3.5-35b-a3b" \
  --context-window 65536 \
  --gpu-kv-cache false

# Custom tiers and injection
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-digest \
  --tiers 1500,3000,5000,10000 \
  --inject-tier 3000

# Capture token budgets
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-digest \
  --extraction-tokens 2048 \
  --summary-tokens 1024

# View current settings
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-llm --show
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-digest --show
```
