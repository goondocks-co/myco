---
name: myco:myco-skill-lifecycle
description: >-
  Use this skill when running or debugging the Myco skill lifecycle end to end:
  identifying candidates from vault knowledge, curating them through approval,
  generating `SKILL.md` files, and evolving existing skills as the vault grows.
  It applies to `skill-survey`, `skill-generate`, `skill-evolve`, and any work
  on the Skills dashboard, including cases where candidates appear but no
  skills materialize, surveys return zero results, or generated skills need
  refreshes.
managed_by: myco
user-invocable: true
allowed-tools:
  - Read
  - Edit
  - Write
  - Bash
  - Grep
  - Glob
---

# Myco Skill Lifecycle: Survey → Approve → Generate → Evolve

The skill lifecycle is a four-phase pipeline that turns raw vault knowledge into structured, reusable SKILL.md files on disk.

## Pipeline Overview

```
vault spores → [Survey] → candidates → [Approve] → approved → [Generate] → SKILL.md files → [Evolve] → updated SKILL.md
```

- **Survey** (`skill-survey`): Scans vault spores for clusters of repeated knowledge worth encoding as skills. Produces `skill_candidates` with status `identified`.
- **Approve** (Skills dashboard): Human review step. Candidates must reach `approved` status before skill-generate will act on them.
- **Generate** (`skill-generate`): Writes SKILL.md files to `.agents/skills/<name>/` from approved candidates.
- **Evolve** (`skill-evolve`): Identifies STALE skills and rewrites them with new vault knowledge.

## Scheduling Defaults (Asymmetric by Design)

- `skill-survey`: `enabled: true` — auto-runs during idle. Passive discovery; no mutation.
- `skill-generate`: `enabled: false` — requires explicit opt-in via Agent Tasks page.
- `skill-evolve`: `enabled: false` — requires explicit opt-in via Agent Tasks page.

This asymmetry is intentional: let the system build candidate evidence passively, but keep the generative and mutative steps user-driven until the user trusts the output quality.

## Phase 1: Survey

**Task:** `skill-survey` | **Default:** auto-enabled

Survey searches vault spores and sessions for recurring knowledge clusters. A good candidate captures a procedure or pattern a developer would benefit from knowing in advance — not a description of activity.

**Diagnosing zero results:**
- Vault needs a minimum evidence threshold (~20+ active spores from multiple sessions)
- Check that `skill-survey` is enabled and has a recent `Last Run` (Agent Tasks page)
- If candidates appear but all are `dismissed`, review dismissal rationale — thresholds may need tuning

## Phase 2: Approve

**Tool:** Skills dashboard (`/skills` route) | **Manual step**

Review the `identified` candidate pool:
1. Read the topic and rationale — confirm it captures a real, reusable procedure
2. Rename if the topic is vague (names become directory names, so clarity matters)
3. Set `approved` to queue for generation, or `dismissed` to remove

A task run with zero approved candidates is a no-op for skill-generate and skill-evolve.

## Phase 3: Generate

**Task:** `skill-generate` | **Default:** disabled

Writes SKILL.md files from approved candidates. Each write goes through the `vault_write_skill` quality gate:

**Gate enforces:**
- YAML frontmatter with all required fields: `name` (myco: prefix), `description`, `managed_by: myco`, `user-invocable`, `allowed-tools`
- `allowed-tools` must contain **Claude Code tool names only** — `vault_*` names cause immediate rejection with a clear error message
- `managed_by: myco`
- ≤500 lines

**Valid allowed-tools values:** `Read, Edit, Write, Bash, Grep, Glob`

**Invalid allowed-tools values (rejected):** Any `vault_*` name — vault_create_spore, vault_search_semantic, vault_write_skill, vault_spores, vault_state, etc.

**Frontmatter regression risk:** When skill-generate rewrites an existing skill mid-session (correction pass), it regenerates frontmatter from scratch. Fields like `user-invocable` and `allowed-tools` can be silently dropped if the prompt omits them. The quality gate enforces field presence — but not that values are correct. Verify `allowed-tools` values after any generate run that touches existing skills.

