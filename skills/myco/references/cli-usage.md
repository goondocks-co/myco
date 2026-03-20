# Myco CLI Reference

All CLI commands are invoked as:

    node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js <command> [flags]

Where `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin root directory (set by the agent automatically).

---

## Setup Commands

### `init` — Create vault structure and base config

Initializes a new Myco vault. Skipped automatically if the vault is already initialized.

| Flag | Type | Description |
|------|------|-------------|
| `--vault <path>` | string | Custom vault directory (supports `~/` expansion) |
| `--llm-provider <name>` | string | `ollama`, `lm-studio`, or `anthropic` |
| `--llm-model <name>` | string | Model name |
| `--llm-url <url>` | string | Provider base URL |
| `--embedding-provider <name>` | string | `ollama` or `lm-studio` |
| `--embedding-model <name>` | string | Embedding model name |
| `--embedding-url <url>` | string | Embedding provider base URL |
| `--user <name>` | string | Username for team-enabled vault |
| `--team` | boolean | Enable team collaboration mode |
| `--tiers <csv>` | string | Comma-separated digest tier list (e.g., `1500,3000,5000`) |
| `--inject-tier <number>` | number | Tier to auto-inject at session start |
| `--context-window <number>` | number | Context window size for digest operations |

**Example:**

```sh
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js init \
  --llm-provider ollama \
  --llm-model qwen2.5-coder:14b \
  --embedding-provider ollama \
  --embedding-model nomic-embed-text
```

---

### `setup-llm` — Change LLM and embedding provider settings

Reconfigures intelligence backend without reinitializing the vault.

| Flag | Type | Description |
|------|------|-------------|
| `--llm-provider <name>` | string | Provider name (`ollama`, `lm-studio`, `anthropic`) |
| `--llm-model <name>` | string | Model name |
| `--llm-url <url>` | string | Provider base URL |
| `--llm-context-window <number>` | number | Context window in tokens |
| `--llm-max-tokens <number>` | number | Max output tokens |
| `--embedding-provider <name>` | string | Embedding provider name |
| `--embedding-model <name>` | string | Embedding model name |
| `--embedding-url <url>` | string | Embedding base URL |
| `--show` | boolean | Display current settings and exit |

Note: changing the embedding model requires running `rebuild` afterward to re-embed all vault notes with the new model.

**Example:**

```sh
# Show current settings
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-llm --show

# Switch to Anthropic
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-llm \
  --llm-provider anthropic \
  --llm-model claude-opus-4-5
```

---

### `setup-digest` — Configure digest and capture settings

Controls the continuous reasoning system: metabolism timing, tier configuration, and per-operation token budgets.

| Flag | Type | Description |
|------|------|-------------|
| `--enabled <true\|false>` | boolean | Enable or disable digest |
| `--tiers <csv>` | string | Comma-separated token tier list |
| `--inject-tier <number\|null>` | number\|null | Auto-inject tier at session start (`null` to disable) |
| `--provider <name\|null>` | string\|null | Digest-specific provider (`null` = inherit from main LLM) |
| `--model <name\|null>` | string\|null | Digest-specific model (`null` = inherit) |
| `--base-url <url\|null>` | string\|null | Digest provider base URL (`null` = inherit) |
| `--context-window <number>` | number | Context window for digest |
| `--keep-alive <duration>` | string | Keep model loaded (Ollama only, e.g., `30m`) |
| `--gpu-kv-cache <true\|false>` | boolean | GPU KV cache offload (LM Studio only) |
| `--active-interval <seconds>` | number | Metabolism active processing interval |
| `--dormancy-threshold <seconds>` | number | Time before entering dormancy |
| `--max-notes <number>` | number | Max substrate notes per digest cycle |
| `--extraction-tokens <number>` | number | Max tokens for spore extraction |
| `--summary-tokens <number>` | number | Max tokens for session summaries |
| `--title-tokens <number>` | number | Max tokens for session titles |
| `--classification-tokens <number>` | number | Max tokens for artifact classification |
| `--show` | boolean | Display current settings and exit |

**Example:**

```sh
# Show current digest config
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-digest --show

# Use a faster model just for digest, with shorter active interval
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js setup-digest \
  --model qwen2.5:7b \
  --active-interval 120 \
  --dormancy-threshold 600
