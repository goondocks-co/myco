---
name: myco
description: Myco is this project's memory — the sessions that happened, the durable observations (spores) drawn from them, and the plans. It holds why the code is the way it is, which the code itself cannot show. Use it before a design decision, when debugging something non-obvious, when a structure looks arbitrary, when picking up work someone else started, and after learning something worth keeping.
when_to_use: Reach for Myco when the question is "why", not "what" — why this approach, what was tried before, what broke, what a subsystem is defending against. Also when the user says vault, spore, session, plan, prior decision, team knowledge or institutional memory; when you are about to repeat work another session may have done; and when you have just found a gotcha or made a decision worth saving.
---

# Myco

The codebase shows **what** exists. Myco shows **why**: the approach chosen over the alternatives, the thing that broke, the constraint that is not visible in the file you are reading.

## The one rule that will bite you

Every Myco tool takes a **`project`** argument — a project id, or the repository's git remote.

- A **read** without it uses the project your credential is bound to. Usually right; wrong the moment you are working across repositories.
- A **write** without it is **refused**. This is deliberate: a credential can reach more than one project, and an unnamed write would land wherever the connection happened to point.
- An argument the tool's schema does not declare is refused by name.

`myco_cortex` with `op: "instructions"` answers this project's standing guidance **and its project id**. That id is the value to pass as `project`. If you were given Myco context at session start, the id is already in it.

## Reading

Search first, then fetch what you want in full by its id. Search previews are one line per hit; they are for choosing, not for reading.

```
myco_search    { "query": "why the outbox drains on a lease" }
myco_spores    { "op": "get", "id": "<id from the search hit>" }
myco_sessions  { "op": "get", "id": "<session id>" }
myco_plans     { "op": "get", "id": "<plan id>" }
```

Use it before you decide, not after. A search that takes one call can save an afternoon spent rediscovering why an approach was abandoned.

**When to search, concretely:**

- Before choosing between two designs — someone may have already rejected one, with reasons.
- When an error message is strange — search the message text.
- When a structure looks arbitrary — it is usually defending against something.
- When you inherit a branch — search the feature name and read the last session on it.

## Writing

Save a spore when you learn something a future session would want and could not derive from the code.

```
myco_spores { "op": "save", "type": "gotcha", "project": "<project id>",
              "content": "..." }
```

Good spores are specific and durable. A gotcha names the trap and the tell that reveals it. A decision names what was chosen, what was rejected, and why. Neither is a status update: "finished the parser" helps nobody in three months.

Search before you save. If a spore already covers the ground, supersede it rather than adding a near-duplicate:

```
myco_spores { "op": "supersede", "id": "<old id>", "project": "<project id>",
              "content": "..." }
```

Plans are the same shape — `myco_plans` with `op: "save"` — and are for work that spans sessions. Status changes through an explicit status-only save.

## What happens without you

Where the `myco` binary is installed and its hooks are wired, sessions are captured and context is served at session start and on each prompt. You do not call anything for that.

Where only the plugin is installed there is no capture, and the tools above are the whole surface. That is a working configuration, not a broken one — but if you expect this project's sessions to be recorded and they are not, the **`myco-setup`** skill installs the rest.

## Skills

`myco_skills` lists the skills that ship with Myco and what each one is for. It is the way to see what is available without leaving the session. It does not return a body: `get` names where the body sits on this machine, and your host's own skill mechanism is what loads it.

## When a tool refuses

Refusals are terminal and they name themselves. Read the name before retrying:

- A write refused for a missing project — pass `project`.
- `unknown_tool` for a tool you can see — your credential's surface does not include that operation. Retrying will not change it.
- Not found for a project you named — either it does not exist or your credential cannot see it; the two are deliberately indistinguishable.

Retrying a terminal refusal unchanged is always wrong. Change the call or stop.

## Going deeper

- `references/tools.md` — every tool, its operations and its arguments.
- `references/writing-spores.md` — what makes an observation worth keeping, with examples of both kinds.
