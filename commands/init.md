---
name: myco-init
description: Initialize Myco in the current project — sets up vault, config, and intelligence backend
---

# Initialize Myco

Guide the user through setup, then run the CLI to create the vault. **Do NOT create files manually — the CLI handles all vault creation, config writing, and env configuration.**

**Ask each question one at a time using AskUserQuestion with selectable options.** Wait for the user's answer before proceeding to the next question. Do NOT combine multiple questions into one message.

## Step 1: Choose vault location

Ask the user:

**Question:** "Where would you like to store the Myco vault?"

**Options:**
- "In the project (.myco/)" — vault lives with the code, can be committed to git for team sharing
- "Centralized (~/.myco/vaults/<project-name>/)" — vault stays outside the repo, good for public repos or personal use
- "Custom path" — specify your own location

If the user picks "Custom path", ask them to type the path.

## Step 2: Choose LLM provider

First, detect available providers by checking local endpoints:

- **Ollama** — `curl -s http://localhost:11434/api/tags` — list model names
- **LM Studio** — `curl -s http://localhost:1234/v1/models` — list model IDs
- **Anthropic** — check if `ANTHROPIC_API_KEY` is set

Then ask the user:

**Question:** "Which LLM provider for summarization?"

**Options:** List only providers that are actually running, with recommended models noted. Example:
- "Ollama — gpt-oss (recommended)"
- "LM Studio — openai/gpt-oss-20b"
- "Anthropic"

After the user picks a provider, ask them to choose a specific model from the available models on that provider.

## Step 3: Choose embedding provider

Ask the user:

**Question:** "Which embedding provider?"

**Options:** List only providers that are running and support embeddings (Anthropic does not). Example:
- "Ollama — bge-m3 (recommended)"
- "LM Studio — text-embedding-bge-m3"

After the user picks a provider, ask them to choose a specific embedding model.

If the recommended embedding model isn't available, offer to pull it:
- **Ollama**: `ollama pull bge-m3`

## Step 4: Run the CLI

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

## Step 5: Verify

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