```

---

### `config get/set` — Read/write individual config keys

Direct access to vault config via dot-path notation. Values are parsed as JSON first, then fall back to raw strings.

**Usage:**

```sh
# Read a value
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js config get intelligence.llm.model

# Write a value
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js config set intelligence.llm.model qwen2.5-coder:14b

# Write a non-string value (parsed as JSON)
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js config set digest.enabled true
```

Restart the daemon after changes: `node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js restart`

---

## Diagnostic Commands

### `detect-providers` — Probe available LLM providers

Checks Ollama, LM Studio, and Anthropic for availability and lists discovered models.

No flags.

Output is JSON:

```json
{
  "ollama": { "available": true, "models": ["qwen2.5-coder:14b", "nomic-embed-text"] },
  "lm-studio": { "available": false, "models": [] },
  "anthropic": { "available": true, "models": [] }
}
```

---

### `verify` — Test LLM and embedding connectivity

Sends a test prompt to the LLM and a test embed to the embedding provider. Exits 0 if both pass, 1 if either fails.

No flags.

```sh
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js verify
```

---

### `stats` — Vault health and daemon status

Shows session/spore/plan counts, spore type breakdown, vector count, and daemon PID/port.

No flags.

```sh
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js stats
```

Typical output:

```
Sessions:  12
Spores:    47  (decision: 15, gotcha: 12, trade_off: 8, discovery: 7, bug_fix: 5)
Plans:     2
Vectors:   61

Daemon:    PID 38291 on port 60942 (2 active sessions)
```

---

### `logs` — Tail, filter, and follow daemon logs

| Flag | Type | Description |
|------|------|-------------|
| `-f` / `--follow` | boolean | Watch for new log entries (blocks until Ctrl+C) |
| `-n` / `--tail <number>` | number | Number of lines to show (default: 100) |
| `-l` / `--level <level>` | string | Filter by level: `debug`, `info`, `warning`, `error` |
| `-c` / `--component <name>` | string | Filter by component |
| `--since <timestamp>` | string | Show logs after ISO timestamp |
| `--until <timestamp>` | string | Show logs before ISO timestamp |

Components: `processor`, `embeddings`, `hooks`, `lifecycle`, `daemon`, `lineage`, `watcher`

**Examples:**

```sh
# Show last 20 lines
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js logs -n 20

# Follow errors from the processor
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js logs -f -l error -c processor

# Show logs from a specific window
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js logs \
  --since 2025-01-01T10:00:00Z \
  --until 2025-01-01T11:00:00Z
```

---

## Query Commands

### `search <query>` — Combined semantic + FTS search

Runs semantic search (primary) with FTS fallback across sessions, spores, and plans.

```sh
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js search "why did we choose sqlite over postgres"
```

---

### `vectors <query>` — Raw vector similarity scores

Shows all results with similarity scores and no threshold filtering. Useful for tuning embedding thresholds.

```sh
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js vectors "session lifecycle hooks"
```

---

### `session [id|latest]` — Display a session note

| Argument | Description |
|----------|-------------|
| `latest` | Show the most recent session (default if omitted) |
| `<id>` | Session ID substring — matches the first session containing the substring |

```sh
# Show latest session
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js session

# Show a specific session by partial ID
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js session ac5220
```

---

## Maintenance Commands

### `restart` — Kill and respawn the daemon

Sends SIGTERM to the running daemon, waits for it to exit, and spawns a fresh instance with a health check.

No flags.

```sh
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js restart
```

Run this after any daemon code changes to pick up new behavior.

---

### `rebuild` — Full FTS + vector reindex

Re-indexes all vault notes. Superseded and archived spores are skipped.

No flags.

```sh
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js rebuild
```

Run this after changing the embedding model (via `setup-llm`) to regenerate all embeddings with the new model.

---

### `reprocess` — Re-extract observations from transcripts

Re-reads session transcripts, re-extracts observations with the current LLM, and re-indexes. Existing spores are preserved — new extractions are additive.

| Flag | Type | Description |
|------|------|-------------|
| `--session <id>` | string | Session ID substring — reprocess only matching sessions |
| `--index-only` | boolean | Skip LLM extraction, FTS-only reindex |

**Examples:**

```sh
# Reprocess all sessions
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js reprocess

# Reprocess one session
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js reprocess --session ac5220

# Re-index without re-extracting
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js reprocess --index-only
```

---

## Info Commands

### `version` — Show plugin version

```sh
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js version
```

Also available as `--version` or `-v`.
