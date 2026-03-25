# Agent Teams Reference Guide

Master reference for orchestrating teams of Claude Code sessions. Use this when designing multi-agent workflows, deciding between subagents and teams, or troubleshooting team coordination.

> **Status:** Agent teams are experimental (Claude Code v2.1.32+). Enable via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.json or environment.

---

## When to Use Agent Teams vs Subagents

The core question: **do the workers need to talk to each other?**

| Dimension | Subagents | Agent Teams |
|-----------|-----------|-------------|
| **Context** | Own window; results return to caller | Own window; fully independent |
| **Communication** | Report back to main agent only | Teammates message each other directly |
| **Coordination** | Main agent manages all work | Shared task list with self-coordination |
| **Best for** | Focused tasks where only the result matters | Complex work requiring discussion and collaboration |
| **Token cost** | Lower: results summarized back | Higher: each teammate is a separate Claude instance |
| **Lifecycle** | Scoped to the calling session | Independent sessions, persist until shutdown |

### Use agent teams when:

- **Research and review** — multiple reviewers investigate different aspects simultaneously, share and challenge findings
- **New modules or features** — each teammate owns a separate piece without stepping on each other
- **Debugging with competing hypotheses** — teammates test different theories in parallel, actively disprove each other
- **Cross-layer coordination** — frontend, backend, and tests each owned by a different teammate

### Use subagents (or a single session) when:

- Tasks are sequential or have many dependencies
- Work involves same-file edits (conflict risk)
- Only the result matters, not inter-worker discussion
- Token budget is a concern

---

## Setup

### Enable agent teams

