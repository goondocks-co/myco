# Myco — Claude Code Instructions

> **Source of truth:** Read and follow [`AGENTS.md`](AGENTS.md) — it is the authoritative specification for this project's architecture, conventions, golden paths, and quality gates.
>
> If anything in this file conflicts with `AGENTS.md`, **`AGENTS.md` wins**.

This file contains only Claude Code-specific instructions that supplement `AGENTS.md`.

## Agent Teams

Use Claude Code agent teams for parallelizable work where teammates need to communicate with each other. See [docs/agent-teams.md](docs/agent-teams.md) for the full reference.

### When to use agent teams

- **User explicitly requests it** — always honor a direct request to create an agent team.
- **Cross-layer implementation** — changes spanning frontend, backend, and tests where each layer can be owned independently.
- **Competing hypothesis debugging** — multiple theories to investigate in parallel, especially when adversarial debate would surface the root cause faster.
- **Parallel review** — reviewing a PR or codebase from multiple lenses (security, performance, coverage) simultaneously.
- **Independent module development** — building 3+ modules with no shared files, where parallel execution saves significant time.

### When NOT to use agent teams

- **Sequential or dependent work** — tasks that must happen in order. Use a single session.
- **Same-file edits** — two teammates editing the same file causes overwrites. Use a single session or subagents.
- **Simple focused tasks** — when only the result matters and no inter-worker discussion is needed. Use subagents.
- **Token-constrained work** — each teammate is a separate Claude instance. Use subagents for lower cost.

### Rules for agent team usage

- **3-5 teammates** is the default. Scale up only when the work genuinely benefits.
- **5-6 tasks per teammate** keeps everyone productive without excessive context switching.
- **File ownership must be exclusive** — break work so each teammate owns a different set of files. Never assign two teammates to the same file.
- **Spawn prompts must include full context** — teammates do NOT inherit the lead's conversation history. Include all task-specific details in the spawn prompt.
- **Require plan approval for risky changes** — use plan mode for teammates touching critical paths (auth, data, config).
- **The lead delegates, not implements** — if the lead starts doing work itself, tell it to wait for teammates.
- **Only the lead cleans up** — teammates must not run cleanup. Shut down all teammates before the lead cleans up the team.
