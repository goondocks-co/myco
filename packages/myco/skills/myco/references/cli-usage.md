# Myco CLI Reference

In an initialized project, prefer the `myco` CLI:

    myco <command> [flags]

It honors project and worktree runtime pins — the binary walks up from the working directory for `.myco/runtime.command`. When `myco` is not on PATH (e.g. GUI- or launchd-spawned agents), use the absolute global launcher `node ~/.myco/launcher.cjs <command> [flags]`, which resolves the same pins.

---

## Setup Commands

### `init` — Create vault structure and base config

Initializes a new Myco vault. Skipped automatically if the vault is already initialized.

| Flag | Type | Description |
|------|------|-------------|
| `--project <path>` | string | Project root to initialize |
| `--grove <name\|id>` | string | Grove to bind this project to |
| `--worktree` | boolean | Bootstrap hook files in a git worktree |
| `--non-interactive` | boolean | Run without prompts |
| `--embedding-provider <name>` | string | Embedding provider for new vaults |
| `--embedding-model <name>` | string | Embedding model name |
| `--embedding-url <url>` | string | Embedding provider base URL |

**Example:**

```sh
myco init \
  --embedding-provider ollama \
  --embedding-model bge-m3
```

---

### `setup-llm` — Change embedding provider settings

Reconfigures Grove-tier embedding settings without reinitializing the vault. LLM configuration is managed by the Myco agent harness; `setup-llm` ignores legacy `--llm-*` flags.

| Flag | Type | Description |
|------|------|-------------|
| `--embedding-provider <name>` | string | Embedding provider name |
| `--embedding-model <name>` | string | Embedding model name |
| `--embedding-url <url>` | string | Embedding base URL |
| `--show` | boolean | Display current settings and exit |

Note: changing the embedding model requires running `rebuild` afterward to re-embed all records with the new model.

**Example:**

```sh
# Show current settings
myco setup-llm --show

# Change embedding model
myco setup-llm \
  --embedding-provider ollama \
  --embedding-model bge-m3
```

---

### `setup-digest` — Deprecated

Digest and Cortex configuration now live in the normal scoped config/UI surfaces. `setup-digest` prints a deprecation message and points users back to `setup-llm` for embedding settings.

---

### `config get/set` — Read/write individual config keys

Direct access to vault config via dot-path notation. Values are parsed as JSON first, then fall back to raw strings.

**Usage:**

```sh
# Read a value
myco config get cortex.instructions.inject_on_session_start

# Write a value
myco config set cortex.instructions.inject_on_session_start true

# Write a non-string value (parsed as JSON)
myco config set cortex.spores.max_per_prompt 3
```

Restart the daemon after changes that affect runtime behavior: `myco restart`

---

## Diagnostic Commands

### `detect-providers` — Probe available LLM providers

Checks Ollama, LM Studio, and Anthropic for availability and lists discovered models.

No flags.

Output is JSON:

```json
{
  "ollama": { "available": true, "models": ["qwen2.5-coder:14b", "bge-m3"] },
  "lm-studio": { "available": false, "models": [] },
  "anthropic": { "available": true, "models": [] }
}
```

---

### `verify` — Test LLM and embedding connectivity

Sends a test embed to the configured embedding provider. Exits 0 if it passes, 1 if it fails. LLM configuration is managed by the Myco agent harness.

No flags.

```sh
myco verify
```

---

### `stats` — Vault health and daemon status

Shows session/spore/plan counts, spore type breakdown, vector count, and daemon PID/port.

No flags.

```sh
myco stats
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
myco logs -n 20

# Follow errors from the processor
myco logs -f -l error -c processor

# Show logs from a specific window
myco logs \
  --since 2025-01-01T10:00:00Z \
  --until 2025-01-01T11:00:00Z
```

---

## Query Commands

### `search <query>` — Combined semantic + FTS search

Runs semantic search (primary) with FTS fallback across sessions, spores, and plans.

```sh
myco search "why did we choose sqlite over postgres"
```

---

### `vectors <query>` — Raw vector similarity scores

Shows all results with similarity scores and no threshold filtering. Useful for tuning embedding thresholds.

```sh
myco vectors "session lifecycle hooks"
```

---

### `session [id|latest]` — Display a session record

| Argument | Description |
|----------|-------------|
| `latest` | Show the most recent session (default if omitted) |
| `<id>` | Session ID substring — matches the first session containing the substring |

```sh
# Show latest session
myco session

# Show a specific session by partial ID
myco session ac5220
```

---

## Maintenance Commands

### `restart` — Kill and respawn the daemon

Sends SIGTERM to the running daemon, waits for it to exit, and spawns a fresh instance with a health check.

No flags.

```sh
myco restart
```

Run this after any daemon code changes to pick up new behavior.

---

### `rebuild` — Full FTS + vector reindex

Re-indexes all records. Superseded and archived spores are skipped.

No flags.

```sh
myco rebuild
```

Run this after changing the embedding model (via `setup-llm`) to regenerate all embeddings with the new model.

---

### `digest` — Run a digest cycle on demand

Trigger a digest cycle manually. Use `--tier` to reprocess a specific tier from scratch (all substrate, no previous extract), or `--full` for a complete rebuild of all tiers.

| Flag | Type | Description |
|------|------|-------------|
| `--tier <number>` | number | Reprocess a specific tier (clean slate) |
| `--full` | boolean | Reprocess all tiers from scratch |

When `--tier` or `--full` is used, the cycle reads all records (ignoring the last-cycle timestamp) and skips the previous extract, producing a fresh synthesis.

**Examples:**

```sh
# Run an incremental cycle (same as what the metabolism timer does)
myco digest

# Reprocess tier 3000 from scratch
myco digest --tier 3000

# Full rebuild of all tiers
myco digest --full
```

---

### `agent` — Run the intelligence agent

Runs the intelligence agent to process unprocessed session data, extract observations, build the knowledge graph, and supersede stale spores.

| Flag | Type | Description |
|------|------|-------------|
| `--task <name>` | string | Which task to run (e.g., `vault-evolve`, `extract-only`) |
| `--instruction <text>` | string | Free-text instruction to guide the agent's focus |
| `--dry-run` | boolean | Run LLM evaluation but print results without writing |

**Examples:**

```sh
# Run the default intelligence task
myco agent

# Preview what would be changed
myco agent --dry-run
```

Note: `--dry-run` still runs LLM calls (to evaluate) — it just skips the writes. Use it to review before running on a vault for the first time.

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
myco reprocess

# Reprocess one session
myco reprocess --session ac5220

# Re-index without re-extracting
myco reprocess --index-only
```

---

## Info Commands

### `version` — Show plugin version

```sh
myco version
```

Also available as `--version` or `-v`.
