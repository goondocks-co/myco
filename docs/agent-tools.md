# Agent tools

Myco gives your coding agents tools for reading project knowledge and recording what they learn. The tools are served by your Myco at `/mcp`; connected agents discover them automatically. Hosted reviewers use a project access key on the same endpoint; see [External agents](external-agents.md).

## Context without a tool call

Project instructions arrive at session start. Relevant spores and plans return with each prompt. The project's **Context for sessions** switch is on by default. Tools let an agent search deeper, revisit a session or save a discovery during its work.

## The eight tools

| Tool | Operations | What it is for |
|---|---|---|
| `myco_search` | Search | Find sessions, spores, plans, skills, prompts and responses. Results carry stable IDs and retrieval hints. |
| `myco_cortex` | `instructions`, `canopy_map`, `projects_activity`, `prompt_preview` | Read standing guidance and the project ID, read the repository's code map, see project activity, or preview what memory a prompt would attach and why. |
| `myco_plans` | `list`, `get`, `save` | Read and maintain plans. |
| `myco_sessions` | `list`, `get` | Revisit captured sessions. |
| `myco_skills` | `list`, `get` | Find the skills shipped with Myco and where their bodies are installed. |
| `myco_spores` | `list`, `get`, `save`, `supersede`, `consolidate`, `obsolete` | Record durable knowledge and retire or replace stale findings. |
| `myco_agent` | `runs`, `run` | Read Myco's task run history and details. |
| `myco_outcomes` | `list`, `report` | Record each pull request, issue, tag, release or deploy you created in this session, and read what a session recorded. |

These tools read and edit project intelligence. Administration belongs in the dashboard and CLI. See [Actors & boundaries](architecture/actors-and-boundaries.md).

### Word search

`myco_search` searches sessions, spores, plans and conversation cards. Use `mode: "fts"` to search
words. Search by meaning falls back to words when it cannot answer. `match: "all"` requires every
searched word, including words held across a plan's title and stored body. `match: "any"` accepts
any searched word.

Word search returns its best matches first, with title or line matches counted twice as much as body
matches. It ranks the newest matches together with every match of the question's less common words,
however old. A word found in more than 128 records of one kind is too common to bring older records
in for that kind, but still counts when scoring; `candidateWords` lists those words by kind (`chunk`
means a stored plan body). `nextCursor` continues through the remaining matches, newest first. Ties
favor newer records.

`partial: true` means more history remains outside the current window. `coverage.horizon` gives
the window's time edge when newer history was selected, otherwise null. A partial answer can have
no hits when its filters exclude the current window; follow `nextCursor` to continue checking.
`coverage.state` and `pendingBlobs` report whether older records or stored plan bodies are still
being made searchable. Later pages remain available for 15 minutes after the second page; restart
without a cursor after `cursor_expired`. `order: "time"` lists one type (spore, plan or card) oldest first.

Repeated words and case variants count once. Questions with more than 16 distinct meaningful words
use the rarer words; `wordTruncation` reports `actual`, `searched` and the selected `words`, including
fallback from search by meaning. A short or long `match: "all"` question holding a word absent from
the records returns no hits. Search by meaning still uses the whole original question.

Example: `{"query":"repair windows service absolute path","type":"spore","mode":"fts","match":"any"}`.

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
