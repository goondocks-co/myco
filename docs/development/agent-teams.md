# Agent Teams

Agent teams are groups of parallel Claude Code sessions that communicate with each other and coordinate through a shared task list. Use them when you have work that benefits from multiple agents running simultaneously and talking to each other — not just for parallelism, but for collaboration.

> **Status:** Agent teams are experimental (Claude Code v2.1.32+). Enable via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.json or environment.

## When to use teams

The core question is whether the workers need to talk to each other.

| | Subagents | Agent Teams |
|---|-----------|-------------|
| **Communication** | Report back to main agent only | Teammates message each other directly |
| **Coordination** | Main agent manages all work | Shared task list with self-coordination |
| **Best for** | Focused tasks where only the result matters | Complex work requiring discussion and collaboration |
| **Token cost** | Lower — results summarized back | Higher — each teammate is a separate Claude instance |

**Use agent teams when:**
- Multiple reviewers need to investigate different aspects of a PR and share findings
- You're building 3+ independent modules that can be developed in parallel
- You want to debug with competing hypotheses that actively disprove each other
- Cross-layer work (frontend, backend, tests) where each layer is owned by a different teammate

**Use subagents or a single session when:**
- Tasks are sequential or have many dependencies
- Work involves same-file edits (conflict risk)
- Only the result matters, not inter-worker discussion
- Token budget is a concern

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
| `"in-process"` | All teammates in one terminal, cycle with `Shift+Down` | Any terminal |
| `"tmux"` | Each teammate gets its own pane | tmux or iTerm2 + `it2` CLI |

Configure in settings.json:

```json
{ "teammateMode": "in-process" }
```

Or per-session:

```bash
claude --teammate-mode in-process
```

Split-pane mode is not supported in VS Code integrated terminal, Windows Terminal, or Ghostty. Use in-process mode there.

## Creating a team

Tell Claude to create a team with a task description and the number of teammates you want:

```
Create an agent team to refactor the auth module. Spawn three teammates:
- One for the token service
- One for the session middleware
- One for the test suite
```

Claude can also propose a team if it determines the task benefits from parallel work. You confirm before it proceeds.

### Requiring plan approval

For risky work, teammates can be put in read-only plan mode until the lead approves their approach:

```
Spawn an architect teammate to refactor the authentication module.
Require plan approval before they make any changes.
```

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

## Shutting down and cleanup

When work is done, shut down teammates individually or as a group:

```
Ask the researcher teammate to shut down
```

The teammate can approve (exits gracefully) or reject with an explanation.

When all teammates are stopped, clean up the team:

```
Clean up the team
```

**Only the lead should run cleanup.** Teammates running cleanup can leave resources in an inconsistent state. The lead checks for active teammates and will fail if any are still running.

## Quality gates with hooks

Two hooks let you enforce rules when teammates finish work:

**`TeammateIdle`** — runs when a teammate is about to go idle. Exit with code 2 to send feedback and keep the teammate working. Use this to validate output before letting them stop (tests passing, linting clean, deliverables match requirements).

**`TaskCompleted`** — runs when a task is being marked complete. Exit with code 2 to prevent completion and send feedback. Use this to enforce acceptance criteria (test coverage thresholds, documentation requirements, code review checks).

## Best practices

**Give teammates enough context.** Teammates load project context (CLAUDE.md, MCP servers, skills) but do **not** inherit the lead's conversation history. Include task-specific details in the spawn prompt:

```
Spawn a security reviewer teammate with the prompt: "Review the authentication
module at src/auth/ for security vulnerabilities. Focus on token handling, session
management, and input validation. The app uses JWT tokens stored in httpOnly
cookies. Report any issues with severity ratings."
```

**Right-size the team.** Start with 3-5 teammates and target 5-6 tasks per teammate. Three focused teammates often outperform five scattered ones.

**Prevent file conflicts.** Two teammates editing the same file leads to overwrites. Break work so each teammate owns a different set of files.

**Keep the lead delegating, not implementing.** If the lead starts doing work itself instead of waiting for teammates, tell it to wait:

```
Wait for your teammates to complete their tasks before proceeding
```

**Monitor and steer.** Check in on progress, redirect approaches that aren't working, synthesize findings as they arrive. Letting a team run unattended too long increases the risk of wasted effort.

**Start with read-only tasks.** If you're new to agent teams, start with tasks that don't require writing code — reviewing a PR, researching a library, investigating a bug. These show the value of parallel exploration without the coordination challenges of parallel implementation.

## Prompt patterns

### Parallel code review

```
Create an agent team to review PR #142. Spawn three reviewers:
- One focused on security implications
- One checking performance impact
- One validating test coverage
Have them each review and report findings.
```

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
Spawn teammates for Redux Toolkit, Zustand, and Jotai. Each should build
a small proof-of-concept with our data model. Have them compare findings
and produce a recommendation doc.
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Teammates not visible in in-process mode | `Shift+Down` to cycle through them |
| Too many permission prompts | Pre-approve common operations in permission settings before spawning |
| Teammates stopping on errors | Message them directly with instructions, or spawn a replacement |
| Lead shuts down early | Tell the lead to wait for teammates to finish |
| Task appears stuck | Check if work is done and nudge the lead to update status |
| Orphaned tmux sessions after cleanup | `tmux ls` then `tmux kill-session -t <name>` |

## Known limitations

- No session resumption — `/resume` and `/rewind` don't restore in-process teammates
- Teammates sometimes fail to mark tasks complete, blocking dependents
- Shutdown is slow — teammates finish their current request before stopping
- One team per session; clean up before starting a new one
- No nested teams — teammates cannot spawn their own teams
- Permissions are set at spawn time and inherited from the lead
- Split panes are not supported in VS Code terminal, Windows Terminal, or Ghostty

---

*Reference: [Claude Code Agent Teams Documentation](https://code.claude.com/docs/en/agent-teams)*
