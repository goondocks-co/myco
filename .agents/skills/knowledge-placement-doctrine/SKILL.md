---
name: myco:knowledge-placement-doctrine
description: |
  Apply when deciding WHERE to record knowledge, instructions, or context in the
  Myco project — even if the user hasn't explicitly asked about documentation
  strategy. Covers five surfaces: AGENTS.md (durable agent operating rules and
  architectural invariants only), SKILL.md files (codified project procedures
  with steps and examples), inline code comments (behavioral invariants and HOW
  the code works — never historical narrative), the Myco vault (decisions,
  rationale, incidents, tradeoffs), and user-facing docs (README, CHANGELOG,
  docs/, marketing site — user mental model only, never internal mechanics).
  The wrong surface creates knowledge rot: implementation details in user docs
  confuse users, historical narrative in code comments becomes lies as code
  evolves, behavioral invariants buried only in the vault leave developers
  guessing at the point of action. Use this skill when writing any new
  knowledge, reviewing a PR for doc discipline, or auditing existing content
  for surface violations.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Myco Knowledge Placement Doctrine

Myco organizes project knowledge across five distinct surfaces, each with a
specific role and audience. Placing knowledge on the wrong surface creates
knowledge rot — code comments that lie as code evolves, user docs that confuse
with implementation internals, vault decisions that never reach developers at
the point of action. This skill defines which surface is correct for each type
of knowledge and how to detect violations during review.

## Prerequisites

Before placing any knowledge, answer three questions:
- **Type:** Is this an operating rule? A procedure? A behavioral invariant? A decision rationale? User-facing guidance?
- **Audience:** Is this for an AI agent? A developer reading code? A user installing or configuring Myco? A future architect?
- **Lifespan:** Is this durable (stable across releases)? Behavioral (true as long as the code exists)? Historical (true at a point in time)?

The answers determine the surface.

## Procedure A: Agent Operating Rules → AGENTS.md

AGENTS.md is reserved for **durable architectural patterns** that AI agents
need to operate correctly across all work in this project. These are standing
rules that survive across sessions, PRs, and releases.

**What belongs in AGENTS.md:**
- Discovery rules: how to find the right files, which patterns to search for
- Action rules: invariants an agent must uphold when making any change
- Architectural invariants that are always true and guide how to act
- The user-observable model (Groves, Projects, Registries) — not bootstrap internals

**What does NOT belong in AGENTS.md:**
- Implementation details or defensive fallback explanations
- One-off decisions or incident-specific notes
- Procedure-specific guidance (that belongs in SKILL.md)
- Knowledge that will be stale in the next release

**Test:** "Does an AI agent need this standing rule to operate correctly on ANY task in this project?" If yes and it's durable → AGENTS.md. If it applies to one specific procedure → SKILL.md instead.

```
# ✅ AGENTS.md (correct — durable invariant)
Project registration is automatic on first agent hook. All registration
must go through `isSafeProjectRoot()`. The bare `myco init` form is gone.

# ❌ AGENTS.md (wrong — implementation detail, belongs in vault)
The `_unbound-bootstrap` directory is a phantom vault fallback that
prevents crashes before a real Grove is available on greenfield installs.
```

**Cost awareness:** Every rule in AGENTS.md is paid on every agent task. Reserve this surface for invariants that truly apply project-wide. Over-populating AGENTS.md with one-off details degrades agent focus without benefit.

## Procedure B: Codified Procedures → SKILL.md

SKILL.md files capture **reusable project procedures** — step-by-step playbooks that an agent or developer follows to accomplish a recurring task correctly.

**What belongs in a SKILL.md:**
- Step-by-step procedures for recurring tasks (adding a symbiont, writing a spore, running a release)
- Decision trees within a procedure: "if X, then Y; else Z"
- Examples and before/after patterns for each step
- Gotchas scoped to the procedure
- Prerequisites specific to the procedure domain

**What does NOT belong in a SKILL.md:**
- Standing rules that apply project-wide (→ AGENTS.md)
- Historical rationale for why the procedure exists (→ vault)
- User-facing explanations of what the feature does (→ user docs)

