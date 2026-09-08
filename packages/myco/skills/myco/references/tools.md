# The Myco tool surface

Seven tools. Every one takes `project` — a project id or the repository's git remote. Reads fall back to the credential's own project; writes without it are refused.

## myco_search

One argument that matters: `query`. Returns ranked hits across spores, sessions and plans, each with an id and a one-line preview.

The preview is for choosing. Fetch the hit in full with the tool that owns it.

## myco_cortex

| Operation | Answers |
|---|---|
| `instructions` (default) | this project's standing guidance, and its project id |
| `notifications` | pending operator notifications |
| `maintenance_summary` | whether anything needs an operator's attention |
| `projects_activity` | which projects are still active |

`instructions` is the one to reach for. It is also how you learn the project id to pass as `project` on a write.

Some operations the schema still lists answer `not_served`. That is a terminal answer, not an outage.

## myco_spores

| Operation | Does |
|---|---|
| `list` (default) | recent spores |
| `get` | one spore in full, by id |
| `save` | record a new observation |
| `supersede` | replace an existing spore, keeping the lineage |

`save` and `supersede` need `project`. `type` names the kind of observation — `gotcha`, `decision` and the rest of the vocabulary the schema lists.

An external agent with a per-project access key reaches `list`, `get`, `save` and `supersede` and nothing else, and its writes are attributed to the key rather than to a person.

## myco_plans

`list` (default), `get`, `save`, `delete`.

`save` creates a plan or updates one when given an `id`. Content is optional on update: omitting it makes the call a status-only transition. Status runs `active` (written, not started) → `in_progress` (being worked) → `completed` or `abandoned`.

## myco_sessions

`list` (default) and `get`. A session is the record of one agent conversation: what was asked, what was done, what came out of it. `get` by id is how you read what an earlier session actually did rather than guessing from the diff.

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
