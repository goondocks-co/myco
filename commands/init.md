---
name: myco-init
description: Initialize Myco in the current project — sets up vault, config, and intelligence backend
---

# Initialize Myco

Guide the user through setup using the composable CLI commands. **Do NOT create files manually — the CLI handles all vault creation, config writing, and env configuration.**

**Ask each question one at a time using AskUserQuestion with selectable options.** Wait for the user's answer before proceeding to the next question. Do NOT combine multiple questions into one message.

The streamlined setup asks just four questions: vault location, provider, model, and embedding model. One model handles everything — hooks, extraction, summaries, and digest — sized for the most demanding task (digestion). Advanced configuration is available via CLI commands after init.

## Step 1: Detect available providers and system capabilities

Run the provider detection command and detect system RAM:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js detect-providers
```

Detect RAM:
- **macOS**: `sysctl -n hw.memsize` (bytes → GB)
- **Linux**: parse `/proc/meminfo` for `MemTotal`

Parse the JSON output. This tells you which providers are running and what models are available.

## Step 2: Choose vault location

**Question:** "Where would you like to store the Myco vault?"

**Options:**
- "In the project (.myco/)" — vault lives with the code, can be committed to git for team sharing
- "Centralized (~/.myco/vaults/<project-name>/)" — vault stays outside the repo, good for public repos or personal use
- "Custom path" — specify your own location

## Step 3: Choose provider and model

**Question:** "Which LLM provider and model?"

List only providers where `available` is `true`. Recommend a model sized for digest based on detected RAM:

| RAM | Recommended Model | Digest Context |
|-----|-------------------|----------------|
| **64GB+** | `qwen3.5:35b` (MoE, recommended) | 65536 |
| **32–64GB** | `qwen3.5:27b` | 32768 |
| **16–32GB** | `qwen3.5:latest` (~10B) | 16384 |
| **8–16GB** | `qwen3.5:4b` | 8192 |

The same model handles hooks (at 8K context), extraction, summaries, and digest (at the larger context from the table). No separate model configuration needed.

If the model isn't installed, offer to pull it:
- **Ollama**: `ollama pull qwen3.5`
- **LM Studio**: search for `qwen3.5` in the model browser

## Step 4: Choose embedding model

**Question:** "Which embedding model?"

**Options:** List only providers that support embeddings (Anthropic does not):
- **Ollama** — recommend `bge-m3` or `nomic-embed-text`. If not installed: `ollama pull bge-m3`
- **LM Studio** — list models with `text-embedding` in the name from the detect-providers output (e.g., `text-embedding-nomic-embed-text-v1.5`, `text-embedding-qwen3-embedding-8b`). These load on demand.

## Step 5: Choose digest inject tier

**Question:** "How much context should the agent receive at session start?"

Based on RAM, present the recommended tiers:

| RAM | Options | Default |
|-----|---------|---------|
| **64GB+** | 1500, 3000, 5000, 10000 | 3000 |
| **32–64GB** | 1500, 3000, 5000 | 3000 |
| **16–32GB** | 1500, 3000 | 1500 |
| **8–16GB** | 1500 | 1500 |

**Options:**
- "1500 — executive briefing (fastest, lightest)"
- "3000 — team standup (recommended)"
- "5000 — deep onboarding"
- "10000 — institutional knowledge (richest)"

This controls what gets auto-injected at the start of every session. Agents can always request a different tier on-demand via the `myco_context` tool.

## Step 6: Run init and configure

Create the vault and apply settings:

```bash
# Create vault structure and base config
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js init \
  --vault <chosen-path> \
  --llm-provider <provider> \
  --llm-model <model> \
  --embedding-provider <embedding-provider> \
  --embedding-model <embedding-model>

# Set digest context window and inject tier based on user choices
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-digest \
  --context-window <from-ram-table> \
  --inject-tier <chosen-tier>
```

## Step 7: Verify connectivity

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js verify
```

If verification fails, help the user troubleshoot.

## Step 8: Display summary

| Setting | Value |
|---------|-------|
| Vault path | `<resolved path>` |
| Provider | `<provider>` / `<model>` |
| Embedding | `<embedding-provider>` / `<embedding-model>` |
| Digest | enabled (context: `<context-window>`) |
| RAM detected | `<X>` GB |
