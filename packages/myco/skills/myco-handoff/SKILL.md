---
name: myco-handoff
description: >-
  Carry a session's working intention to another session or another agent.
  PREPARE compresses why we are here, what we are doing, the gotchas, the dead
  ends and the decisions already closed into a digest of at most 1500 tokens,
  saved on a Myco plan. RECEIVE takes that plan id, rehydrates the context,
  marks the referenced plans in progress, loads the suggested skills and resumes
  the work.
when_to_use: >-
  "hand this off", "prepare a handoff", "continue this in a new session", "pick
  up where I left off", "pass this to another agent" — and unprompted when
  context is running low and the work will continue elsewhere, or when the work
  has drifted far enough out of scope that a fresh session should restart it.
allowed-tools: Read, Bash, Grep, Glob
user-invocable: true
argument-hint: prepare [plan-id] | receive <plan-id>
---

# Myco Handoff

Carry a session's working **intention** to another session cleanly. The
codebase shows *what* exists and the plan shows *what's next* — this skill
captures the *why* and *how we got here* that neither stores, compresses it to
≤1500 tokens, and rides it on a Myco plan (the cross-symbiont shared vehicle).

One skill, two modes.

## Routing

- `prepare [plan-id]` → build a handoff. The optional `plan-id` targets an
  existing plan to attach the handoff to. → follow `references/preparing.md`.
- `receive <plan-id>` → consume a handoff. → follow `references/receiving.md`.
- **No argument** → infer from context: if you are mid-work with something to
  hand off, PREPARE; if you were just given a plan ID to continue, RECEIVE.
- **Unsure** → ask the user. Do not guess.

## The handoff block

The handoff is a single delimited block inside a plan's content, so RECEIVE can
locate it and PREPARE can replace it idempotently (re-preparing replaces the
block — a plan never accumulates stale handoffs):

```markdown
<!-- myco-handoff:start -->
## Handoff — <YYYY-MM-DD>
- **Generated:** <ISO-8601 timestamp>
- **Source session:** <session-id>
- **Source checkout:** <cwd>; branch <branch>; HEAD <short-sha>; dirty <yes/no + summary>
- **Referenced plans:** <plan-id> (<title>; role: work/spec/context; status: <status>)
- **Decisions closed:** <one line per settled decision the receiver must not re-litigate, each with a pointer to its durable record; or "none">
- **Done definition:** <where the definition-of-done lives, or "none yet — defining it is the first resume task">
- **Suggested skills:** myco (required; why: <reason>; fallback: <path/tool>), <skill> (optional; why: <reason>; fallback: <path/tool>)
- **Evidence anchors:** <files, commands/tests, spores, sessions, search result ids, retrieve hints>
- **Resume queries:** <targeted myco_search queries, or "none">
- **Cortex:** use injected guidance if present; otherwise run `myco_cortex({"op":"instructions"})`

### Digest
<≤1500-token intention-focused narrative>
<!-- myco-handoff:end -->
```

## Tooling

Drive Myco through its tools — `myco_plans`, `myco_sessions`, `myco_cortex`,
`myco_search`. Every one takes `project`: a read without it uses the project
your credential is bound to, and a **write without it is refused**. Saving the
handoff is a write, so name the project. `myco_cortex` with
`op: "instructions"` answers this project's guidance and its project id.

Where the `myco` binary is installed, `myco tool call <tool> --json --input
'{...}'` reaches the same code path from a shell; use `--input @file.json` for
multiline markdown. Where only the plugin is installed there is no binary and
the tools above are the whole surface, which is enough for both modes.

Load suggested skills with the host's own skill mechanism. `myco_skills` names
what ships and where each body sits, but does not return one, so a host with no
skill mechanism reads the file at the path `op: "get"` reports.
Your session id arrives in the session-start context; if you cannot find it,
ask rather than guessing.
