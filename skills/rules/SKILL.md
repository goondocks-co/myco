---
name: rules
description: >-
  Use when creating, auditing, or improving project rules files (CLAUDE.md,
  AGENTS.md). Helps write specific, enforceable rules that agents actually
  follow. Also triggered proactively when Myco detects recurring patterns
  that should become project rules.
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
user-invocable: true
---

# Rules — Project Rules File Management

Write, audit, and improve project rules files (CLAUDE.md, AGENTS.md) so agents follow them consistently. Rules files are the project's system prompt — they define invariants every agent must follow every time.

## When to Use

- **Creating a new rules file** for a project that doesn't have one
- **Auditing an existing rules file** that agents seem to ignore
- **Adding a rule** when you identify a pattern that should be standardized
- **Proactively** when Myco detects recurring observations that suggest a missing rule

## What Belongs in a Rules File

Rules files contain **project invariants** — things every agent must follow every time, regardless of context.

| Belongs in Rules File | Does NOT Belong |
|----------------------|-----------------|
| Hard constraints: "All API routes go through `src/routes/`" | Situational context (use Myco context injection) |
| Golden paths: step-by-step standard procedures | Decision rationale (use Myco spore) |
| Quality gates: specific commands that must pass | Code documentation (that's the codebase) |
| Non-goals: what the project is NOT | Anything starting with "try to" or "when possible" |

**The test:** If it's an invariant that applies to every session on every branch, it's a rule. If it depends on what you're working on, it's context — let Myco inject it.

## Multi-Agent File Topology

Myco supports 6 coding agents. Each has its own instruction file format, but **`AGENTS.md` is the canonical source of truth** for all project rules.

### File hierarchy

| File | Purpose | Who reads it |
|------|---------|-------------|
| `AGENTS.md` | **Canonical rules** — all architecture, conventions, golden paths | Codex, VS Code Copilot, Gemini CLI, Windsurf, Cursor |
| `CLAUDE.md` | Thin stub pointing to `AGENTS.md` + Claude-specific overrides | Claude Code |
| `GEMINI.md` | Thin stub pointing to `AGENTS.md` + Gemini-specific overrides | Gemini CLI |
| `.github/copilot-instructions.md` | Thin stub pointing to `AGENTS.md` | VS Code Copilot |

### Rules for placement

- **All rules go in `AGENTS.md`** unless they are genuinely agent-specific (e.g., "Use Claude Code agent teams for X")
- Agent-specific files MUST start with a reference to `AGENTS.md` as the source of truth
- Never duplicate rules across files — if it applies to all agents, it belongs in `AGENTS.md`
- If a project has `CLAUDE.md` with substantial rules but no `AGENTS.md`, suggest migrating the rules to `AGENTS.md` and replacing `CLAUDE.md` with a thin stub

## Rule Writing Principles

These principles apply whether you're writing new rules or auditing existing ones.

### Every rule must be specific enough to violate

- Bad: "Write clean code"
- Good: "Functions MUST NOT exceed 50 lines"

### Use RFC 2119 language

| Keyword | Meaning | Example |
|---------|---------|---------|
| **MUST** | Absolute requirement, no exceptions | "All endpoints MUST validate input with Zod" |
| **SHOULD** | Strong recommendation, exceptions need justification | "Services SHOULD be stateless" |
| **MAY** | Optional, recognized pattern | "Teams MAY use dependency injection" |

Anything weaker than MAY is not a rule. Remove it or strengthen it.

### Anchor to real paths

- Bad: "Put tests near the code"
- Good: "Tests MUST be at `tests/<module>.test.ts` mirroring `src/<module>.ts`"

### Define deviation lanes for SHOULD rules

- "Functions SHOULD NOT exceed 50 lines. Exception: generated code in `src/generated/`."

### No loopholes

These phrases give agents permission to skip the rule: "when possible", "try to", "consider", "if needed", "as appropriate". Remove them or rephrase as SHOULD with explicit exceptions.

## Required Sections

A well-formed rules file has these sections. Not all are required for every project, but the skill checks for their absence.

### 1. Project Identity

What this project is, in one sentence. The anchor everything else hangs on.

### 2. Non-Goals

What this project is NOT. Prevents agents from "improving" things outside scope. Example: "This is NOT a general-purpose framework. Do not add extensibility points or plugin systems."

### 3. Architecture Invariants

Hard rules about project structure, anchored to real file paths. Example: "All database queries MUST go through `src/db/queries.ts`. No raw SQL in route handlers."

### 4. Golden Paths

Step-by-step standard procedures for common operations: add a feature, fix a bug, add a test. Not vibes — a checklist an agent can follow literally. Point to a canonical file to copy.

### 5. Quality Gates

Specific commands that must pass before work is done. Example: "Before committing: `npm run lint && npm test && npx tsc --noEmit`"

## Audit Workflow

### Step 1: Discover existing rules files

Scan the project root for:
- `AGENTS.md` (canonical — should exist in every Myco project)
- `CLAUDE.md` (Claude Code stub/overrides)
- `GEMINI.md` (Gemini CLI stub/overrides)
- `.github/copilot-instructions.md` (VS Code Copilot stub)

Report what exists. If `AGENTS.md` doesn't exist, offer to create it. If `CLAUDE.md` has substantial rules but `AGENTS.md` doesn't exist, offer to migrate.

### Step 2: Run audit checks

For each rules file found, check:

| Check | What It Catches | Severity |
|-------|----------------|----------|
| Missing sections | No non-goals, no quality gates, etc. | Important |
| Vague rules | "Follow best practices", "keep it clean", "when possible" | Critical |
| Unanchored rules | References to structure without real file paths | Important |
| Contradictions | Two rules that conflict with each other | Critical |
| Bloat | Rules duplicating what linter/tsconfig/CI already enforces | Minor |
| Missing golden path | Common operations with no documented standard way | Important |
| Stale anchors | Rules referencing files/paths that no longer exist | Critical |

Detect missing golden paths by checking project signals: `package.json` → should have "add dependency" path, `src/routes/` → should have "add endpoint" path, test framework → should have "add test" path. Also ask the developer what common operations they perform.

### Step 3: Check Myco observations (if available)

Query `myco_search` for recurring observations related to the project. Look for:
- Gotchas that recur 3+ times (same mistake across sessions)
- Decisions that state "we should always/never do X"
- Bug fixes where the root cause was violating an unwritten convention

These are rule candidates. Surface them to the developer.

### Step 4: Present findings

Report findings ranked by severity (critical first). For each finding:
- What the problem is
- Why agents exploit it
- Specific fix text (the exact rule to add, modify, or remove)

The developer approves fixes individually or in batch.

### Step 5: Apply approved fixes

Edit the rules file with approved changes. Never auto-commit — the developer reviews the diff.

## Add Rule Workflow

### From a developer request

1. Developer describes the rule they want
2. Craft the rule: specific, anchored, RFC 2119 language
3. Determine placement:
   - **`AGENTS.md`** — All rules that any agent should follow (architecture, golden paths, conventions, quality gates). This is the default.
   - **`CLAUDE.md`** — Only Claude Code-specific rules (agent team patterns, Claude-specific tool conventions)
   - **`GEMINI.md`** — Only Gemini CLI-specific rules
   - **`.github/copilot-instructions.md`** — Only VS Code Copilot-specific rules
   - If only `CLAUDE.md` exists with agent-agnostic rules, suggest creating `AGENTS.md` and migrating rules there
   - If `AGENTS.md` doesn't exist, create it as the canonical file
4. Find the correct section (invariant, golden path, quality gate, etc.)
5. Insert the rule
6. Developer reviews the diff

### Rule Crafting Example

Raw observation: "better-sqlite3 WASM build fails on Node 22 ARM — must use native build"

Bad rule: "Be careful with sqlite builds"

Good rule: "better-sqlite3 MUST be installed with native bindings, not WASM. The WASM build fails on Node 22 ARM. Run `npm install better-sqlite3 --build-from-source` if the default install produces WASM artifacts."

### From a Myco observation

1. Myco surfaces a pattern: "Your team has hit 3 gotchas about X. Should this become a rule?"
2. If the developer approves:
   - Craft the rule from the observation
   - The rule states the **what** — the observation (in Myco spore) stores the **why**
   - Place it in the correct file and section
3. If the developer dismisses: the observation stays as context, not a rule

### What stays as a spore, NOT a rule

Reject promotion for:
- One-off gotchas unlikely to recur (< 3 occurrences)
- Decision rationale (the rule states what; spore stores why)
- Branch-specific or time-limited knowledge
- Anything that would only matter during a specific initiative

## References

For examples of well-written and poorly-written rules files:
- `references/rules-good-example.md` — All five sections done right
- `references/rules-bad-example.md` — Every anti-pattern annotated with fixes
