---
name: myco-init
description: Initialize Myco in the current project — sets up vault, config, and intelligence backend
---

# Initialize Myco

Guide the user through setup using the composable CLI commands. **Do NOT create files manually — the CLI handles all vault creation, config writing, and env configuration.**

**Ask each question one at a time using AskUserQuestion with selectable options.** Wait for the user's answer before proceeding to the next question. Do NOT combine multiple questions into one message.

## Step 1: Detect available providers

Run the provider detection command to see what's available:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js detect-providers
```

Parse the JSON output. This tells you which providers are running and what models are available.

## Step 2: Choose vault location

Ask the user:

**Question:** "Where would you like to store the Myco vault?"

**Options:**
- "In the project (.myco/)" — vault lives with the code, can be committed to git for team sharing
- "Centralized (~/.myco/vaults/<project-name>/)" — vault stays outside the repo, good for public repos or personal use
- "Custom path" — specify your own location

If the user picks "Custom path", ask them to type the path.

## Step 3: Choose LLM provider

Using the detected providers from Step 1, ask the user:

**Question:** "Which LLM provider for summarization?"

**Options:** List only providers where `available` is `true`, with recommended models. Prefer Qwen 3.5 for its strong instruction-following and synthesis quality. Example:
- "Ollama — qwen3.5 (recommended)"
- "LM Studio — qwen/qwen3.5-35b-a3b"
- "Anthropic"

After the user picks a provider, ask them to choose a specific model from that provider's model list (from the detect-providers output).

## Step 4: Choose embedding provider

Ask the user:

**Question:** "Which embedding provider?"

**Options:** List only providers where `available` is `true` and that support embeddings (Anthropic does not). Example:
- "Ollama — bge-m3 (recommended)"
- "LM Studio — text-embedding-bge-m3"

After the user picks a provider, ask them to choose a specific embedding model.

If the recommended embedding model isn't available, offer to pull it:
- **Ollama**: `ollama pull bge-m3`

## Step 5: Configure digest

Myco's digest engine continuously synthesizes vault knowledge into pre-computed context extracts, giving agents rich project understanding at session start.

**Detect system RAM** to recommend settings:
- **macOS**: `sysctl -n hw.memsize` (bytes → GB)
- **Linux**: parse `/proc/meminfo` for `MemTotal`

| Available Memory | Recommended Tiers | Context Window |
|-----------------|-------------------|----------------|
| < 16GB | `[1500]` | 8192 |
| 16–32GB | `[1500, 3000]` | 16384 |
| 32–64GB | `[1500, 3000, 5000]` | 24576 |
| 64GB+ | `[1500, 3000, 5000, 10000]` | 32768 |

Present the recommendation and ask:

**Question:** "Digest will continuously synthesize your vault into context extracts. Accept recommended settings?"

**Options:**
- "Yes — use recommended settings" (default)
- "Customize"
- "Disable digest"

Digest is enabled by default — the user must explicitly disable it.

If the user chooses **"Customize"**, ask these one at a time:

1. **Tiers:** "Which tiers to generate?" — options: [1500], [1500, 3000], [1500, 3000, 5000], [1500, 3000, 5000, 10000]
2. **Inject tier:** "Which tier to auto-inject at session start?" — options: 1500, 3000, 5000, 10000, or "None (MCP tool only)"
3. **Separate model:** "Use a different model for digestion?" — For Ollama users, recommend "No" (same model) since Ollama handles different context windows per-request and a separate model would exceed the default 2-model concurrent limit, causing slow model swapping. For LM Studio users, a separate model is fine since LM Studio manages instances independently.
4. **Context window:** "Context window for digest?" — suggest based on RAM tier from the table above

Use the CLI command to write digest settings deterministically:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-digest \
  --tiers 1500,3000,5000,10000 \
  --inject-tier 3000 \
  --context-window 32768
```

Only pass flags the user explicitly changed — Zod defaults handle the rest.

## Step 6: Run init with all gathered inputs

Pass everything to the init command in a single call:

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

The CLI creates the vault structure, writes myco.yaml, .gitignore, _dashboard.md, initializes the FTS index, and configures MYCO_VAULT_DIR if the vault is external.

After init completes, if the user chose custom digest settings, update the `digest` section in the newly created `myco.yaml` with their choices. If they accepted defaults, Zod handles it automatically — no YAML mutation needed.

## Step 7: Verify connectivity

Run the verify command to confirm providers are reachable:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js verify
```

If verification fails, help the user troubleshoot (check if the provider is running, model is loaded, etc.).

## Step 8: Display summary

Show the user a setup summary table:

| Setting | Value |
|---------|-------|
| Vault path | `<resolved path>` |
| LLM provider | `<provider>` / `<model>` |
| Embedding provider | `<provider>` / `<model>` |
| Digest | enabled / disabled |
| Digest tiers | `[1500, 3000, ...]` |
| Digest inject tier | `3000` (or "MCP tool only") |
