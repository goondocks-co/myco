---
name: setup
description: >-
  Initialize Myco in a new project — guided first-time setup for vault,
  LLM provider, and intelligence backend
user-invocable: true
allowed-tools: Bash, AskUserQuestion, Skill
---

# Setup — Guided Myco Onboarding

This skill guides a first-time Myco setup from zero to a working vault. It detects the system's hardware and available providers, asks one question at a time, and delegates all configuration to CLI commands — never touching config files directly. If a vault already exists, it hands off to the `myco` skill for reconfiguration or status.

## Step 1: Check Vault Existence

Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js stats
```

- If the command **succeeds** (exit code 0): the vault already exists. Tell the user "Myco is already configured at `<vault-path>`." Then invoke the `myco` skill using the Skill tool — the `myco` skill handles all reconfiguration, status checks, and ongoing management. **Stop here. Do not continue with the setup flow. Do not attempt reconfiguration yourself.**
- If the command **fails** (exit code non-zero or vault not found): proceed to Step 2.

## Step 2: Detect System

Run both commands in parallel:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js detect-providers
```

Parse the JSON output. The result will list providers and their `available` field (boolean) and available models. Keep this data — you will use it in Step 3.

For RAM detection, run the appropriate command for the OS:

- **macOS:** `sysctl -n hw.memsize` — result is bytes; divide by `1073741824` (1024³) to get GB
- **Linux:** parse `/proc/meminfo` for the `MemTotal` line — result is in kB; divide by `1048576` to get GB

Use the RAM value to determine the recommended tier from `references/model-recommendations.md`:

| RAM | Processor Model | Digest Model | Digest Context | Inject Tier |
|-----|----------------|--------------|----------------|-------------|
| 64GB+ | `qwen3.5:latest` | `qwen3.5:35b` | 65536 | 3000 |
| 48GB | `qwen3.5:latest` | `qwen3.5:27b` | 32768 | 3000 |
| 32GB | `qwen3.5:4b` | `qwen3.5:latest` | 16384 | 1500 |
| 16GB | `qwen3.5:4b` | `qwen3.5:4b` | 8192 | 1500 |

Record: detected RAM (GB), recommended processor model, recommended digest model, digest context window, and default inject tier.

## Step 3: Ask Questions

**Use the AskUserQuestion tool for every question.** Present choices as selectable options. Do not ask questions in plain text — always use AskUserQuestion so the user can select from options. Wait for each answer before asking the next.

### Question 1: Vault Location

Use AskUserQuestion to ask the user where to store the vault. Present three choices:

- **Project-local** — `.myco/` in the current directory
- **Centralized** — `~/.myco/vaults/<project-name>/` (where `<project-name>` is the current directory's basename)
- **Custom path** — the user types a path

Record the resolved vault path.

### Question 2: Processor Model (extraction, summaries, titles)

Present the recommended processor model from the RAM table as the default. Show available models from the detected providers, grouped by provider.

Explain: "The processor model handles session extraction, summaries, and titles. Smaller, faster models work well here — speed matters more than depth."

If the recommended model is not installed:

- **Ollama:** offer to run `ollama pull <recommended-model>` before continuing.
- **LM Studio:** tell the user to download it from the model browser.

Record the chosen provider and processor model.

### Question 3: Digest Model (vault synthesis)

Present the recommended digest model from the RAM table as the default. Show available models from the detected providers.

Explain: "The digest model synthesizes your vault into context extracts. Larger models produce better results here — quality matters more than speed. This can be the same as the processor model on smaller machines."

If the recommended model is not installed, offer to pull/download as above.

Record the chosen provider and digest model.

### Question 4: Embedding Model

List embedding models from available providers. Exclude Anthropic — it does not support embeddings.

If no embedding models are installed:

- **Ollama:** offer to run `ollama pull bge-m3`. If the user accepts, run it before continuing.
- **LM Studio:** tell the user to search for and download an embedding model.

Recommend `bge-m3` as the default. Record the chosen embedding provider and model.

### Question 5: Inject Tier

Show the inject tier options appropriate for the detected RAM, with the default pre-selected:

| Tier | Description |
|------|-------------|
| 1500 | Executive briefing — fastest, lightest |
| 3000 | Team standup — recommended for most setups |
| 5000 | Deep onboarding |
| 10000 | Institutional knowledge — richest context |

Show only the tiers available for the user's RAM tier (per the table in Step 2). Pre-select the default. Tell the user: "Agents can always request a different tier on-demand via the `myco_context` MCP tool."

Record the chosen inject tier.

## Step 4: Execute

Run the following commands in sequence, substituting the recorded values. Show each command before running it.

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js init \
  --vault <chosen-vault-path> \
  --llm-provider <processor-provider> \
  --llm-model <processor-model> \
  --embedding-provider <embedding-provider> \
  --embedding-model <embedding-model>
```

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-digest \
  --provider <digest-provider> \
  --model <digest-model> \
  --context-window <digest-context-window-from-ram-table> \
  --inject-tier <chosen-inject-tier>
```

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js verify
```

If any command fails, report the error and stop. Do not continue to the next command on failure. Show the full error output to the user and ask how to proceed.

## Step 5: Ollama Performance Tips

If the user is using Ollama, recommend adding these to their Ollama service configuration:

```
OLLAMA_FLASH_ATTENTION=1    # Required for KV cache quantization
OLLAMA_KV_CACHE_TYPE=q8_0   # Halves KV cache memory
```

Explain: "These settings halve the memory used for large context windows, making digest much more efficient. They're Ollama-wide settings — on macOS, add them to your Ollama launchd plist."

## Step 6: Report

Display a summary table:

| Setting | Value |
|---------|-------|
| Vault path | `<resolved path>` |
| Processor | `<provider>` / `<processor-model>` |
| Digest | `<provider>` / `<digest-model>` (context: `<context-window>`) |
| Embedding | `<embedding-provider>` / `<embedding-model>` |
| Inject tier | `<inject-tier>` |
| RAM detected | `<X>` GB |

Tell the user: "Myco is ready. Start a new session to begin capturing knowledge."

## Constraints

- All writes via CLI commands — never read or modify `myco.yaml` directly.
- All provider detection via `detect-providers` — no raw HTTP calls to provider APIs.
- One question at a time — do not batch questions or present them together.
- Three model choices in guided setup: processor, digest, and embedding.
