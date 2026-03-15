---
name: myco
description: Use when making design decisions, debugging non-obvious issues, encountering gotchas, or wondering why code is structured a certain way. Myco captures the reasoning, trade-offs, and lessons behind the codebase — things the code itself doesn't show.
---

# Myco — Collective Agent Intelligence

The codebase shows you **what** exists. Myco shows you **why** it exists — why this approach was chosen over alternatives, what broke along the way, what's non-obvious. When you're wondering *why* something is the way it is, or *whether* something was already tried, Myco has answers the code doesn't.

## When to Use Myco

Consider using Myco tools in these situations:

- **Making a design decision** — Myco may have prior reasoning on the same component. Check before choosing an approach.
- **Debugging a non-obvious issue** — Someone may have hit the same problem. Search for the error or component.
- **Wondering why code is structured a certain way** — Myco captures decisions and trade-offs behind the architecture.
- **Continuing someone else's work** — Check their session history and plan progress.
- **Discovering a gotcha or pitfall** — Save it so the team doesn't hit it again.

## What's Automatic

Context is injected at session start based on your git branch and active plans. You don't need to call `myco_recall` for basic context — it's already there. The tools below are for going deeper.

## MCP Tools

### myco_search
Semantic search across all team knowledge — sessions, plans, memories.
```json
{ "query": "why did we choose JWT over session cookies", "type": "memory", "limit": 5 }
```

### myco_recall
Get context for your current work. Uses git branch, active plans, and file list.
```json
{ "branch": "feature/auth-redesign", "files": ["src/auth/middleware.ts"] }
```

### myco_remember
Save an observation for the team. Only save things that aren't obvious from the code.
```json
{ "content": "better-sqlite3 WASM build fails on Node 22 ARM — must use native build", "type": "gotcha", "tags": ["sqlite", "build"] }
```

**Observation types:**
- `gotcha` — Non-obvious pitfall or constraint
- `bug_fix` — Root cause of a bug and what fixed it
- `decision` — Why an approach was chosen over alternatives
- `discovery` — Insight about the codebase, tool, or domain
- `trade_off` — What was sacrificed and why

**Good observations are specific:** file names, function names, actual values, error messages. Bad observations are vague: "the auth system is complex."

### myco_plans
Check plan status and progress.
```json
{ "status": "active" }
```

### myco_sessions
Browse session history.
```json
{ "plan": "auth-redesign", "branch": "feature/auth" }
```

### myco_team
See what teammates have been working on.
```json
{ "plan": "auth-redesign" }
```
