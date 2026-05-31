# Reconfiguration

Workflows for changing embedding settings and verifying an existing Myco project. Ask the user which setting they want changed; do not guess.

## Current Model

- LLM execution for the Myco agent is managed by the agent harness (currently Claude Agent SDK in dogfood paths), not by `setup-llm`.
- Embedding configuration is user-configurable and lives at the Grove tier.
- `setup-llm` configures embedding settings only. Legacy `--llm-*` flags are ignored with a notice.
- Digest and Cortex settings live in scoped config/UI surfaces; `setup-digest` is deprecated.

## Changing Embedding Provider or Model

Follow this order:

```bash
# 1. Detect local providers when choosing a local embedding backend
myco detect-providers

# 2. Show current Grove-tier embedding settings
myco setup-llm --show

# 3. Apply only the requested embedding changes
myco setup-llm \
  --embedding-provider <provider> \
  --embedding-model <model>

# 4. Restart daemon so runtime reads the new config
myco restart

# 5. Rebuild vectors if the embedding model changed
myco rebuild

# 6. Verify embedding connectivity
myco verify
```

If only the embedding URL changed and the provider/model stayed the same, restart and verify are enough. If the embedding model changed, tell the user: "Changing the embedding model requires a full vector index rebuild. This may take a few minutes."

## Viewing Current Settings

```bash
myco setup-llm --show
myco config get cortex.instructions.inject_on_session_start
myco config get cortex.digest.inject_on_session_start
```

Prefer `setup-llm --show` for embedding settings instead of raw config reads; it resolves the Grove tier correctly.

## Common Scenarios

### "Change my embedding model"

```bash
myco setup-llm --embedding-model bge-m3
myco restart
myco rebuild
myco verify
```

### "Switch embedding provider"

```bash
myco detect-providers
myco setup-llm \
  --embedding-provider ollama \
  --embedding-model bge-m3
myco restart
myco rebuild
myco verify
```

### "Enable or disable Cortex instruction injection"

```bash
myco config set cortex.instructions.inject_on_session_start true
myco restart
```

Use the Settings UI when possible for scoped config edits; it shows whether a value is machine, Grove, project, or local.
