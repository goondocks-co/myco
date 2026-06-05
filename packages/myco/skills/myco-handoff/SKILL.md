---
name: myco-handoff
description: >-
  Use when handing a coding session off to a new session or another symbiont —
  "hand this off", "prepare a handoff", "continue this in a new session", "pick
  up where I left off", "pass this to another agent", or when context is heavy /
  running low and the work will continue elsewhere, or work has drifted out of
  scope and should restart fresh. PREPARE compresses the current session's
  intention (why we're here, what we're doing, gotchas, dead ends, decisions)
  into a ≤1500-token digest saved on a Myco plan. RECEIVE takes a plan ID,
  rehydrates the context, loads the suggested skills, marks the referenced plans
  in progress, and resumes the work.
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
- **Source session:** <session-id>
- **Referenced plans:** <plan-id>, <plan-id>
- **Suggested skills:** myco, <skill>, <skill>

### Digest
<≤1500-token intention-focused narrative>
<!-- myco-handoff:end -->
```

## Tooling

Drive Myco via the ambient MCP tools (`myco_plans`, `myco_sessions`,
`myco_cortex`, `myco_search`). On a host without MCP, fall back to
`myco tool call <tool> --json --input '{...}'` via Bash. Load suggested skills
with the `Skill` tool. Your current session ID is injected at session start
(look for the `Session::` line); if you cannot find it, ask the user.
