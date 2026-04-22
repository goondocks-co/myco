---
name: myco:operate-skill-lifecycle-pipeline
description: Use this skill when working with Myco's skill lifecycle system — whether generating a new skill from an approved candidate, reviewing the candidate queue, updating a stale skill, retiring an outdated one, or debugging why a skill wasn't triggered. Activates whenever you touch vault_skill_candidates, vault_skill_records, or vault_write_skill — or whenever the user asks about skills, the Skills dashboard, skill generation tasks, or the .agents/skills/ directory. Apply this skill even if the user doesn't explicitly say "skill lifecycle" — any time a task involves producing or updating a SKILL.md file, evaluating candidates, or managing skill status, this procedure applies.
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

# Operating the Myco Skill Lifecycle Pipeline

Hands-on reference for managing skill candidates, skill records, and SKILL.md files using Myco's agent tools and Skills dashboard.

## Pipeline Architecture and Scheduling

**Asymmetric scheduling defaults** reflect a deliberate progressive disclosure model:
- `skill-survey` is `enabled: true` (auto-runs during idle, discovers candidates without user intervention)
- `skill-generate` and `skill-evolve` are `enabled: false` (require explicit opt-in)

This prevents runaway generation costs while ensuring candidate discovery happens automatically.

**Survey quality transformation:** The survey pipeline now runs cluster-first (grouping related spores before proposing candidates), producing 5 domain-scoped candidates vs the old pipeline's 102 candidates with 74.5% dismissed. This dramatically improves signal-to-noise ratio.

## Tool Reference

### vault_skill_candidates
Manages skill candidates — knowledge clusters identified as potential skills.

```
// List by status
vault_skill_candidates(action: "list", status: "identified"|"approved"|"dismissed"|"generated")

// Get single candidate
vault_skill_candidates(action: "get", id: "<uuid>")

// Approve a candidate
vault_skill_candidates(action: "update", id: "<uuid>", status: "approved", rationale: "...")

// Create a candidate manually
vault_skill_candidates(action: "create", topic: "...", rationale: "...")
```

Status lifecycle: `identified` → `approved` → `generated`. Dismiss with `status: "dismissed"`.

**UI Labels:** In the Skills dashboard, "Approved" status is labeled "Awaiting generation" for clarity. Use the combined "Approved & generated" filter to see the full pipeline progress.

### vault_skill_records
Manages materialized skill records (the DB representation of files on disk).

```
// List active/stale/retired skills
vault_skill_records(action: "list", status: "active"|"stale"|"retired")

// Get a specific skill (by name or UUID)
vault_skill_records(action: "get", id: "<name-or-uuid>")

// Retire a skill
vault_skill_records(action: "update", id: "<uuid>", status: "retired")
```

### vault_write_skill
**Staging-based workflow:** `vault_write_skill` now writes to `.myco/staging/skills/<candidate_id>/SKILL.md` as a provisional draft. The skill remains in staging until promoted via `vault_finalize_skill` (human approval required).

```
vault_write_skill(
  name: "kebab-case-name",           // directory name — no myco: prefix here
  display_name: "Title",
  description: "triggering description",
  content: "<full SKILL.md with frontmatter>",
  source_ids: "id1,id2",             // optional: comma-separated spore IDs
  rationale: "what changed",         // optional: written into lineage
  candidate_id: "<uuid>"             // required for staging workflow
)
```

**Quality gate enforces at write time:**
- YAML frontmatter with all required fields
- `name: myco:<name>` prefix
- `managed_by: myco`
- `user-invocable` field present
- `allowed-tools` containing **Claude Code tool names only** — vault_* names are rejected
- ≤500 lines total

**Security enforcement:** Agents cannot self-promote skills from staging to live. The `vault_finalize_skill` tool requires human review and explicit approval.

### vault_finalize_skill
Promotes a staged skill draft to the live `.agents/skills/` directory and creates the corresponding skill record.

```
vault_finalize_skill(candidate_id: "<uuid>")
```

This tool is human-only — agents cannot call it directly. It provides the final quality gate and audit trail via `approved_at` timestamps.

## Producing a SKILL.md File

