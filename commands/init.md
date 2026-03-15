---
name: myco-init
description: Initialize Myco in the current project — sets up vault, config, and intelligence backend
---

# Initialize Myco

Set up Myco for this project. Guide the user through:

## Step 0: Detect vault location

Before prompting the user for anything, check whether `MYCO_VAULT_DIR` is set:

- Check the process environment for `MYCO_VAULT_DIR`
- Also check `.claude/settings.json` under the `env` key for `MYCO_VAULT_DIR`
- If found and non-empty, use that path as the vault location — **do not ask the user where to put the vault**
- If not found, default to `.myco/` in the current project root

Record the **vault path source** for use in the setup summary:
- `"from MYCO_VAULT_DIR env"` — if the env var was set
- `"default (.myco/)"` — if falling back to the project root default

## Step 1: Create vault directory

Create the vault directory (at the resolved path from Step 0) with subdirectories:
`sessions`, `plans`, `memories`, `artifacts`, `team`, `buffer`

## Step 2: Choose intelligence backend

- **Cloud** (Claude Haiku) — uses existing ANTHROPIC_API_KEY, no setup needed
- **Local** (Ollama or LM Studio) — auto-detect running instances, offer to install Ollama if missing
  - For Ollama, recommend `gpt-oss` as the default summary model
  - For Ollama, recommend `nomic-embed-text` as the default embedding model

## Step 3: Team / solo setup

Ask whether this is a team or solo project. If `MYCO_VAULT_DIR` is set in the environment, also offer:

- **Solo** — vault stays local, not tracked by git
- **Team** — set up git tracking for the vault directory
- **Use MYCO_VAULT_DIR from env** _(only shown if env var is set)_ — treat the env-specified vault as a shared/external vault managed outside this repo; skip git tracking for the vault in this project

## Step 4: Write `myco.yaml`

Write the config file with chosen settings. Use the resolved vault path if it differs from the default.

## Step 5: Write `.myco/.gitignore` (or `<vault>/.gitignore`)

Exclude `index.db`, buffers, `.obsidian/` from git.

## Step 6: Register MCP server

Register the MCP server in the project's `.mcp.json`.

## Step 7: Setup summary

After setup, display a summary including:

| Setting | Value |
|---------|-------|
| Vault path | `<resolved path>` (`<vault path source>`) |
| Backend | `<chosen backend>` |
| Team mode | `<enabled/disabled>` |

Then confirm everything is working by running a test query against the vault.
