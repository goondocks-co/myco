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

- **Ollama** — list available models, recommend **`gpt-oss`**
- **LM Studio** — list available models, let user choose
- **Anthropic** — verify API key works, default model `claude-haiku-4-5-20251001`

For local providers (Ollama, LM Studio), also configure:
- `context_window` — ask or accept default of 8192
- `max_tokens` — ask or accept default of 1024

These settings do not apply to Anthropic (API-managed).

## Step 3: Choose embedding provider

Ask the user to select from available providers — **Anthropic is not an option** (it doesn't support embeddings):

- **Ollama** — list available models, recommend **`bge-m3`** or `nomic-embed-text`
- **LM Studio** — list available models, let user choose

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

## Step 5: Verify and restart

1. Test the LLM provider with a simple prompt
2. Test the embedding provider with a test embedding
3. Restart the daemon to pick up the new config: `node dist/src/cli.js restart`
4. Report success or issues found