```json
// settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

### Display modes

| Mode | Description | Requirement |
|------|-------------|-------------|
| `"auto"` (default) | Split panes if inside tmux, in-process otherwise | — |
| `"in-process"` | All teammates in one terminal. `Shift+Down` to cycle. | Any terminal |
| `"tmux"` | Each teammate gets its own pane. Auto-detects tmux vs iTerm2. | tmux or iTerm2 + `it2` CLI |

Configure in settings.json:

```json
{
  "teammateMode": "in-process"
}
```

Or per-session:

```bash
claude --teammate-mode in-process
```

**Split pane dependencies:**
- **tmux**: install via package manager. `tmux -CC` in iTerm2 is the recommended entrypoint.
- **iTerm2**: install the `it2` CLI, enable Python API in iTerm2 > Settings > General > Magic.
- **Not supported**: VS Code integrated terminal, Windows Terminal, Ghostty.

---

## Architecture

```
┌─────────────────────────────────────────┐
│  Team Lead (main Claude Code session)   │
│  - Creates team, spawns teammates       │
│  - Coordinates work, synthesizes results│
│  - Approves/rejects teammate plans      │
├─────────────────────────────────────────┤
│  Shared Task List                       │
│  ~/.claude/tasks/{team-name}/           │
│  - pending → in_progress → completed   │
│  - Dependency tracking (auto-unblock)   │
│  - File-lock based claiming (no races)  │
├─────────────────────────────────────────┤
│  Mailbox (inter-agent messaging)        │
│  - Direct: message one teammate         │
│  - Broadcast: message all (use sparingly│
│  - Automatic delivery (no polling)      │
├───────────┬───────────┬─────────────────┤
│ Teammate A│ Teammate B│ Teammate C  ... │
│ Own context│Own context│ Own context     │
│ Own tools  │Own tools  │ Own tools       │
└───────────┴───────────┴─────────────────┘
```

**Storage locations:**
- Team config: `~/.claude/teams/{team-name}/config.json`
- Task list: `~/.claude/tasks/{team-name}/`

The team config contains a `members` array with each teammate's name, agent ID, and agent type. Teammates can read this file to discover other team members.

---

## Team Lifecycle

### 1. Creation

Tell Claude to create a team with a task description and team structure:

```
Create an agent team to refactor the auth module. Spawn three teammates:
- One for the token service
- One for the session middleware
- One for the test suite
```

Claude can also propose a team if it determines the task benefits from parallel work. You confirm before it proceeds.

### 2. Coordination

The lead handles task creation, assignment, and synthesis. Teammates self-claim tasks after completing their current work.

**Task states:** `pending` → `in_progress` → `completed`

**Task dependencies:** when a teammate completes a task that others depend on, blocked tasks unblock automatically.

### 3. Communication

- **Automatic message delivery** — no polling needed
- **Idle notifications** — teammates auto-notify the lead when they stop
- **Shared task list** — all agents see task status and claim available work
- **message** — send to one specific teammate
- **broadcast** — send to all teammates (costs scale with team size)

### 4. Shutdown

```
Ask the researcher teammate to shut down
```

The teammate can approve (exits gracefully) or reject with an explanation. Always shut down all teammates before cleanup.

### 5. Cleanup

```
Clean up the team
```

**Only the lead should run cleanup.** Teammates should not run cleanup — their team context may not resolve correctly, leaving resources in an inconsistent state. The lead checks for active teammates and fails if any are still running.

---

## Controlling Teammates

### Specify teammates and models

```
Create a team with 4 teammates to refactor these modules in parallel.
Use Sonnet for each teammate.
```

### Require plan approval

For risky tasks, teammates can be put in read-only plan mode until the lead approves:

```
Spawn an architect teammate to refactor the authentication module.
Require plan approval before they make any changes.
```

**Flow:** teammate plans → sends plan approval request to lead → lead approves or rejects with feedback → if rejected, teammate revises and resubmits → if approved, teammate exits plan mode and implements.

Influence approval criteria via the prompt:
- "Only approve plans that include test coverage"
- "Reject plans that modify the database schema"

### Direct interaction

**In-process mode:**
- `Shift+Down` — cycle through teammates
- `Enter` — view a teammate's session
- `Escape` — interrupt their current turn
- `Ctrl+T` — toggle the task list
- Type to send messages directly

**Split-pane mode:**
- Click into a teammate's pane to interact directly
- Each teammate has full terminal access

### Permissions

Teammates start with the lead's permission settings. If the lead uses `--dangerously-skip-permissions`, all teammates do too. Individual teammate modes can be changed after spawning, but not at spawn time.

Pre-approve common operations in permission settings before spawning to reduce prompt interruptions.

---

## Quality Gates with Hooks

Two hooks enforce rules when teammates finish work:

### `TeammateIdle`

Runs when a teammate is about to go idle. Exit with code 2 to send feedback and keep the teammate working.

**Use case:** validate the teammate's output before letting them stop — check that tests pass, linting is clean, or deliverables match requirements.

### `TaskCompleted`

Runs when a task is being marked complete. Exit with code 2 to prevent completion and send feedback.

**Use case:** enforce that tasks meet acceptance criteria — test coverage thresholds, documentation requirements, code review checks.

---

## Best Practices

### 1. Give teammates enough context

Teammates load project context (CLAUDE.md, MCP servers, skills) but do NOT inherit the lead's conversation history. Include task-specific details in the spawn prompt:

```
Spawn a security reviewer teammate with the prompt: "Review the authentication
module at src/auth/ for security vulnerabilities. Focus on token handling, session
management, and input validation. The app uses JWT tokens stored in httpOnly
cookies. Report any issues with severity ratings."
```

### 2. Right-size the team

**Start with 3-5 teammates.** This balances parallel work with manageable coordination.

**Target 5-6 tasks per teammate.** If you have 15 independent tasks, 3 teammates is a good starting point.

Three focused teammates often outperform five scattered ones. Scale up only when the work genuinely benefits from simultaneous execution.

### 3. Size tasks appropriately

| Size | Problem |
|------|---------|
| Too small | Coordination overhead exceeds the benefit |
| Too large | Teammates work too long without check-ins, increasing wasted effort risk |
| Just right | Self-contained units producing a clear deliverable (a function, test file, review) |

If the lead isn't creating enough tasks, ask it to split the work into smaller pieces.

### 4. Prevent file conflicts

Two teammates editing the same file leads to overwrites. Break work so each teammate owns a different set of files. Design task boundaries around file ownership.

### 5. Keep the lead delegating, not implementing

The lead sometimes starts implementing instead of waiting for teammates:

```
Wait for your teammates to complete their tasks before proceeding
```

### 6. Monitor and steer

Check in on progress, redirect approaches that aren't working, synthesize findings as they arrive. Letting a team run unattended too long increases wasted effort risk.

### 7. Start with read-only tasks

If you're new to agent teams, start with tasks that don't require writing code: reviewing a PR, researching a library, investigating a bug. These show the value of parallel exploration without coordination challenges of parallel implementation.

---

## Prompt Patterns

### Parallel code review

```
Create an agent team to review PR #142. Spawn three reviewers:
- One focused on security implications
- One checking performance impact
- One validating test coverage
Have them each review and report findings.
```

Each reviewer applies a different filter to the same PR. The lead synthesizes findings.

### Competing hypothesis investigation

```
Users report the app exits after one message instead of staying connected.
Spawn 5 agent teammates to investigate different hypotheses. Have them talk to
each other to try to disprove each other's theories, like a scientific debate.
Update the findings doc with whatever consensus emerges.
```

The adversarial debate structure fights anchoring bias — the theory that survives active disproof attempts is more likely to be the root cause.

### Feature implementation with plan gates

```
Create an agent team to build the notification system:
- Teammate 1: Backend API (src/api/notifications/)
- Teammate 2: Frontend components (src/components/notifications/)
- Teammate 3: Integration tests (tests/notifications/)
Require plan approval for all teammates before they write code.
Only approve plans that include error handling and test coverage.
```

### Research with synthesis

```
Create an agent team to evaluate state management options for our React app.
Spawn teammates for:
- Redux Toolkit evaluation
- Zustand evaluation
- Jotai evaluation
Each should build a small proof-of-concept with our data model.
Have them compare findings and produce a recommendation doc.
```

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Teammates not appearing | May be running but not visible in in-process mode | `Shift+Down` to cycle through teammates |
| Teammates not appearing | Task too simple for Claude to warrant a team | Explicitly request team creation |
| Teammates not appearing (split) | tmux not installed | `which tmux` to verify, install if missing |
| Too many permission prompts | Teammate permissions bubble up to lead | Pre-approve common operations in permission settings |
| Teammates stopping on errors | Teammate gave up after encountering error | Message them directly with instructions, or spawn replacement |
| Lead shuts down early | Lead decided team is finished prematurely | Tell lead to wait for teammates to finish |
| Task appears stuck | Teammate didn't mark task as completed | Check if work is done, update status manually or nudge via lead |
| Orphaned tmux sessions | Team cleanup didn't fully remove sessions | `tmux ls` then `tmux kill-session -t <name>` |
| `/resume` doesn't restore teammates | Known limitation: in-process teammates don't survive resume | Tell lead to spawn new teammates after resuming |

---

## Known Limitations

- **No session resumption** — `/resume` and `/rewind` don't restore in-process teammates
- **Task status lag** — teammates sometimes fail to mark tasks complete, blocking dependents
- **Slow shutdown** — teammates finish current request/tool call before stopping
- **One team per session** — clean up current team before starting a new one
- **No nested teams** — teammates cannot spawn their own teams
- **Fixed lead** — the creating session is lead for the team's lifetime, no transfer
- **Permissions set at spawn** — all teammates inherit lead's mode, changeable individually after spawn only
- **Split panes limited** — requires tmux or iTerm2, not supported in VS Code terminal, Windows Terminal, or Ghostty
- **CLAUDE.md works normally** — teammates read CLAUDE.md from their working directory (this is a feature, not a limitation)

---

## Quick Decision Matrix

```
Need parallel work?
├── No → Single session
├── Yes
│   ├── Workers need to talk to each other?
│   │   ├── No → Subagents
│   │   └── Yes → Agent team
│   ├── Same-file edits?
│   │   ├── Yes → Single session or careful file ownership
│   │   └── No → Agent team candidate
│   └── Token budget tight?
│       ├── Yes → Subagents (lower cost)
│       └── No → Agent team
```

---

*Source: [Claude Code Agent Teams Documentation](https://code.claude.com/docs/en/agent-teams)*