### From an approved candidate (staging workflow)

1. Get the candidate: `vault_skill_candidates(action: "get", id: "<uuid>")`
2. Search for related spores: `vault_search_semantic(query: "<topic>", limit: 10)`
3. Write to staging: use `vault_write_skill` with `candidate_id` parameter
4. **Human review required:** The skill remains in `.myco/staging/` until promoted
5. After promotion, the candidate status automatically updates to `generated`

### Updating an existing skill

1. Get current record: `vault_skill_records(action: "get", id: "<name>")`
2. Read the file at the `path` field to see current content
3. Identify what changed — update only the affected sections
4. Write with `rationale` describing what was updated
5. **Direct write to live:** Skill updates bypass staging and write directly to `.agents/skills/`

**Critical when updating:** Check `allowed-tools` in the existing frontmatter **before** carrying it forward. If it contains vault_* names (vault_create_spore, vault_search_semantic, vault_write_skill, etc.), replace them with Claude Code tools. The gate will reject the write otherwise. See Contamination section below.

### Splitting an oversized skill

1. Identify distinct procedures in the current skill
2. Write each as a new focused skill with its own name and description
3. Retire the parent: `vault_skill_records(action: "update", status: "retired")`

### Retiring a skill

```
vault_skill_records(action: "update", id: "<uuid>", status: "retired")
```

Retiring preserves the record and lineage but removes the skill from the active pool. Use when a skill has been superseded by focused replacements or the procedure is no longer applicable.

## Frontmatter Requirements

Every SKILL.md must contain all six required fields in its YAML frontmatter:

| Field | Requirement |
|---|---|
| `name` | `myco:<kebab-case-name>` — must match directory name |
| `description` | Triggering description — primary matching signal for Claude Code |
| `managed_by` | Always `myco` |
| `user-invocable` | Always `true` for developer-facing skills |
| `allowed-tools` | Claude Code tools only: `Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob` |

**Omitting any of these fields causes a vault_write_skill rejection**, even if the field was present in a prior version. Mid-session rewrites that regenerate frontmatter from scratch are a common source of silent omissions.

## Diagnosing vault_write_skill Rejections

The tool returns a descriptive error identifying the failing constraint:

