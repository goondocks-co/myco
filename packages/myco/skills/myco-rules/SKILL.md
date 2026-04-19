---
name: myco-rules
description: >-
  Keep AGENTS.md minimal, durable, and canonical across agents. Use for
  adding, trimming, or auditing project rules without turning the rules file
  into a dump of dynamic context.
allowed-tools: Read, Edit, Write, Grep, Glob
user-invocable: true
---

# Myco Rules — Minimal Durable Rules

Use this skill to keep `AGENTS.md` sharp, durable, and lightweight.

Do not duplicate changing project context in static rules files. Keep the rules surface small and stable.

## Goals

- Keep `AGENTS.md` as the canonical rules file
- Keep agent-specific files as thin stubs that point back to `AGENTS.md`
- Add only rules that are durable enough to survive normal project change
- Remove vague, stale, duplicated, or over-detailed guidance

## What Belongs in `AGENTS.md`

- Project identity and scope
- Non-goals and hard boundaries
- A small number of architecture invariants
- Quality gates and required verification commands
- Brief working-style guidance that is stable across branches

## What Does Not Belong

- Detailed golden paths that drift with the codebase
- Current initiative notes, migration steps, or branch-specific instructions
- Long architecture tours or other context better delivered dynamically
- Decision rationale or recent history that belongs in project memory, not the rules file
- Workflow history or state better preserved by version control, issue trackers, or project memory
- Generic filler such as "follow best practices" or "keep things clean"

## Placement Rules

- Default to editing `AGENTS.md`
- Treat `CLAUDE.md`, `GEMINI.md`, and `.github/copilot-instructions.md` as thin stubs unless the developer explicitly wants agent-specific behavior there
- If a project has important generic rules in `CLAUDE.md` but not `AGENTS.md`, suggest migrating them into `AGENTS.md`

## Audit Checklist

When reviewing a rules file, look for:

- Vague language: "best practices", "when possible", "try to", "keep it clean"
- Stale anchors: files, commands, or paths that no longer exist
- Bloat: repeated guidance better delivered as dynamic context
- Duplication: the same rule spread across `AGENTS.md` and agent-specific stubs
- Missing hard boundaries: no non-goals, no quality gate, no canonical source of truth

Prefer deleting stale or weak rules over replacing them with more prose.

## Choosing Rule Candidates

Promote only guidance that deserves to live in `AGENTS.md` for a long time.

Good candidates:

- Repeated gotchas with the same root cause
- Repeated bug fixes caused by violating an unwritten invariant
- Explicit decisions that imply a stable always/never rule

Do not promote:

- One-off issues
- Recent feature work that may still change
- Context that is already better delivered dynamically during the session

## Editing Workflow

1. Discover `AGENTS.md` and any agent-specific instruction files.
2. Treat `AGENTS.md` as canonical by default.
3. Identify rules to remove, simplify, or add.
4. Propose the minimal diff that improves clarity.
5. Apply approved edits.

## Rule Writing Standard

- Be specific enough to violate
- Prefer direct language: `MUST`, `MUST NOT`, `SHOULD`
- Anchor claims to real files or commands when needed
- Keep the file short enough that an agent will actually read it
- Treat code comments with the same discipline: keep them brief, durable, and focused on helping someone understand non-obvious code

## References

- `references/rules-good-example.md`
- `references/rules-bad-example.md`
