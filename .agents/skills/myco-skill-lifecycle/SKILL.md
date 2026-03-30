---
name: myco:myco-skill-lifecycle
description: Use this skill when you need to run the Myco skill lifecycle end-to-end — identifying skill candidates from vault knowledge, curating them through the approval workflow, generating SKILL.md files on disk, and evolving existing skills as the vault grows. Activate even if the user only asks about one phase — understanding the full chain prevents common sequencing mistakes.
managed_by: myco
user-invocable: true
allowed-tools:
  - vault_skill_candidates
  - vault_skill_records
  - vault_write_skill
  - vault_search_semantic
  - vault_search_fts
  - vault_spores
  - vault_state
  - vault_set_state
  - vault_report
---

# Myco Skill Lifecycle: Survey → Approve → Generate → Evolve

Myco converts vault knowledge into reusable SKILL.md files through a four-phase pipeline: **skill-survey** clusters spores into candidates, the **Skills dashboard** curates them, **skill-generate** writes the files, and **skill-evolve** keeps them current as the vault grows.

## When to Activate

- Any work touching `src/agent/tasks/skill-survey.yaml`, `skill-generate.yaml`, or `skill-evolve.yaml`
- Any work on the Skills dashboard in the Daemon UI (`/skills`)
- Candidates appear in the dashboard but no SKILL.md files ever materialize
- Survey task returns zero candidates despite an active vault
- A generated skill is missing fields or appears structurally degraded
- You need to refresh an existing skill that is out of date

## Prerequisites

- Vault is populated (at least one session processed with active spores)
- Agent pipeline is configured and running in the daemon
- Daemon UI accessible with Skills dashboard visible at `/skills`

## Phase 1: Skill Survey (`skill-survey`)

The survey task reads active spores, clusters them by topic using semantic similarity, and registers new candidates via `vault_skill_candidates` (action: create).

**Trigger:** Runs on schedule. Does nothing if no spore clusters exceed the minimum density threshold.

**If survey returns zero candidates:**
1. Confirm the agent has run and extracted spores: `vault_spores` should return active entries
2. Check that spores have topics with sufficient overlap — the survey requires at least 3 related spores to propose a candidate
3. Verify the task is enabled and the schedule is firing in the daemon

## Phase 2: Candidate Curation (Skills Dashboard)

New candidates land in `identified` status. A human must advance them to `approved` before generation begins — this gate is intentional.

1. Open `/skills` in the Daemon UI
2. Review candidates in the **Pending** column; read the rationale to evaluate each
3. **Approve** to advance to `status: approved`, or **Dismiss** to remove
4. Approved candidates queue for `skill-generate` on its next scheduled run

**Tip:** If skills are not generating, check the candidate queue first — the most common cause is candidates stuck in `identified` status.

## Phase 3: Skill Generation (`skill-generate`)

Processes `approved` candidates and writes SKILL.md files to `.agents/skills/<name>/SKILL.md` via `vault_write_skill`.

**Required YAML frontmatter fields** (the quality gate mechanically enforces all of these):
- `name:` — must be prefixed `myco:` (e.g., `myco:my-skill-name`)
- `description:` — single-line summary
- `managed_by: myco`
- `user-invocable:` — `true` or `false`
- `allowed-tools:` — list of vault tool names the skill needs

Missing any required field causes `vault_write_skill` to reject the write before the file is created or any DB record is modified.

**Content structure:** Overview → Prerequisites → Steps → Common Pitfalls.

## Phase 4: Skill Evolution (`skill-evolve`)

The evolve task runs a two-phase pipeline (assess → evolve) to keep existing skills current.

**Current calibrated budget values:**

| Parameter | Value | Rationale |
|---|---|---|
| task `maxTurns` | 60 | Sum of phase budgets (20 + 35) + 5 overhead |
| task `timeoutSeconds` | 1800 | 3 rewrites × ~5 min + assess time |
| assess phase `maxTurns` | 20 | ~1.5 turns per skill for up to 9 skills + report |
| evolve phase `maxTurns` | 35 | ~10 turns per rewrite × up to 3 STALE skills |

**Assess phase:** Classifies each active skill as CURRENT, STALE, CONFLICTED, or OVERSIZED. Stores classifications in vault state under `skill-evolve-classifications`.

**Evolve phase:** For each STALE/CONFLICTED skill — reads current content, gathers new spores, rewrites via `vault_write_skill` with a `rationale` parameter. Generation counter bumps automatically; lineage entry is created.

## Common Pitfalls

### Evolve phase times out silently with multiple STALE skills

The evolve phase `maxTurns` must be sized for the worst-case STALE count, not a single rewrite. Each skill rewrite costs ~8–10 turns (read current content, 2–3 knowledge searches, write). With 3 STALE skills: ~24–30 turns needed against a previously-misconfigured 18-turn ceiling.

**The failure mode is non-obvious:** the run appears to complete normally but stops mid-rewrite with no error pointing to the budget constraint. The skill being rewritten when the budget ran out is left in its pre-update state with no indication that evolution was incomplete.

**Sizing formula:** evolve phase `maxTurns` = N × 10 where N is the maximum expected STALE skill count per run. Current production value (35 turns) supports up to 3 STALE skills with headroom.

### Skill-generate rewrites silently drop `user-invocable` and `allowed-tools`

When `skill-generate` makes a second-pass correction to an existing skill mid-session, it regenerates YAML frontmatter from scratch rather than carrying forward the prior version. The fields `user-invocable` and `allowed-tools` were historically omitted in this regenerated frontmatter — the skill wrote successfully but was structurally degraded (can no longer be invoked, tool constraints lost). The failure is invisible in logs.

**Status of fix:** Both fields are now in `REQUIRED_FRONTMATTER_FIELDS` in `vault_write_skill`'s quality gate. The tool mechanically rejects any skill write missing these fields before the file is written.

**Division of responsibility:** Tool gate handles field presence; prompt handles content quality. Prompt-level expectations degrade under context pressure; tool gates do not. Any frontmatter field critical for runtime behavior (invokability, tool scope, agent routing) must be enforced at the tool level — not left to prompt compliance.

### Generation doesn't fire despite approved candidates

After the P1 scheduler concurrency fixes (global `agentRunning` boolean replaced with per-task `Set<string>`, taskless run guard, `lastRun` in `finally` block), skill lifecycle tasks run independently. If `skill-generate` still isn't firing:
1. Verify at least one candidate has `status: approved` — a missing approved candidate is the most common cause
2. Check the daemon log for `[task-scheduler]` entries showing why the task was skipped
3. Confirm the task is `enabled: true` in the config

### Reading current skill content before rewriting

`vault_skill_records` (action: get) returns metadata (description, generation, source_ids, status) but NOT the full SKILL.md content — content lives on disk. Always carry all frontmatter fields forward when rewriting. Never regenerate frontmatter from scratch during a correction pass.
