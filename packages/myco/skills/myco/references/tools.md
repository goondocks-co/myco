# The Myco tool surface

Eight tools. Every one takes `project` — a project id or the repository's git remote. Reads fall back to the credential's own project; writes without it are refused.

## myco_search

One argument that matters: `query`. Returns ranked hits across spores, sessions and plans, each with an id and a one-line preview.

The preview is for choosing. Fetch the hit in full with the tool that owns it.

## myco_cortex

| Operation | Answers |
|---|---|
| `instructions` (default) | this project's standing guidance, and its project id |
| `canopy_map` | the repository map |
| `projects_activity` | which projects are still active |
| `prompt_preview` | what memory one prompt would attach, and why |

`instructions` is the one to reach for. It is also how you learn the project id to pass as `project` on a write.

`prompt_preview` takes `prompt` (up to 16,384 characters) and runs the selection the prompt hook runs, with no session and nothing recorded as delivered. It answers the attached items in order, each with the score it was chosen by, the spores left out nearest the cut and the rule that stopped each, the block's text, and `skipped` naming the gate that closed when nothing was attached. Use it to check why a prompt did or did not bring back a spore.

## myco_spores

| Operation | Does |
|---|---|
| `list` (default) | recent spores, each saying whether it holds a vector, whether it was saved or curated and from how many spores, and for a retired one what replaced it; `origin` (`curated` or `saved`) and `min_sources` list and count only those |
| `get` | one spore in full, by id |
| `save` | record a new observation |
| `supersede` | replace an existing spore, keeping the lineage |
| `consolidate` | merge related spores into a wisdom note |
| `obsolete` | retire contradicted knowledge or a feature dropped by decision |

Writes need `project`. Pass the current `session_id` when there is one; member spore writes are accepted without it. Explicit PR/commit provenance is optional for members. `save` and `consolidate` also need an actionable `agent_line` of at most 158 characters: the situation in plain words, then the guidance. A line carrying a file path, flag or code symbol is refused; keep those in `content`. `type` names the kind of observation — `gotcha`, `decision` and the rest of the vocabulary the schema lists.

An external agent with a per-project access key reaches `list`, `get`, `save` and `supersede` and nothing else, and its writes are attributed to the key rather than to a person.

## myco_plans

`list` (default), `get`, `save`. Retain an unused plan as `abandoned`.

`save` requires `project` and the current `session_id`. Create with content and exactly one of `source_path` (file-backed) or `plan_key` (non-file-backed); update by `id` to preserve identity. Content is optional on update: omitting it makes the call a status-only transition. Status runs `active` (written, not started) → `in_progress` (being worked) → `completed` or `abandoned`.

## myco_sessions

`list` (default) and `get`. A session is the record of one agent conversation: what was asked, what was done, what came out of it. `get` by id is how you read what an earlier session actually did rather than guessing from the diff.

## myco_outcomes

`list` (default) and `report`. `report` records one pull request, issue, tag, release or deploy you created in this session. It takes `session_id` (your own, from the `Session::` line), `kind` (`pr`, `issue`, `tag`, `release` or `deploy`), `artifact_id` (its own id: a number, a tag name, a release or deploy id), `url` (https, with no user name or password) and `project`. The answer carries `created`: true the first time, false for the same report again. The same artifact under a different URL is refused. A session that is not yours, or that was deleted, gets `session_id not found`. `list` takes a `session_id` and pages with `cursor`. Through the CLI, name the credential source: the complete `myco tool call` example in the main skill on an enrolled machine, or `--credential env` with `MYCO_SERVER_URL`, `MYCO_MEMBER_TOKEN` and `MYCO_PROJECT` set.

## myco_skills

`list` (default) and `get`. Every shipped skill with the text a client lists it by, and for one skill, where its body sits on this machine.

No body comes back over the tool. A machine running the Myco binary holds every body under its Myco home, and `get` names that path; an external access key holds none, and is told so rather than handed a path to a file it does not have. The answer does not vary by project, though it takes `project` like every other tool.

## myco_agent

Read-only over Myco's own runs — what it ran, what came out, and what evidence was verified. You will rarely need it.

## Refusal names

| Name | Means |
|---|---|
| a missing-project refusal on a write | pass `project` |
| `unknown_tool` | that operation is not on your credential's surface |
| not found | the project does not exist, or your credential cannot see it |
| `not_served` | the operation exists in the schema and this deployment does not answer it |

All are terminal. Change the call or stop; do not retry unchanged.
