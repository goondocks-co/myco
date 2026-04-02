---
name: myco:myco-skill-lifecycle
description: Use this skill when you need to run the Myco skill lifecycle end-to-end: identifying skill candidates from vault knowledge, curating them through the approval workflow, generating SKILL.md files on disk, and evolving existing skills as the vault grows. Activate even if the user only asks about one phase — understanding the full chain prevents common sequencing mistakes. Applies to tasks named skill-survey, skill-generate, skill-evolve, and to any work on the Skills dashboard in the Daemon UI. Also relevant when candidates appear but no skills materialize, when the survey returns zero results, or when a generated skill needs to be refreshed.
managed_by: myco
user-invocable: true
allowed-tools: Read, Bash, Grep, Glob
---

# Myco Skill Lifecycle: Survey → Approve → Generate → Evolve

## Overview

Myco's skill lifecycle is a four-phase pipeline that converts accumulated vault knowledge into reusable SKILL.md files on disk. Each phase is a separate agent task with **asymmetric scheduling defaults** reflecting its risk profile.

```
Vault spores
    ↓
[skill-survey]   ← enabled: true (auto-runs during idle)
    ↓
Candidates (identified)
    ↓
[User approval]  ← manual curation in Skills dashboard
    ↓
Candidates (approved)
    ↓
[skill-generate] ← enabled: false (opt-in required)
    ↓
SKILL.md files
    ↓
[skill-evolve]   ← enabled: false (opt-in required)
    ↓
Updated SKILL.md files (versioned with lineage)
```

### Scheduling Defaults

| Task | Default | Why |
|---|---|---|
| `skill-survey` | `enabled: true` | Passive discovery; read-only; auto-runs during idle |
| `skill-generate` | `enabled: false` | Writes new files; opt-in until output quality is verified |
| `skill-evolve` | `enabled: false` | Mutates existing skills; opt-in until output quality is verified |

**This asymmetry is intentional.** Candidate evidence builds passively; generative and mutative steps require deliberate enablement. The two most common "pipeline not working" symptoms trace directly to this design:
- **"Candidates exist but no skills appear"** → `skill-generate` is disabled (default). Enable it via Agent Tasks.
- **"Survey returns zero results"** → vault may be sparse; the survey needs more accumulated sessions.

## Prerequisites

- Myco daemon running
- Vault has processed sessions with spores (check Daemon UI → Sessions)
- Access to Daemon UI → Skills and Daemon UI → Agent Tasks

## Phase 1: Survey (Automatic)

`skill-survey` scans active spores for clusters of related knowledge and creates `identified` candidates. Runs automatically during idle; no user action required beyond verifying it is enabled.

**When zero candidates appear:**
1. Check that `skill-survey` is enabled (Agent Tasks → find `skill-survey`)
2. Verify vault spores exist (Daemon UI → Sessions → check spore count per session)
3. Survey uses a cluster threshold — a sparse vault returns zero legitimately; keep accumulating sessions

**Output:** Candidates with status `identified` in the Skills dashboard

## Phase 2: Approval (Manual)

Review candidates in **Daemon UI → Skills → Skill Candidates**:

- **Approve** → moves to `approved`, queued for generation
- **Dismiss** → moves to `dismissed`, excluded from generation

Approval criteria:
- Represents a reusable procedure, not a one-off task
- Specific and actionable (not a vague category)
- Distinct from existing skills

**Output:** Candidates with status `approved`

## Phase 3: Generate (Opt-In)

`skill-generate` picks up approved candidates and writes SKILL.md files to `.agents/skills/<name>/SKILL.md`.

**Enable it:**
1. Daemon UI → Agent Tasks → `skill-generate`
2. Toggle to `enabled: true`
3. Run on next sweep or click **Run Now**

**Quality gate:** `vault_write_skill` enforces five required frontmatter fields: `name`, `description`, `managed_by`, `user-invocable`, `allowed-tools`. Missing any field fails the write at the tool level — before the file is written or any DB record is created.

**Output:** Active SKILL.md files visible in Daemon UI → Skills → Active Skills

## Phase 4: Evolve (Opt-In)

`skill-evolve` assesses existing skills against new vault knowledge and rewrites stale, conflicted, or oversized skills.

**Enable it:**
1. Daemon UI → Agent Tasks → `skill-evolve`
2. Toggle to `enabled: true`

**Two-phase structure:**
- **assess** — classifies each skill: CURRENT / STALE / CONFLICTED / OVERSIZED
- **evolve** — rewrites only the non-CURRENT skills

**Budget sizing is critical:** Multi-STALE runs are multiplicative. Each skill rewrite costs ~10 turns. Task `maxTurns` must equal the sum of all phase budgets plus overhead (≥ 20 assess + 35 evolve + 5 buffer = 60 minimum for up to 3 STALE skills). `timeoutSeconds` must cover N rewrites × ~5 minutes. Silent timeout failure (task ends "normally" but incomplete) occurs when either budget is too low.

**Output:** Updated skill generations, each with a lineage entry recording what changed and why

## Skills Dashboard Navigation

The Daemon UI → Skills page has two-layer onboarding designed for both first-time users and returning users:

1. **HelpCircle button** (page header, always visible): opens a dialog explaining the full pipeline, scheduling defaults, and quick-start steps. Use as a reference anytime.
2. **Empty states** in Skill List and Candidate List: contextual guidance that appears when there's nothing to show, with links to Agent Tasks for enablement.

## Common Pitfalls

**Candidates pile up but skills never materialize**
`skill-generate` is disabled by default. This is intentional — the system gates generative steps until you opt in. Enable via Agent Tasks.

**Survey returns zero candidates**
Vault is likely sparse. Check spore count per session. Keep accumulating data; the survey will surface candidates once cluster thresholds are met.

**skill-evolve silently stops mid-rewrite**
Turn budget exhausted. Sizing math: N STALE skills × ~10 turns/rewrite = turns needed for evolve phase. Add 20 turns for assess. Add 5 overhead. That is your task `maxTurns` floor. Increase `timeoutSeconds` proportionally (3 rewrites = ~15 min minimum).

**Generated skill missing user-invocable or allowed-tools**
These fields are enforced by `vault_write_skill`'s quality gate. If the task fails with a frontmatter error, all five required fields must be explicitly present in the YAML block.
