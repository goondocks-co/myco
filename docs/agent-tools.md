# Agent tools

Myco gives your coding agents tools for reading project knowledge and recording what they learn. The tools are served by your Myco at `/mcp`; connected agents discover them automatically. Hosted reviewers use a project access key on the same endpoint; see [External agents](external-agents.md).

## Context without a tool call

Project instructions arrive at session start. Relevant spores and plans return with each prompt. The project's **Context for sessions** switch is on by default. Tools let an agent search deeper, revisit a session or save a discovery during its work.

## The eight tools

| Tool | Operations | What it is for |
|---|---|---|
| `myco_search` | Search | Find sessions, spores, plans, skills, prompts and responses. Results carry stable IDs and retrieval hints. |
| `myco_cortex` | `instructions`, `canopy_map`, `projects_activity` | Read standing guidance and the project ID, read the repository's code map, or see project activity. |
| `myco_plans` | `list`, `get`, `save` | Read and maintain plans. |
| `myco_sessions` | `list`, `get` | Revisit captured sessions. |
| `myco_skills` | `list`, `get` | Find the skills shipped with Myco and where their bodies are installed. |
| `myco_spores` | `list`, `get`, `save`, `supersede`, `consolidate`, `obsolete` | Record durable knowledge and retire or replace stale findings. |
| `myco_agent` | `runs`, `run` | Read Myco's task run history and details. |
| `myco_outcomes` | `list`, `report` | Record each pull request, issue, tag, release or deploy you created in this session, and read what a session recorded. |

These tools read and edit project intelligence. Administration belongs in the dashboard and CLI. See [Actors & boundaries](architecture/actors-and-boundaries.md).

### Word search

`myco_search` searches sessions, spores, plans and conversation cards. `mode: "fts"` uses words;
semantic search also falls back to words when vectors cannot answer. `match: "all"` requires every
searched word, including words held across a plan's title and stored body. `match: "any"` accepts
any searched word.

Relevance starts with global FTS5 BM25 candidates, with a title or agent line weighted twice body text.
The first window holds up to 500 candidates shared across document kinds, plus bounded candidates
for words split across a plan's documents. It is selected by relevance before a time window is applied.
Its order is stored immediately, so writes to other records cannot reorder its later pages.
`nextCursor` finishes that ranking, then continues through the remaining matches in historical windows,
each ranked within its own window. Later windows are not one global relevance order.

`partial: true` means matches remain outside the current ranking window; it does not mean more hits
than the requested page size. `coverage.horizon` is null for the global window, and gives the historical
window's oldest reached time when that window is partial. `coverage.state` and `pendingBlobs` still
report index completeness. Stored rankings expire after 15 minutes; restart without a cursor after
`cursor_expired`. `order: "time"` lists one type (spore, plan or card) oldest first with its own cursor.

Word search ignores common words and searches at most 16 meaningful words. For longer questions,
bounded frequency probes prefer words with fewer matches in the requested Project, types and indexed
filters. Each probe stops after 17 matches per kind; equally common words retain their input order.
This distinguishes rare words without claiming exact frequency for common words. `wordTruncation`
reports `actual`, `searched` and `words`, including semantic fallback. Semantic search embeds the whole
question. Example: `{"query":"repair windows service absolute path","type":"spore","mode":"fts","match":"any"}`.

D1 billed rows are bounded by the candidate, word and page limits; FTS5's internal ranking CPU still
grows with matching postings. The operation reads the search projection and bounded record lookups,
never event history. No schema change or re-index of stored content is needed.

### Name the project

Every tool accepts `project`: the project ID or the repository's Git remote. Pass it on every call. A read without it may use the connection's default project; a write without it is refused. Use `myco_cortex` with `op: "instructions"` to learn the project ID.

Search first, then fetch the result in full using its retrieval hint. When recording a spore, pass the current `session_id` when known. To supersede one, supply both `old_spore_id` and the existing replacement's `new_spore_id`. Retire a finding with no replacement using `obsolete` and a reason.

```json
{
  "op": "save",
  "project": "<project-id>",
  "type": "discovery",
  "content": "What we learned, where it applies, and why it matters.",
  "agent_line": "When a retried upload stores rows twice, give each upload one id so the retry is ignored."
}
```

### Record what you created

When an agent creates a pull request, issue, tag, release or deploy, it records it with `myco_outcomes` op `report`: its `kind`, its own `artifact_id`, its https `url`, and the agent's own `session_id`. The session page's Outcomes tab lists it beside the commits the session started and ended on, and links it when it is on GitHub. Myco records only what is reported. It never infers an artifact from commits, branch names or tool output. Reporting the same artifact again changes nothing, and the same artifact under another URL is refused. A launcher or CI step without MCP makes the same call through the CLI. The CLI always needs its credential source named. On a machine enrolled as a member, use the member's own credential:

```sh
myco tool call myco_outcomes --credential registry --json --input '{"op":"report","project":"<project-id>","session_id":"<session-id>","kind":"release","artifact_id":"v2.0.0","url":"https://github.com/<owner>/<repo>/releases/tag/v2.0.0"}'
```

In CI, set `MYCO_SERVER_URL`, `MYCO_MEMBER_TOKEN` and `MYCO_PROJECT` (all three) and pass `--credential env` instead.

A 2.0 Deployment does not serve plan deletion or the `myco_cortex` operations `digest`, `canopy_entry`, `notifications` and `maintenance_summary`. The code map is one map per project.

## Shipped skills

The `myco` skill guides ongoing work: when to search, what to read and how to record durable findings. Agents activate it when relevant. The other eight shipped skills are user-invocable; clients that support slash commands expose these names:

| Command | Purpose |
|---|---|
| `/myco-setup` | Install the binary and connect this machine to Myco. |
| `/myco-settings` | Read or change Deployment settings. |
| `/myco-handoff` | Carry a working intention into another session. |
| `/myco-okf` | Build and maintain a project wiki in the repository. |
| `/myco-rules` | Keep project rules small, durable and canonical. |
| `/myco-outcome-tasks` | Author and debug Myco's own tasks. |
| `/myco-server-provisioning` | Provision and maintain a Myco server. |
| `/myco-server-debugging` | Diagnose server refusals and failures. |

Myco 2.0 ships these skills; it does not generate project-specific skills. See [Agents](agents.md) for their installation locations.
