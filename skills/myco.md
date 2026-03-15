---
name: myco
description: Use Myco intelligence to search team knowledge, recall context, and capture observations. Activates when working on code that has prior sessions, plans, or team activity.
---

# Myco — Collective Agent Intelligence

Myco captures session intelligence across your team and serves it back to you. Use these MCP tools to access collective knowledge.

## When to Use Myco

- **Starting work on unfamiliar code** — call `myco_recall` to get context from prior sessions
- **Debugging a tricky problem** — call `myco_search` to find if a teammate hit the same issue
- **Making architectural decisions** — call `myco_search` to find prior decisions and their rationale
- **Discovering a gotcha or pitfall** — call `myco_remember` to save it for the team
- **Continuing someone else's work** — call `myco_sessions` with their plan to see what they did

## MCP Tools

### myco_search
Search across all team knowledge — sessions, plans, memories.
```json
{ "query": "search terms", "type": "session|plan|memory|all", "limit": 10 }
```

### myco_recall
Get automatic context for your current work. No query needed — uses git branch and active plans.
```json
{ "branch": "feature/auth", "files": ["src/auth.ts"] }
```

### myco_remember
Save an observation for the team. Use when you discover something non-obvious.
```json
{ "content": "description", "type": "decision|gotcha|discovery|cross-cutting", "tags": ["relevant"] }
```

### myco_plans
Check plan status and progress.
```json
{ "status": "active", "id": "plan-name" }
```

### myco_sessions
Browse session history with filters.
```json
{ "plan": "auth-redesign", "branch": "feature/auth", "user": "chris" }
```

### myco_team
See what teammates have been working on.
```json
{ "plan": "auth-redesign", "files": ["src/auth.ts"] }
```