## Phase 4: Evolve

**Task:** `skill-evolve` | **Default:** disabled

Compares active skills against recent vault knowledge to find STALE skills, then rewrites them.

### Bias Toward CURRENT

**The evolve phase defaults to CURRENT.** STALE requires a *substantive factual change* — new behavior, a fixed bug, a changed API, or a discovered gotcha that the current skill gets wrong. Cosmetic phrasing differences alone are not sufficient.

Without this bar, LLM rewrites create a regression loop:
- Descriptions get shorter → triggering coverage degrades silently
- Detailed sections get consolidated → diagnostic value is lost (e.g., machine_id regression diagnosis, budget sizing math removed)
- Phrasing becomes generic → precision is lost

The rewritten skill passes validation but is structurally degraded. If in doubt, classify CURRENT.

### Evolve Constraints (Both Must Be Satisfied)

When rewriting a STALE skill:

1. **Do NOT shorten the description.** The description controls triggering coverage. Only change it if the trigger condition is factually wrong — never condense for brevity.
2. **Do NOT restructure correct sections.** Only modify the specific sections affected by the new knowledge. Preserve accurate content verbatim.

### Evolve Phase: allowed-tools Contamination Risk

`skill-evolve.yaml` instructs the LLM to "preserve ALL existing frontmatter fields." This rule faithfully copies errors — if the source skill already has vault_* names in `allowed-tools`, the preserve instruction propagates them into every subsequent evolution. The preservation rule is not a validator.

**Fix:** Always verify that `allowed-tools` contains only Claude Code tool names before writing — even when the frontmatter was copied from the prior version. The vault_write_skill gate will catch it, but it's better to fix proactively.

### Budget Sizing for skill-evolve

Each skill rewrite costs ~8–10 agent turns (read current skill + 2–3 knowledge searches + write). Budget must be sized for worst-case STALE count:

```
Assess phase: ~1.5 turns/skill × (number of active skills)
Evolve phase: ~10 turns/rewrite × (number of STALE skills)
```

With 3 STALE skills:
- Assess: ~13 turns | Evolve: ~30 turns | Total: ~43 turns

**Recommended task configuration:**
```yaml
maxTurns: 60          # sum of phase budgets (20 assess + 35 evolve + 5 overhead)
timeoutSeconds: 1800  # 3 rewrites × ~5 min + assess time
```

**Phase budgets:**
```yaml
assess phase: maxTurns: 20
evolve phase: maxTurns: 35
```

**Silent timeout failure mode:** If `maxTurns` is too low, the run ends "normally" but stops mid-rewrite with no error message pointing to the budget constraint. The failure is invisible unless you check whether the expected STALE skills were actually rewritten.

## Common Issues

### Candidates present but no skills appear
- Verify candidates have `approved` status (not just `identified`)
- Confirm skill-generate has been enabled and run for the candidate
- Check skill-generate run logs for quality gate rejections (most common: missing frontmatter fields, vault_* in allowed-tools)

### Skills aren't triggered by Claude Code
- Check the frontmatter `description` — is it specific enough to match the current context?
- Confirm `user-invocable: true` is present
- Confirm `.agents/skills/<name>/SKILL.md` exists on disk

### skill-evolve degraded a skill on rewrite
- Root cause: STALE classification had no minimum bar; cosmetic phrasing triggered a rewrite
- Check for shortened description, consolidated sections, or generic phrasing in the evolved version
- Restore from previous generation via vault_skill_records lineage if needed
- Verify skill-evolve.yaml has bias-toward-CURRENT directive and substantive-change threshold

### vault_write_skill rejects allowed-tools
- The error names the failing field
- Replace all vault_* names with Claude Code tools: `Read, Edit, Write, Bash, Grep, Glob`
- Check whether contamination propagated from a prior version via preserve-frontmatter
