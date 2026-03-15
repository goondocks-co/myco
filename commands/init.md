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

Also create a `_dashboard.md` file in the vault root with the following Dataview-powered content:

```markdown
# Myco Vault

## Active Plans
\`\`\`dataview
TABLE status, tags FROM #type/plan
WHERE status = "active" OR status = "in_progress"
SORT created DESC
\`\`\`

## Recent Sessions
\`\`\`dataview
TABLE user, started, tools_used FROM #type/session
SORT started DESC LIMIT 10
\`\`\`

## Recent Memories
\`\`\`dataview
TABLE observation_type AS "Type", created FROM #type/memory
SORT created DESC LIMIT 15
\`\`\`

## Memories by Type
\`\`\`dataview
TABLE WITHOUT ID observation_type AS "Type", length(rows) AS "Count"
FROM #type/memory GROUP BY observation_type
SORT length(rows) DESC
\`\`\`

## Gotchas
\`\`\`dataview
LIST FROM #memory/gotcha SORT created DESC LIMIT 10
\`\`\`
```

This dashboard requires the Dataview community plugin in Obsidian. Without it, the code blocks are visible but still readable as plain markdown.

## Step 2: Choose intelligence backend

Configure LLM and embedding providers independently:

### LLM provider

Ask the user to choose an LLM provider:

- **Ollama** — detect at `http://localhost:11434/api/tags`, list available models, recommend `gpt-oss`
- **LM Studio** — detect at `http://localhost:1234/v1/models`, list available models
- **Claude Anthropic** — uses existing `ANTHROPIC_API_KEY`, verify it's set

For the selected provider, list available models and let the user choose. Also set:
- `context_window` (default 8192)
- `max_tokens` (default 1024)

### Embedding provider

Ask the user to choose an embedding provider. **Anthropic is not an option here** — it doesn't support embeddings.

- **Ollama** — detect at `http://localhost:11434/api/tags`, list available models, recommend `bge-m3` or `nomic-embed-text`
- **LM Studio** — detect at `http://localhost:1234/v1/models`, list available models

For the selected provider, list available models and let the user choose.

## Step 3: Team / solo setup

Ask whether this is a team or solo project. If `MYCO_VAULT_DIR` is set in the environment, also offer:

- **Solo** — vault stays local, not tracked by git
- **Team** — set up git tracking for the vault directory
- **Use MYCO_VAULT_DIR from env** _(only shown if env var is set)_ — treat the env-specified vault as a shared/external vault managed outside this repo; skip git tracking for the vault in this project

## Step 4: Write `myco.yaml`

Write a `version: 2` config file with chosen settings. All configurable values must be explicit. Example output:

```yaml
version: 2

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

daemon:
  log_level: info
  grace_period: 30
  max_log_size: 5242880

capture:
  transcript_paths: []
  artifact_watch:
    - docs/superpowers/specs/
    - .claude/plans/
  artifact_extensions:
    - .md
  buffer_max_events: 500

context:
  max_tokens: 1200
  layers:
    plans: 200
    sessions: 500
    memories: 300
    team: 200

team:
  enabled: false
  user: ""
  sync: git
```

Substitute the user's chosen LLM provider, model, and base URL into the `intelligence.llm` section, and the chosen embedding provider, model, and base URL into the `intelligence.embedding` section. Set `team.enabled` and `team.user` based on Step 3.

## Step 5: Write `.myco/.gitignore` (or `<vault>/.gitignore`)

Exclude `index.db`, buffers, `.obsidian/` from git.

## Step 6: Register MCP server

Register the MCP server in the project's `.mcp.json`.

## Step 7: Setup summary

After setup, display a summary including:

| Setting | Value |
|---------|-------|
| Vault path | `<resolved path>` (`<vault path source>`) |
| LLM provider | `<provider>` / `<model>` |
| Embedding provider | `<provider>` / `<model>` |
| Team mode | `<enabled/disabled>` |

Then confirm everything is working by running a test query against the vault.
