---
name: myco-curate
description: >-
  Trigger the Myco curation agent to process unprocessed session data,
  extract observations, and maintain the vault knowledge graph
user-invocable: true
allowed-tools: Bash
---

# Myco Curate — Run the Curation Agent

This skill triggers a curation agent run via the daemon API. The curation agent processes unprocessed prompt batches, extracts observations (spores), and maintains the vault's knowledge graph.

## Arguments

The user may provide:
- **task name** — which curation task to run (e.g., "full-curation", "extraction-only")
- **instruction** — free-text instruction to guide the agent's focus

Parse the user's message for these. Both are optional.

## Step 1: Resolve Daemon Port

Read the daemon.json file to find the running daemon's port:

```bash
cat "$(node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js stats 2>/dev/null | grep -oP 'path: \K.*' || echo ~/.myco/vaults/myco)/daemon.json" 2>/dev/null
```

If that fails, use the vault directory from the environment. The daemon.json contains `{ "pid": ..., "port": ... }`. Extract the `port` value.

If the daemon is not running, tell the user:

> "The Myco daemon is not running. Start a new session or run `node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js restart` to start it."

## Step 2: Trigger Curation Run

Send a POST request to the daemon API:

```bash
curl -s -X POST http://localhost:<port>/api/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"task": "<task-name-or-null>", "instruction": "<instruction-or-null>"}'
```

Omit `task` and `instruction` fields from the JSON body if they were not provided by the user.

Report the response to the user. The response will be `{ "ok": true, "message": "Curation agent started" }`.

## Step 3: Check Run Status

The curation agent runs in the background. To check its progress, poll the runs endpoint:

```bash
curl -s http://localhost:<port>/api/agent/runs?limit=1
```

This returns the most recent run. Show the user:
- **Run ID** — the unique identifier
- **Status** — pending, running, completed, failed, or skipped
- **Task** — which task was executed
- **Tokens used** — total tokens consumed (if completed)
- **Cost** — USD cost (if completed)
- **Error** — error message (if failed)

If the run is still `running`, tell the user they can check again later or wait.

## Step 4: Show Reports (if completed)

If the run completed, fetch the decision reports:

```bash
curl -s http://localhost:<port>/api/agent/runs/<run-id>/reports
```

Summarize the reports for the user:
- How many actions were taken
- What types of actions (extraction, consolidation, supersession, etc.)
- Key observations or decisions made

## Constraints

- Always use the daemon API, never call the executor directly from the skill.
- The curation agent runs asynchronously — the POST returns immediately.
- If the user asks for a specific task, pass it in the `task` field.
- If the user provides natural language guidance, pass it in the `instruction` field.
