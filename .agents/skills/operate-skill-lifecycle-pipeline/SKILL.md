---
name: myco:operate-skill-lifecycle-pipeline
description: Use this skill when working with Myco's skill lifecycle system — whether generating a new skill from an approved candidate, reviewing the candidate queue, updating a stale skill, retiring an outdated one, or debugging why a skill wasn't triggered. Activates whenever you touch vault_skill_candidates, vault_skill_records, or vault_write_skill — or whenever the user asks about skills, the Skills dashboard, skill generation tasks, or the .agents/skills/ directory. Apply this skill even if the user doesn't explicitly say "skill lifecycle" — any time a task involves producing or updating a SKILL.md file, evaluating candidates, or managing skill status, this procedure applies.
managed_by: myco
user-invocable: true
allowed-tools:
  - vault_skill_candidates
  - vault_skill_records
  - vault_write_skill
  - vault_spores
  - vault_search_semantic
  - vault_search_fts
---

# Operating the Myco Skill Lifecycle Pipeline

## Overview

The skill lifecycle pipeline converts vault knowledge into reusable SKILL.md files. Three agent tasks drive the pipeline: `skill-survey` (discovery), `skill-generate` (creation), and `skill-evolve` (maintenance). Understanding scheduling defaults is essential before any pipeline operation.

**Scheduling defaults — know these first:**
- `skill-survey`: `enabled: true` — auto-runs during idle; passively discovers candidates
- `skill-generate`: `enabled: false` — **opt-in required**; writes SKILL.md files to disk
- `skill-evolve`: `enabled: false` — **opt-in required**; rewrites stale skills

## Prerequisites

- Myco daemon running
- Vault has processed spores (Daemon UI → Sessions → verify spore count)
- Access to Daemon UI → Skills and Daemon UI → Agent Tasks

---

## Generating a Skill from an Approved Candidate

### Step 1: Verify Candidate Status

```
vault_skill_candidates(action: "list", status: "approved")
```

Confirm the target candidate is in `approved` status. If it's still `identified`, approve it in the Skills dashboard first.

### Step 2: Enable skill-generate (if not already enabled)

1. Daemon UI → Agent Tasks → find `skill-generate`
2. Toggle to `enabled: true`
3. Wait for next sweep or click **Run Now**

### Step 3: Verify the Output

```
vault_skill_records(action: "list", status: "active")
```

Confirm the new skill appears. Check the generated file at `.agents/skills/<name>/SKILL.md`.

**Quality gate:** `vault_write_skill` enforces five required frontmatter fields: `name`, `description`, `managed_by`, `user-invocable`, `allowed-tools`. A write missing any field is rejected at the tool level before the file is created.

---

## Managing Candidates

**List pending candidates:**
```
vault_skill_candidates(action: "list", status: "identified")
```

**Approve a candidate:**
```
vault_skill_candidates(action: "update", id: "<id>", status: "approved")
```

**Dismiss a candidate:**
```
vault_skill_candidates(action: "update", id: "<id>", status: "dismissed")
```

**Recover a dismissed candidate:**
```
vault_skill_candidates(action: "list", status: "dismissed")
vault_skill_candidates(action: "update", id: "<id>", status: "identified")
```

---

## Updating a Stale Skill

### Step 1: Read the current skill record

```
vault_skill_records(action: "get", id: "<name-or-uuid>")
```

Note the `path`, `generation`, and `source_ids`. You will carry all frontmatter fields forward in the rewrite.

### Step 2: Gather new knowledge

```
vault_search_semantic(query: "<skill topic keywords>")
vault_search_fts(query: "<specific terms>")
```

Find spores created after the skill's `updated_at` timestamp that are relevant to the skill's domain.

### Step 3: Rewrite via vault_write_skill

Preserve ALL existing frontmatter fields. Incorporate new knowledge. Stay under 500 lines.

```
vault_write_skill(
  name: "<kebab-name>",
  display_name: "...",
  description: "...",
  content: "---\nname: myco:<name>\n...\n---\n\n# ...",
  rationale: "Updated: added <what changed> from spore <id>"
)
```

`vault_write_skill` automatically bumps the generation and creates a lineage entry with the rationale.

### Step 4: Retire an outdated skill

```
vault_skill_records(action: "update", id: "<id>", status: "retired")
```

---

## Debugging: Why Wasn't a Skill Triggered?

Work through this checklist in order:

### 1. Is skill-generate enabled? ← Start here

**`skill-generate` is `disabled` by default.** This is the most common reason skills never materialize despite a healthy candidate queue. Check Daemon UI → Agent Tasks → `skill-generate` → verify `enabled: true`. If it was disabled, enable it and run.

### 2. Are there approved candidates?

```
vault_skill_candidates(action: "list", status: "approved")
```

If empty: candidates may be `identified` (awaiting approval). Check the Skills dashboard and approve them first.

### 3. Did the task run recently?

Check Daemon UI → Agent Tasks → `skill-generate` for last run timestamp and status. If it errored, read the run log for the specific failure.

### 4. Did the quality gate reject the write?

`vault_write_skill` rejects writes missing required frontmatter. If the task ran but no file appeared, check run output for a quality gate error. All five fields must be present: `name`, `description`, `managed_by`, `user-invocable`, `allowed-tools`.

### 5. Did a turn budget or timeout exhaust occur? (skill-evolve)

For `skill-evolve` specifically: if the evolve phase hits `maxTurns` before finishing all STALE skills, it stops silently with no error. The run ends "normally" but incomplete. Diagnose by checking whether expected skills were actually updated. Fix: increase `maxTurns` (N STALE × ~10 turns + 20 assess + 5 overhead) and `timeoutSeconds` (N × ~5 min).

---

## Skills Dashboard Navigation

The Daemon UI → Skills page has two-layer onboarding:

1. **HelpCircle button** (page header, always visible): opens a dialog explaining the full Survey→Approve→Generate→Evolve pipeline, scheduling defaults, and quick-start steps. Always available as a reference.
2. **Empty states** in Skill List and Candidate List: contextual first-time guidance that links to Agent Tasks for enablement. Disappears once content exists.

Use the HelpCircle dialog when onboarding a new team member or returning to the pipeline after a long absence.

---

## Common Pitfalls

**Approved candidates but no SKILL.md files appear**
`skill-generate` is disabled by default. Enable it via Agent Tasks. This is the primary diagnostic step.

**skill-evolve silently stops mid-rewrite**
Turn budget exhausted. Multi-STALE runs are multiplicative: each skill rewrite costs ~10 turns. Recalibrate `maxTurns` to cover all phases: task `maxTurns` ≈ sum of all phase `maxTurns` + 5 overhead. Increase `timeoutSeconds` for runs with 3+ STALE skills (minimum 30 minutes).

**Frontmatter field missing on vault_write_skill**
All five fields required at the tool-gate level: `name`, `description`, `managed_by`, `user-invocable`, `allowed-tools`. Fix the content and retry — the gate rejects before writing the file.

**skill-evolve won't run despite stale skills**
`skill-evolve` is disabled by default. Enable it explicitly via Agent Tasks before the assess/evolve phases will execute.