**Test:** "Is this a step-by-step playbook for a task someone repeats?" If yes → SKILL.md. If it's a standing operating rule → AGENTS.md. If it's the WHY behind the procedure → vault.

**In-package vs. harness-generated skills:** Myco has two distinct kinds of SKILL.md files:

- **Harness-generated** (`.agents/skills/<slug>/SKILL.md`): produced by the `skill-evolve` pipeline. Must include `name: myco:<slug>` and `managed_by: myco` in frontmatter. These are the evolving operational skills tracked by the vault lifecycle.
- **In-package** (`packages/myco/skills/<slug>/SKILL.md`): bundled reference skills shipped with the package. Use a plain `name: <slug>` (e.g. `name: myco-rules`) with no `myco:` prefix and no `managed_by` field. Do NOT add `managed_by: myco` to in-package skills — that would incorrectly enroll them in the vault skill lifecycle pipeline.

## Procedure C: Behavioral Context → Code Comments

Code comments describe **what the code does and why it behaves that way** — the invariants it maintains, the edge cases it handles, and the shape of its contracts.

**What belongs in code comments:**
- What invariant this function or block maintains
- What edge case this code defends against (the WHAT, not the incident history)
- The shape of a synthetic object or contract: "all fields must be present — callers rely on the full shape"
- HOW a mechanism works so a future maintainer can safely edit this code

**What does NOT belong in code comments:**

| Forbidden pattern | Example to reject | Where it belongs |
|---|---|---|
| Incident dates | `"2026-05-18 wedge: this was added because..."` | Vault (decision spore) |
| External tracking IDs | `"see decision-2f9b3306"`, `"as of PR #346"` | Vault |
| Decision rationale | `"we chose X over Y because..."` | Vault |
| Bug-fix narrative | `"this fixes the crash from commit X"` | Vault |

**Why:** Source code comments become stale immediately — the code moves, the context doesn't, and the comment lies. A reader needs to understand what invariant the code enforces, not re-live the investigation that created it.

**Test:** "Does this describe what the code does or enforces?" → Keep it. "Does this describe when, why historically, or what past incident triggered it?" → Move it to the vault.

```typescript
// ✅ Behavioral comment (keep in code)
// Returns a synthetic manifest shape for callers that bootstrap before a real
// Grove is available. All fields must be present — callers rely on the full
// shape to initialize registry state.

// ❌ Incident narrative (move to vault)
// Added 2026-05-18 after the daemon wedge incident (spore a397e909).
// We chose this over option B because the daemon couldn't handle missing fields.
```

**Enforcement precedent:** PR #346 required a 13-file cleanup (132 lines removed, 53 added) to purge incident dates and historical narrative before submission, codified as the `feedback_no_reasoning_comments` rule. PR #348 simplify pass (`aa961648`) scrubbed the same pattern from `api/update.ts`, `self-reconcile-wiring.ts`, and `main.ts`.

## Procedure D: Decisions and Rationale → Myco Vault

The Myco vault is the **history store** — purpose-built for rich-context,
searchable, historically-stable knowledge that belongs nowhere else.

**What belongs in the vault:**
- Architectural decisions with full rationale ("why option A over option B")
- Tradeoffs accepted: what was gained, what was given up
- Incident narrative with full context (dates, spore cross-references, root causes)
- Rigor gaps and known risks
- Implementation details future contributors need but users don't
- Cross-references between decisions

**Why the vault and not elsewhere:** The vault is searchable; code comments and user docs are not. That's why nuanced decision context belongs here — future developers can find it when they need it, without it polluting the code or confusing users.

**Example:** `decision-2f9b3306` captures the `_unbound-bootstrap` phantom vault decision in full — what it is, why it was added, risk/benefit tradeoff, why deletion isn't a today task, and the lesson that defensive fallbacks can mask primary-path bugs. This full context lives only in the vault; it would rot in code comments and confuse users in docs.

## Procedure E: User-Facing Knowledge → User Docs

User-facing docs (README, CHANGELOG, quickstart, docs/, marketing site) guide users through what they can do, how to set it up, and how to troubleshoot. They speak exclusively to the user's mental model.