| Error | Fix |
|---|---|
| `allowed-tools contains vault_* names` | Replace with Claude Code tools: `Read, Edit, Write, Bash, Grep, Glob` |
| `missing managed_by: myco` | Add `managed_by: myco` to frontmatter |
| `missing user-invocable` | Add `user-invocable: true` to frontmatter |
| `missing name with myco: prefix` | Ensure `name: myco:<skill-name>` in frontmatter |
| `name contains path traversal` | Remove `/`, `\`, or `..` from the name parameter |
| `exceeds 500 lines` | Trim content or split into sub-skills |

### allowed-tools Contamination

The vault_write_skill gate was added specifically because of a silent propagation bug: `skill-evolve.yaml`'s "preserve ALL existing frontmatter fields" instruction faithfully copies vault_* names from a contaminated skill into every subsequent evolution. The preservation rule is not a validator.

**Contamination propagation path:**
1. A skill has vault_* names in `allowed-tools` (e.g., generated when the spec was wrong)
2. skill-evolve is run; the LLM preserves all frontmatter fields as instructed
3. The evolved version carries the bad values forward
4. vault_write_skill now rejects at write time — the error surfaces the bug

**How to fix a contaminated skill:** Read the current `allowed-tools` in the file, replace any vault_* names with `Read, Edit, Write, Bash, Grep, Glob`, and rewrite via vault_write_skill.

## Structural Enforcement vs Prompt Rules

**Security hardening pattern:** The pipeline now uses structural gates instead of advisory prompt rules. Three coordinated bug fixes closed gaps between prompt suggestions and actual enforcement:

1. **Agent self-promotion blocked:** Agents cannot call `vault_finalize_skill` directly
2. **Quality gates enforced at write-time:** Invalid frontmatter is rejected, not just warned about
3. **Audit trail required:** `approved_at` timestamps track human approval events

This follows the principle: **Enforce constraints in tools, not prompts.** Prompts are suggestions; tools are gates.

## Debugging Why a Skill Wasn't Triggered

Skills are loaded by Claude Code when the frontmatter `description` matches the current session context. Diagnosis checklist:

1. **File present?** Check `.agents/skills/<name>/SKILL.md` exists on disk
2. **`user-invocable: true`?** Open the file and verify this field is present and true
3. **Description broad enough?** The description is the only matching signal. Too narrow = fewer matches. Compare it to the actual task context.
4. **Description degraded?** Check if the skill was recently evolved — the rewrite may have shortened the description (see Over-Evolution section below). Compare with the previous generation.
5. **allowed-tools correct?** Confirm `allowed-tools` lists Claude Code tools only
6. **Still in staging?** Check if the skill is stuck in `.myco/staging/` awaiting promotion

## Diagnosing skill-evolve Over-Evolution

**Symptom:** A skill was classified STALE and rewritten, but the result is worse — shorter description, missing sections, generic phrasing — with no new factual content added.

**Root cause:** skill-evolve classified STALE on cosmetic phrasing differences rather than a substantive factual change. Without an explicit bias-toward-CURRENT directive, LLM rewrites interpret any new context as justification to refactor. This creates a regression loop:
- Descriptions get shorter → triggering coverage silently degrades
- Detailed sections get consolidated → diagnostic value lost (e.g., machine_id regression steps, budget sizing math)
- Phrasing becomes generic → precision lost

The rewritten skill passes all validation checks but is structurally degraded.

**Fix steps:**
1. Check skill-evolve.yaml — it must have an explicit "bias toward CURRENT unless there is a substantive factual change" instruction and a "do NOT restructure sections that are still correct" directive
2. Identify the previous generation via vault_skill_records lineage
3. Compare the description — if shortened, triggering coverage is degraded
4. Rewrite to restore description coverage plus any actual new knowledge

**The standard for STALE:** A new behavior, a fixed bug, a changed API, or a discovered gotcha that the current skill gets factually wrong. Cosmetic phrasing differences are not sufficient.

## skill-evolve Watermark Behavior

**Pre-filtering and no-op semantics:** The skill-evolve system uses watermark timestamps to optimize runs and prevent redundant processing:

- **Run-level deduplication:** Skills already assessed in the current run (matching `skill_evolve_last_run` timestamp) are automatically excluded from assessment to prevent duplicate analysis within a single execution
- **Knowledge watermark filtering:** Only skills with new knowledge since their `last_assessed_at` timestamp are eligible for evolution, creating an efficient change-detection mechanism  
- **No-op run detection:** When no skills qualify for evolution after pre-filtering (either due to recent assessment or lack of new knowledge), the entire run becomes a no-op — the agent reports completion without making any changes
- **Watermark rotation:** The `last_assessed_at` watermark is updated even when a skill is classified as CURRENT, ensuring proper rotation coverage in subsequent runs and preventing the same skill from being unnecessarily re-assessed

**Practical implications:** This watermark system explains why skill-evolve runs often complete quickly with "no changes needed" — either all candidate skills have been recently assessed, or new vault knowledge doesn't warrant updates. The system is designed to be efficient and avoid redundant work, making frequent skill-evolve runs safe and cost-effective.

## Budget Sizing for skill-evolve Runs

skill-evolve runs are multiplicative in agent turn cost. Each STALE skill rewrite costs ~8–10 turns (read + knowledge searches + write). Size the budget for worst-case STALE count:

```
Assess phase: ~1.5 turns/skill × (number of active skills)
Evolve phase: ~10 turns/rewrite × (number of STALE skills)
Task maxTurns: sum of phase budgets + ~5 turns overhead
```

**Recommended configuration for up to 3 STALE skills:**
```yaml
# task level
maxTurns: 60
timeoutSeconds: 1800

# assess phase
maxTurns: 20

# evolve phase
maxTurns: 35
```

**Silent failure mode:** If `maxTurns` is too low, the run ends "normally" but stops mid-rewrite with no error message. Always verify that the expected STALE skills were actually updated — check their generation number and `updated_at` after the run.