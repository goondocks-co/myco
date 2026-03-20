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

| RAM | Recommended Intelligence Model | Digest Context Window | Default Inject Tier |
|-----|--------------------------------|-----------------------|---------------------|
| 64GB+ | `qwen3.5:35b` | 65536 | 3000 |
| 32–64GB | `qwen3.5:27b` | 32768 | 3000 |
| 16–32GB | `qwen3.5:latest` (~10B) | 16384 | 1500 |
| 8–16GB | `qwen3.5:4b` | 8192 | 1500 |

Record: detected RAM (GB), recommended model, digest context window, and default inject tier. You will use these as defaults in the questions below.

## Step 3: Ask Questions

**Use the AskUserQuestion tool for every question.** Present choices as selectable options. Do not ask questions in plain text — always use AskUserQuestion so the user can select from options. Wait for each answer before asking the next.

### Question 1: Vault Location

Use AskUserQuestion to ask the user where to store the vault. Present three choices:

- **Project-local** — `.myco/` in the current directory
- **Centralized** — `~/.myco/vaults/<project-name>/` (where `<project-name>` is the current directory's basename)
- **Custom path** — the user types a path

Record the resolved vault path.

### Question 2: Provider and Model

From the `detect-providers` output, list only providers where `available` is `true`. Present them as choices. For each available provider, list its available models.

Pre-select the recommended model from Step 2 if it appears in the list. If the recommended model is not installed:

- **Ollama:** offer to run `ollama pull <recommended-model>` before continuing. Ask "Pull now or choose a different model?"
- **LM Studio:** tell the user to open LM Studio, search for `<recommended-model>`, and download it. Offer to wait or to let the user choose a different available model.

Record the chosen provider and model.

### Question 3: Embedding Model

List embedding models from the chosen provider. Exclude Anthropic — it does not support embeddings.

If no embedding models are installed:

- **Ollama:** offer to run `ollama pull bge-m3`. If the user accepts, run it before continuing.
- **LM Studio:** tell the user to search for and download an embedding model (suggest `bge-m3` or any model with `text-embedding` in the name).

Recommend `bge-m3` as the default. Record the chosen embedding provider and model.

### Question 4: Inject Tier

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
  --llm-provider <provider> \
  --llm-model <model> \
  --embedding-provider <embedding-provider> \
  --embedding-model <embedding-model>
```

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-digest \
  --context-window <digest-context-window-from-ram-table> \
  --inject-tier <chosen-inject-tier>
```

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js verify
```

If any command fails, report the error and stop. Do not continue to the next command on failure. Show the full error output to the user and ask how to proceed.

## Step 5: Report

Display a summary table:

| Setting | Value |
|---------|-------|
| Vault path | `<resolved path>` |
| Provider | `<provider>` / `<model>` |
| Embedding | `<embedding-provider>` / `<embedding-model>` |
| Digest | enabled (context: `<context-window>`, inject: `<inject-tier>`) |
| RAM detected | `<X>` GB |

Tell the user: "Myco is ready. Start a new session to begin capturing knowledge."

## Constraints

- All writes via CLI commands — never read or modify `myco.yaml` directly.
- All provider detection via `detect-providers` — no raw HTTP calls to provider APIs.
- One question at a time — do not batch questions or present them together.
- Two model choices in guided setup: intelligence model and embedding model. For a separate dedicated digestion model, direct the user to run `setup-digest` with a `--provider` and `--model` flag after setup completes (see `references/model-recommendations.md` Advanced section).
