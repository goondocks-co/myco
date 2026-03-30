---
name: myco:operate-skill-lifecycle-pipeline
description: Use this skill when working with Myco's skill lifecycle system — generating skills from approved candidates, reviewing the candidate queue, updating stale skills, retiring outdated ones, or debugging why a skill wasn't triggered or why skill-evolve stopped mid-run.
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

# Operating the Myco Skill Lifecycle Pipeline

This skill covers the day-to-day operation of Myco's skill system: approving candidates, triggering generation, updating stale skills, retiring obsolete ones, and debugging pipeline failures.

## When to Activate

- Reviewing or advancing skill candidates (`vault_skill_candidates`)
- Running or debugging `skill-generate` or `skill-evolve` tasks
- Any work touching `vault_skill_records` or `vault_write_skill`
- Debugging why a skill wasn't generated after approving its candidate
- Investigating why `skill-evolve` appears to have completed but a skill wasn't updated
- Retiring a skill that no longer reflects current practice
- Anything in the `.agents/skills/` directory

## Generating a New Skill

1. **Find the candidate:** `vault_skill_candidates` (action: list, status: identified) — review the topic and rationale
2. **Approve it:** `vault_skill_candidates` (action: update, status: approved)
3. **Let skill-generate run** on its next scheduled interval, or trigger it manually via the daemon UI
4. **Verify:** `vault_skill_records` (action: get, id: <name>) — confirm `status: active` and `generation: 1`
5. **Check the file:** the SKILL.md should be at `.agents/skills/<name>/SKILL.md`

### Quality gate requirements

`vault_write_skill` mechanically enforces these YAML frontmatter fields — missing any causes rejection:
- `name:` — must start with `myco:` prefix
- `description:`
- `managed_by: myco`
- `user-invocable:` — `true` or `false`
- `allowed-tools:` — list of tool names

The gate also enforces: ≤500 lines, no `####` or deeper headers, valid YAML.

### Candidate linking behavior

`skill-generate` links a skill to its candidate using exact match (full name equality) or prefix match (topic starts with skill name). The blind fallback (which previously picked any unlinked candidate when both failed) was removed — a missed link is recoverable but a wrong link corrupts the skill graph. If a skill writes but the candidate status stays `approved` rather than advancing to `generated`, the link failed silently; check topic/name alignment.

## Updating a Stale Skill

Skills become stale when new vault knowledge (spores) isn't reflected in their content. The `skill-evolve` task handles this automatically, but you can also update manually:

1. **Identify what's new:** search for spores on the skill's topic since its last update
   ```
   vault_search_semantic("topic keywords") — check created_at vs skill updated_at
   ```
2. **Read the current skill:** `vault_skill_records` (action: get) — returns metadata but NOT file content. To inspect content, search vault for the previous write or reconstruct from source spore content.
3. **Write the update:** `vault_write_skill` with the full updated content and a `rationale` parameter describing what changed. The generation counter bumps automatically.

**Always preserve all frontmatter fields when rewriting.** Never regenerate frontmatter from scratch — `user-invocable` and `allowed-tools` can be silently dropped if the rewrite omits them (see Common Pitfalls).

## Retiring a Skill

Use `vault_skill_records` (action: update, status: retired) when:
- The skill describes a workflow that no longer exists
- The skill has been split into more focused sub-skills
- The underlying feature was removed or fundamentally redesigned

Retired skills are no longer evaluated by `skill-evolve` and won't appear in active skill search. The SKILL.md file on disk is preserved for historical reference.

## Debugging Why skill-evolve Stopped Mid-Run

`skill-evolve` runs an assess → evolve two-phase pipeline. If it appears to complete but some STALE skills were not updated, the most likely cause is **turn budget exhaustion in the evolve phase**.

### Diagnosing a truncated evolve run

1. Check how many skills were classified STALE in the assessment:
   - Read vault state: `vault_state` → look for `skill-evolve-classifications`
   - Count the skills with `"classification": "STALE"`

