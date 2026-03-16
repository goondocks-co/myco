---
name: myco-init
description: Initialize Myco in the current project — sets up vault, config, and intelligence backend
---

# Initialize Myco

Guide the user through setup, then run the CLI to create the vault. **Do NOT create files manually — the CLI handles all vault creation, config writing, and env configuration.**

## Step 1: Choose vault location

Ask the user where they want the vault:

> Where would you like to store the Myco vault?
>
> 1. **In the project** (`.myco/`) — vault lives with the code, can be committed to git for team sharing
> 2. **Centralized** (`~/.myco/vaults/<project-name>/`) — vault stays outside the repo, good for public repos or personal use
> 3. **Custom path** — specify your own location

## Step 2: Choose intelligence backend

Detect available providers by checking local endpoints:

- **Ollama** — `curl -s http://localhost:11434/api/tags` — list model names
- **LM Studio** — `curl -s http://localhost:1234/v1/models` — list model IDs
- **Anthropic** — check if `ANTHROPIC_API_KEY` is set

Show the user what's available and recommend:
- **LLM**: `gpt-oss` on Ollama or LM Studio (best for structured JSON output)
- **Embeddings**: `bge-m3` on Ollama (Anthropic does not support embeddings)

Let the user choose their LLM provider/model and embedding provider/model.

If the recommended model isn't available, offer to pull it:
- **Ollama**: `ollama pull <model>`
- **LM Studio**: `lms get <owner/model>`

## Step 3: Run the CLI

Run the init command with all gathered inputs. The CLI creates the vault, writes config, sets up the FTS index, and configures `MYCO_VAULT_DIR` if the vault is external:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js init \
  --vault <chosen-path> \
  --llm-provider <provider> \
  --llm-model <model> \
  --llm-url <base-url> \
  --embedding-provider <provider> \
  --embedding-model <model> \
  --embedding-url <base-url>
```

## Step 4: Verify

After the CLI completes, confirm providers are reachable:

1. Test the LLM — send a short prompt and verify a response
2. Test embeddings — generate a test embedding and report dimensions
3. Display a setup summary table

| Setting | Value |
|---------|-------|
| Vault path | `<resolved path>` |
| LLM provider | `<provider>` / `<model>` |
| Embedding provider | `<provider>` / `<model>` |
| Context window | `<context_window>` |
