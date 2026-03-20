# Reconfiguration

Workflows for changing LLM providers, models, and digest settings on an existing vault. **Use the AskUserQuestion tool** to ask which settings to change — do not guess.

## Changing LLM or Embedding Provider/Model

Follow this exact order:

```bash
# 1. Detect what's available
node <plugin-root>/dist/src/cli.js detect-providers

# 2. Apply the change (use the correct --llm- or --embedding- prefixed flags)
node <plugin-root>/dist/src/cli.js setup-llm \
  --llm-provider <provider> --llm-model <model> \
  --embedding-provider <provider> --embedding-model <model>

# 3. ALWAYS restart daemon after any config change
node <plugin-root>/dist/src/cli.js restart

# 4. Only rebuild if the EMBEDDING model changed (not needed for LLM-only changes)
node <plugin-root>/dist/src/cli.js rebuild

# 5. Verify connectivity
node <plugin-root>/dist/src/cli.js verify
```

### Critical Flags

The `setup-llm` command uses `--llm-provider`, `--llm-model`, `--embedding-provider`, `--embedding-model` — NOT `--provider` or `--model`. Only pass flags for settings the user explicitly wants to change.

### Order Matters

1. `setup-llm` writes config
2. `restart` loads the new config into the daemon
3. `rebuild` re-embeds with the new embedding model (skip if embedding didn't change)
4. `verify` confirms everything works

### Embedding Model Warning

If the embedding model changed, tell the user: "Changing the embedding model requires a full vector index rebuild. This may take a few minutes."

## Changing Digest Settings

```bash
node <plugin-root>/dist/src/cli.js setup-digest \
  --context-window <number> --inject-tier <tier>
node <plugin-root>/dist/src/cli.js restart
```

For all available `setup-digest` flags (tiers, provider override, metabolism tuning, token budgets), see `cli-usage.md`.

## Viewing Current Settings

```bash
node <plugin-root>/dist/src/cli.js setup-llm --show
node <plugin-root>/dist/src/cli.js setup-digest --show
```

## Common Scenarios

### "Change my LLM model" (same provider)

```bash
node <plugin-root>/dist/src/cli.js setup-llm --llm-model qwen3.5:35b
node <plugin-root>/dist/src/cli.js restart
node <plugin-root>/dist/src/cli.js verify
```

No rebuild needed — embedding didn't change.

### "Switch from Ollama to LM Studio"

```bash
node <plugin-root>/dist/src/cli.js detect-providers
node <plugin-root>/dist/src/cli.js setup-llm \
  --llm-provider lm-studio --llm-model "qwen/qwen3.5-35b-a3b"
node <plugin-root>/dist/src/cli.js restart
node <plugin-root>/dist/src/cli.js verify
```

### "Change everything" (provider, model, and embedding)

```bash
node <plugin-root>/dist/src/cli.js detect-providers
node <plugin-root>/dist/src/cli.js setup-llm \
  --llm-provider ollama --llm-model qwen3.5:35b \
  --embedding-provider ollama --embedding-model bge-m3
node <plugin-root>/dist/src/cli.js restart
node <plugin-root>/dist/src/cli.js rebuild
node <plugin-root>/dist/src/cli.js verify
```
