# Vault Health Reference

This reference guides vault health assessment. Use it whenever you need to inspect the state of the Myco vault — whether debugging a problem, responding to a user's question about their vault, or running a routine check.

**Primary data source:** `node .agents/myco-cli.cjs stats`

Supplement with `logs` for recent daemon activity and `myco_cortex` for Cortex/digest status.

---

## Running Stats

Run the stats command to get a snapshot of vault state:

```sh
node .agents/myco-cli.cjs stats
```

The output includes:

- **Session/spore/plan counts** — total notes in each category
- **Spore type breakdown** — counts per observation type (decision, gotcha, trade_off, discovery, bug_fix, etc.)
- **Vector count** — number of indexed embeddings
- **Daemon PID/port/active sessions** — runtime state

Typical output looks like:

```
Sessions:  12
Spores:    47  (decision: 15, gotcha: 12, trade_off: 8, discovery: 7, bug_fix: 5)
Plans:     2
Vectors:   61

Daemon:    PID 38291 on port 60942 (2 active sessions)
```

If the command fails or returns no output, the daemon may not be running or the vault may not be configured. Check daemon status next.

---

## Daemon Health

The daemon runs as a background HTTP process. Its state is persisted in `<vault>/daemon.json`.

**To check daemon status:**

1. Read `<vault>/daemon.json` for the PID and port.
2. Verify the PID is alive: `kill -0 <pid>` returns 0 if running.
3. HTTP health check: `curl http://localhost:<port>/health`

**If the daemon is not running:**

> "Daemon not running. It will start automatically on next session."

You can also restart it manually:

```sh
node .agents/myco-cli.cjs restart
```

Do not treat a stopped daemon as a vault error — it is normal between sessions. The daemon starts on demand when a session begins.

---

## Digest Status

The digest system synthesizes vault knowledge into pre-computed context extracts served through Cortex.

**Is digest enabled?**

Read scoped Cortex config through the UI or config surface. The session-start toggles are under `cortex.instructions.*` and `cortex.digest.*`.

**Which extracts exist?**

Use `myco_cortex` to request the tier you care about:

```sh
node .agents/myco-cli.cjs tool call myco_cortex --json --input '{"op":"digest","tier":1500}'
node .agents/myco-cli.cjs tool call myco_cortex --json --input '{"op":"digest","tier":5000}'
```

Missing or not-ready responses mean the digest has not been generated for that tier yet or Cortex is disabled for the project.

---

## Intelligence Backend Health

Test connectivity to the configured embedding provider:

```sh
node .agents/myco-cli.cjs verify
```

This reports whether the embedding provider is reachable. The Myco agent LLM is managed by the agent harness. If embedding verification fails:

- Check that the provider process is running (Ollama, LM Studio, etc.)
- Review Grove-tier embedding settings with `node .agents/myco-cli.cjs setup-llm --show`
- Re-run configuration with `setup-llm`

---

## Issue Detection

Check for these problems when assessing vault health:

| Issue | How to detect | Meaning |
|-------|--------------|---------|
| **Stale buffers** | `.jsonl` files in `<vault>/buffer/` older than 24 hours | Events were captured but never processed — LLM may have been unavailable |
| **Missing vault DB** | `<vault>/myco.db` does not exist | The vault database is missing or the project is not initialized; suggest `myco init` or check vault resolution |
| **Missing vectors** | `<vault>/vectors.db` does not exist | Semantic search disabled; embeddings may be unconfigured |
| **Old config version** | `version` in `myco.yaml` is stale | Vault may need migration; suggest running `myco init` or `myco update` |

Report all issues found, or "None found." if the vault is clean.

---

## Recent Activity

View recent daemon log output:

```sh
node .agents/myco-cli.cjs logs -n 20
```

This shows the last 20 lines of daemon logs — useful for spotting errors, slow processing, or repeated failures.

Also report the last 3 sessions with:

- Session ID (short form)
- Title
- Started/ended timestamps
- Number of spores extracted
- Parent session, if lineage was detected

---

## Report Format

Present vault health as a structured report. Always show all sections; use "None" rather than omitting sections with no data.

```
=== Myco Vault ===
Path: <vault-path>
Config: v<version>

--- Intelligence ---
LLM:       <provider> / <model> (<reachable|unreachable>)
Embedding: <provider> / <model> (<reachable|unreachable>)

--- Daemon ---
PID:      <pid> (<running|stopped>)
Port:     <port>
Sessions: <count> active

--- Vault ---
Sessions:  <count>
Spores:    <total> (<breakdown by type>)
Plans:     <count>
Vectors:   <count>

--- Digest ---
Enabled:    <yes|no>
Tiers:      <list>
Inject:     <tier>
Model:      <model> (<inherited|configured>)
Last cycle: <id> (<time ago>, <tiers>, <notes>, <duration>)
Extracts:   <tier> (<size>), ...

--- Lineage ---
Links: <count> (<breakdown by type>)

--- Recent Sessions ---
1. [<id>] "<title>" (<duration>, <spore count> spores)
2. [<id>] "<title>" (<duration>, <spore count> spores, parent: <id>)
3. [<id>] "<title>" (<duration>, <spore count> spores)

--- Issues ---
<issues or "None found.">
```

Adapt to what is actually available. If the daemon is stopped, omit PID/port/sessions. If digest is disabled, abbreviate that section. Keep the structure recognizable.

---

## Lineage

If `<vault>/lineage.json` exists, report the link count and breakdown:

- **clear** — session explicitly resumed a prior session
- **inferred** — heuristic match based on timing or working directory
- **semantic_similarity** — matched by content similarity of opening context

Lineage tracks parent-child relationships between sessions. A high count of `semantic_similarity` links (relative to `clear`) may indicate sessions that should be explicitly resumed rather than started fresh.

---

## Suggested Actions

| Issue | Action |
|-------|--------|
| Daemon not running | Will auto-start on next session; or run `node .agents/myco-cli.cjs restart` |
| Stale buffers | Check if LLM provider was down during those sessions; events will process on next daemon start |
| Missing index | Run `node .agents/myco-cli.cjs rebuild` to regenerate FTS and vector indexes |
| Provider unreachable | Ensure the provider is running (e.g., `ollama serve`); verify model name in `myco.yaml`; reconfigure with CLI commands |
| Config version < 2 | Run `myco init` to migrate the vault configuration |