**What belongs in user docs:**
- What the user can do with the feature
- How to install, configure, and troubleshoot
- The stable user model: "Install → default Grove exists → first agent hook auto-registers → capture works"
- Observable behavior (Groves, Projects, Registries)

**What does NOT belong in user docs:**
- Internal implementation details (`_unbound-bootstrap`, phantom vault, synthetic manifests)
- Defensive fallback mechanics — users expect myco to "just work" without knowing why
- Transitive dependencies or provisioning mechanics unless they directly affect user action
- Changelog-style enumeration of implementation choices
- Content that reads like a commit message or design spec

**Test:** "Would a user need to know this to install, configure, or troubleshoot?" If no → cut it.

**Dual-surface docs architecture:** `docs/` uses a two-layer build:
- Raw `.md` files (e.g., `docs/cloud-mcp.md`) are the source of truth and serve as AI-readable reference material.
- `docs/build.mjs` compiles them to rendered HTML for human readers.

Always write content in the raw `.md` source files; do not hand-edit generated HTML. PRs touching docs should touch the `.md` sources — the HTML is derived automatically by the build script.

**Enforcement precedents:**
- **PR #355 (`c6669f7e`):** `_unbound-bootstrap` removed from CHANGELOG, README, quickstart, and marketing site. Chris's framing: *"Users expect myco to not crash and work correctly without knowing why."*
- **Cloud MCP branch (`cd96797`):** Full rewrite pass converted implementation-narrating drafts into user-facing guides across `docs/cloud-mcp.md`, `docs/team-sync.md`, and `README.md`. Chris's exact framing: *"The docs should read user documentation, not change logs."*

## Cross-Cutting Gotchas

**Terminology leakage is the most common violation.** When an internal mechanism becomes prominent in your writing, pause: "Does the reader need this term to use or maintain the system?" If the term exists only to explain crash prevention or internal mechanics — it doesn't belong in user docs or AGENTS.md. "Phantom vault" and `_unbound-bootstrap` are legitimate vault and code-comment vocabulary, but leaking them into user docs adds confusion without benefit.

**Surface violations compound silently.** A decision rationale buried in a code comment doesn't just rot — it also fails to surface in vault searches when a future developer faces the same architectural decision. The vault suffers because it's missing the spore; the code suffers because the comment becomes stale.

**AGENTS.md is not a notes pad.** The cost of a standing rule in AGENTS.md is that every agent task pays the context cost. One-off decisions belong in the vault; procedure-specific rules belong in SKILL.md. When in doubt, prefer the vault — it's searchable.

**"Just a quick comment" is a smell.** If you're tempted to add an incident date, a PR reference, or a "we chose this because" note as a code comment because "it's just a quick reminder" — it isn't quick. It's knowledge placed on the wrong surface. Write a vault spore instead.

**In-package skills are not harness-managed.** Adding `managed_by: myco` to a file under `packages/myco/skills/` is a surface violation — it would pull a bundled product skill into the vault lifecycle pipeline incorrectly. The absence of `managed_by` is intentional for in-package skills.

## Quick Reference

| Surface | Store here | Don't store here |
|---|---|---|
| **AGENTS.md** | Durable agent rules, project-wide architectural invariants | Implementation details, one-off decisions, procedure-specific guidance |
| **SKILL.md** (harness) | Codified procedures with steps, examples, gotchas | Project-wide invariants, historical rationale, user-facing explanations |
| **SKILL.md** (in-package) | Bundled product reference skills (`packages/myco/skills/`) — no `managed_by` | Do not add `managed_by: myco` |
| **Code comments** | Behavioral invariants, HOW the code works, contract shapes | Incident dates, spore/PR/ticket IDs, decision rationale, historical narrative |
| **Myco vault** | Decisions, rationale, incidents, tradeoffs, cross-references, rigor gaps | Content that belongs in user docs or code comments |
| **User docs** | What you can do, how to set up, how to troubleshoot | Internals, defensive fallbacks, implementation choices, changelog content |
