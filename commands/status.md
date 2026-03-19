---
name: myco-status
description: Show Myco vault health, stats, and any pending issues
---

# Myco Status

Check and report the health of the Myco vault and daemon. Use the CLI (`node dist/src/cli.js stats`) for data, and supplement with direct checks where needed.

## Step 1: Resolve vault location

Find the vault directory:
- Check `MYCO_VAULT_DIR` in the environment
- Check `.claude/settings.user.json` (or `.claude/settings.json`) under the `env` key for `MYCO_VAULT_DIR`
- Fall back to `~/.myco/vaults/<project-name>/`

If no vault is found, report: "No Myco vault configured. Run `/myco-init` to set up."

## Step 2: Config health

Read `myco.yaml` from the vault:
- Report config version (should be `2`)
- Report LLM provider and model
- Report embedding provider and model
- Flag any issues (v1 config, missing fields)

## Step 3: Daemon status

Check `daemon.json` in the vault for PID and port:
- Is the daemon process running? (check if PID is alive)
- Is it healthy? (HTTP health check on the reported port)
- Report PID, port, uptime, active sessions
- If not running: "Daemon not running. It will start automatically on next session."

## Step 4: Vault stats

Query the FTS index for counts:

| Metric | How to check |
|--------|-------------|
| Sessions | `index.query({ type: 'session' }).length` |
| Spores | `index.query({ type: 'spore' }).length` |
| Plans | `index.query({ type: 'plan' }).length` |
| Artifacts | `index.query({ type: 'artifact' }).length` |
| Embeddings | Vector index count |

Also report spore breakdown by observation type (decision, gotcha, trade_off, etc.).

## Step 5: Digest status

Check the digest system state:

- **Enabled/disabled**: read `digest.enabled` from `myco.yaml`
- **Extracts**: list which tier files exist in `vault/digest/` (extract-1500.md, etc.) with file sizes and generated timestamps
- **Last cycle**: read last line of `vault/digest/trace.jsonl` — report cycle ID, timestamp, tiers generated, substrate count, duration
- **Metabolism**: report configured tiers, inject tier, and context window
- **Digest model**: if `digest.intelligence.model` is set, show it; otherwise note "inherits from main LLM"

## Step 6: Intelligence backend health

Test connectivity to the configured providers:

- **LLM provider**: call `isAvailable()` — report reachable or not
- **Embedding provider**: call `isAvailable()` — report reachable or not
- If either is unreachable, suggest running `/myco-setup-llm`

## Step 7: Pending issues

Check for problems:

- **Stale buffers**: any `.jsonl` files in `buffer/` older than 24h? These indicate events that were never processed (LLM was unavailable)
- **Missing index**: does `index.db` exist? If not, suggest `node dist/src/cli.js rebuild`
- **Missing vectors**: does `vectors.db` exist? If not, embeddings are disabled
- **Lineage**: does `lineage.json` exist? Report link count if so

## Step 8: Recent activity

Show the 3 most recent sessions with:
- Session ID (short form)
- Title
- Started/ended timestamps
- Number of spores extracted
- Parent session (if lineage detected)

## Output format

Present as a structured report:

```
=== Myco Vault ===
Path: ~/.myco/vaults/myco/
Config: v2 (valid)

--- Intelligence ---
LLM:       ollama / gpt-oss (reachable)
Embedding: ollama / bge-m3 (reachable)

--- Daemon ---
PID:      12345 (running)
Port:     60942
Sessions: 1 active

--- Vault ---
Sessions:  12
Spores:    183 (67 decision, 34 gotcha, 32 trade_off, 20 discovery, 19 bug_fix, 1 cross-cutting)
Plans:     0
Artifacts: 8
Vectors:   224

--- Digest ---
Enabled:    yes
Tiers:      [1500, 3000, 5000, 10000]
Inject:     3000 (auto-inject at session start)
Model:      gpt-oss (inherited from main LLM)
Last cycle: dc-a1b2c3 (2 min ago, 4 tiers, 12 notes, 45s)
Extracts:   1500 (1.1KB), 3000 (4.5KB), 5000 (6.9KB), 10000 (9.6KB)

--- Lineage ---
Links: 5 (3 clear, 1 inferred, 1 semantic_similarity)

--- Recent Sessions ---
1. [abc123] "Auth redesign session" (2h 15m, 5 spores)
2. [def456] "Bug fix for CORS" (45m, 2 spores, parent: abc123)
3. [ghi789] "Config cleanup" (20m, 1 spore)

--- Issues ---
None found.
```

Adapt the format to what's actually available. If sections have no data, show them with "None" rather than omitting them.
