---
name: myco-init
description: Initialize Myco in the current project — sets up vault, config, and intelligence backend
---

# Initialize Myco

Set up Myco for this project. Guide the user through:

## Step 0: Detect vault location

The vault defaults to `.myco/` in the project root — the team's intelligence lives with the code and is committed to git.

Check whether `MYCO_VAULT_DIR` is set as an override:

- Check the process environment for `MYCO_VAULT_DIR`
- Also check `.claude/settings.json` under the `env` key for `MYCO_VAULT_DIR`
- If found and non-empty, use that path instead — **do not ask the user where to put the vault**
- If not found, use `.myco/` in the project root (the default)

The `MYCO_VAULT_DIR` override is for public repos or cases where the vault should be kept separate from the codebase. For most private projects, the default is correct.

Record the **vault path source** for use in the setup summary:
- `"from MYCO_VAULT_DIR env"` — if the env var override was set
- `"default (.myco/)"` — project-local vault (recommended for private repos)

## Step 1: Create vault directory

Create the vault directory (at the resolved path from Step 0) with subdirectories:
`sessions`, `plans`, `memories`, `artifacts`, `team`, `buffer`, `logs`

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
- **Anthropic** — uses existing `ANTHROPIC_API_KEY`, verify it's set

For the selected provider, list available models and let the user choose. Also set:
- `context_window` (default 8192) — only for local providers, not Anthropic
- `max_tokens` (default 1024)

### Embedding provider

Ask the user to choose an embedding provider. **Anthropic is not an option here** — it doesn't support embeddings.

- **Ollama** — detect at `http://localhost:11434/api/tags`, list available models, recommend `bge-m3` or `nomic-embed-text`
- **LM Studio** — detect at `http://localhost:1234/v1/models`, list available models

For the selected provider, list available models and let the user choose.

## Step 3: Team / solo setup

Ask whether this is a team or solo project:

- **Solo** — vault stays local, not tracked by git
- **Team** — set up git tracking for the vault directory, ask for username

If `MYCO_VAULT_DIR` is set in the environment, also offer:
- **Use MYCO_VAULT_DIR from env** — treat the env-specified vault as a shared/external vault managed outside this repo; skip git tracking

## Step 4: Write `myco.yaml`

Write a `version: 2` config file with chosen settings. **All configurable values must be explicit** — no hidden schema defaults. Example output:

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
    - .claude/plans/
    - .cursor/plans/
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

Substitute the user's chosen providers, models, and base URLs. Set `team.enabled`, `team.user`, and `team.sync` based on Step 3.

## Step 5: Write vault `.gitignore`

Create a `.gitignore` inside the `.myco/` vault directory to exclude runtime artifacts while committing the knowledge:

```
# Runtime — rebuilt on daemon startup
index.db
index.db-wal
index.db-shm
vectors.db

# Daemon state — per-machine, ephemeral
daemon.json
buffer/
logs/

# Obsidian — per-user workspace config
.obsidian/
```

Everything else is committed: `myco.yaml`, `sessions/`, `memories/`, `plans/`, `artifacts/`, `team/`, `lineage.json`, `_dashboard.md`. This is the project's institutional memory — it travels with the code.

## Step 6: Vault discovery and MCP

The default `.myco/` vault location requires no configuration — the vault resolver finds it automatically in the project root.

### If the user chose an external vault (MYCO_VAULT_DIR override)

Set `MYCO_VAULT_DIR` in the agent's settings so hooks and the MCP server can find the vault:

**Claude Code** — write to `.claude/settings.json`:
```json
{ "env": { "MYCO_VAULT_DIR": "<external vault path>" } }
```

**Cursor / VS Code** — instruct the user to set `MYCO_VAULT_DIR` in their shell profile (`~/.zshrc`, `~/.bashrc`), or set it in the MCP server's env block if configuring manually.

### MCP server registration

All three agents (Claude Code, Cursor, VS Code Copilot) auto-discover the MCP server from the plugin manifest when installed via the marketplace. No manual `.mcp.json` editing is needed.

## Step 7: Setup summary

After setup, display a summary:

| Setting | Value |
|---------|-------|
| Vault path | `<resolved path>` (`<vault path source>`) |
| LLM provider | `<provider>` / `<model>` |
| Embedding provider | `<provider>` / `<model>` |
| Context window | `<context_window>` |
| Team mode | `<enabled/disabled>` |

Then confirm everything is working:
1. Verify the LLM provider is reachable (call `isAvailable()`)
2. Verify the embedding provider is reachable (call `isAvailable()`)
3. Run a test embedding to confirm dimensions
4. Report success or issues found