2. Compare actual vs. expected turn usage:
   - Each STALE skill rewrite costs ~8–10 turns (read skill, 2–3 knowledge searches, write)
   - If evolve phase `maxTurns` < (STALE count × 10), the phase hits the ceiling and stops silently

3. Check the current task budget in `src/agent/tasks/skill-evolve.yaml`:
   - **Correctly calibrated values:** task `maxTurns: 60`, `timeoutSeconds: 1800`, assess phase `maxTurns: 20`, evolve phase `maxTurns: 35`
   - If values are lower than these, the task needs recalibration

4. The failure mode is non-obvious: the run appears to succeed with no error. The skill left mid-rewrite simply wasn't updated — it will be STALE again on the next cycle.

### Recalibrating the budget

**Sizing formula:**
- evolve phase `maxTurns` = (max expected STALE count) × 10
- task `maxTurns` = assess phase maxTurns + evolve phase maxTurns + 5 overhead
- `timeoutSeconds` = (max STALE count) × 300 + 300 for assess

Current production sizing supports up to 3 STALE skills per run. If your vault regularly produces more than 3 STALE skills per cycle, increase the evolve phase budget accordingly.

## Debugging Why skill-generate Doesn't Fire

After the P1 scheduler concurrency fixes (global boolean → per-task `Set<string>`, taskless run guard, `lastRun` in `finally`), skill lifecycle tasks run independently. If `skill-generate` still isn't triggering:

1. **Check candidate status:** `vault_skill_candidates` (action: list, status: approved) — must have at least one `approved` candidate; `identified` candidates do not trigger generation
2. **Check scheduler state:** look for `[task-scheduler]` log entries in the daemon output
3. **Verify task config:** `src/agent/tasks/skill-generate.yaml` — confirm `enabled: true` and `schedule.interval` is set
4. **Check for a stuck concurrent run:** If a previous skill-generate run is still active (e.g., hung), the per-task guard blocks new invocations

## Security and Integrity of the Skill Write Path

The `vault_write_skill` tool enforces three security properties:

1. **Path traversal guard:** Skill names containing `/`, `\\`, or `..` are rejected before `path.resolve()` — a pre-resolve guard (not a post-resolve prefix check, which `path.normalize()` could bypass).
2. **Transaction wrapping:** All DB mutations (insert skill record, update metadata, write file path) run in a single `db.transaction()`. A mid-sequence failure rolls back cleanly — no orphaned records.
3. **Candidate update whitelisting:** `handleUpdateCandidate` destructures only `status`, `topic`, `rationale`, `confidence`, `source_ids`, `skill_id` — raw request body is never passed to the DB.

## Common Pitfalls

### Stale skill not updated after evolve run

The most common cause is evolve phase turn budget exhaustion (see Debugging section above). Check `skill-evolve-classifications` in vault state to confirm the skill was classified STALE, then verify the evolve phase `maxTurns` was sufficient for the number of STALE skills in that run.

### Frontmatter fields silently dropped during rewrite

When `skill-generate` rewrites an existing skill mid-session (second-pass correction), it can regenerate frontmatter from scratch and drop `user-invocable` and `allowed-tools`. The write succeeds but the skill is structurally degraded. **Fix already applied:** both fields are now in `REQUIRED_FRONTMATTER_FIELDS` in `vault_write_skill` — the tool rejects writes missing these fields before anything is written.

**If you're writing skills manually:** always carry all frontmatter fields forward. Do not reconstruct frontmatter from memory — read the current version first.

### detectSkillUsage performing I/O when skill-usage is disabled

`detectSkillUsage` historically read transcript files even when the feature was disabled — wasting I/O on every agent run. Fix: `skillUsageEnabled` flag is exported and checked at the call site before touching the filesystem. Feature flags must gate I/O at the call site, not after I/O has already occurred inside the feature function.
