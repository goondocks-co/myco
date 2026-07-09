---
type: Subsystem
title: "Skill Lifecycle: Candidates to Records"
description: How Myco skills move from candidate through skill_records to a live SKILL.md via vault_write_skill's joint quality gate, and the ceiling/floor deadlock bug that taught the pipeline to batch its failures.
timestamp: '2026-07-08T15:52:42.322Z'
---

## Overview

Myco's skill lifecycle turns repeated observations into reusable `SKILL.md` files through three durable states: a **candidate** (`skill_candidates` row) proposed by skill-survey, a **record** (`skill_records` row) once a candidate is materialized, and a **published file** on disk under `.agents/skills/<name>/`. All of it is implemented in one module, `packages/myco/src/agent/tools/skill-tools.ts`, which exposes ten vault tools spanning survey preparation, candidate CRUD, contamination scanning, staged drafting, and the two commit paths (`vault_write_skill` for one-shot create-or-evolve, `vault_stage_skill` + `vault_finalize_skill` for the draft/promote flow used by skill-generate). This lifecycle is exercised by the same Myco agent harness that runs `skill-evolve`, `skill-survey`, and `skill-generate` tasks, and every candidate/record/write is itself an observation the harness's own [vault intelligence](/subsystems/vault-intelligence.md) layer can later reference.

## Candidate states and who can move them

`packages/myco/src/constants/skill-candidate-status.ts` defines five canonical statuses:

- `identified` — discovered by skill-survey, awaiting human review
- `approved` — human approved, queued for skill-generate
- `generated` — promoted to a live skill (set only by `vault_finalize_skill`)
- `dismissed` — retired
- `deferred` — postponed

The module is explicit about *who* can make each transition. `AGENT_SETTABLE_STATUSES` restricts the agent-facing `vault_skill_candidates` tool to `identified | dismissed | deferred` — an agent can flag or retire a candidate but cannot approve its own work. `approved` is a human-only transition through the UI or REST API, and `generated` is set internally, never through REST, only by the finalize path. This three-tier permission split (agent / human / internal-only) is the load-bearing guardrail that keeps skill promotion from becoming self-approving.

## The write path: one-shot vs. staged

Two commit paths exist for different callers:

- **`vault_write_skill`** — the one-shot create-or-evolve path used by `skill-evolve` and other non-staged authoring. It runs the full gate suite (below) against the proposed content and, on success, performs the DB + filesystem write directly.
- **`vault_stage_skill` → `vault_finalize_skill`** — used by `skill-generate`'s draft phase. `vault_stage_skill` writes a provisional `SKILL.md` + `manifest.json` under `.myco/staging/skills/<candidate_id>/` without touching the live DB or `.agents/skills/`. `vault_finalize_skill` is the only commit point: it re-runs dedup and validation as defense in depth, then atomically inserts the `skill_records` row, lineage, flips the candidate to `generated`, writes the disk file, and syncs symlinks — cleaning up staging on success.

Both paths converge on the same gate logic so a staged draft and a one-shot write are held to identical quality bars.

## The quality gate: `collectSkillWriteIssues`

`packages/myco/src/agent/tools/skill-write-validator.ts` composes every write-time content gate into a single pass:

1. **Structural gate** (`validateSkillContent` in `skill-validator.ts`) — parses frontmatter with `YAML.parse()` rather than regex, and enforces: the skill `name` must carry the `myco:` prefix and match its directory name; `managed_by` must equal `myco`; `description` must be ≤1024 characters (`MAX_SKILL_DESCRIPTION_CHARS`); and the file must be ≤800 lines (`MAX_SKILL_LINES`).
2. **Frontmatter preservation gate** (`checkFrontmatterPreservation`, updates only) — protected fields (like `user-invocable`) can't silently flip, and a description can't shrink by more than 10% of its prior length (`computeDescriptionFloor`).
3. **Fabrication/claim gate** (`verifySkillContentClaims`) — inline backtick path and symbol claims in the skill body are checked against the real repository; unverified fenced-code symbols are warned, not blocked.

The docstring at the top of `skill-write-validator.ts` states the design rationale directly: `vault_write_skill` used to run these gates **sequentially with early returns**, so the agent only ever saw one class of error per attempt and had to iterate — fix length, trip the floor, fix the floor, trip fabrication. `collectSkillWriteIssues` instead returns every problem at once, plus (for updates) a `descWindow` — the satisfiable `{min, max}` description-length range — so the agent can target a value that survives both constraints in one shot.

## The load-bearing lesson: the ceiling/floor deadlock

That redesign exists because of a bug found in session `27cfd6b6` (shipped as **PR #596**, tag `myco/v1.2.5`): a **description-length convergence trap**. The pre-fix validator enforced two opposing constraints, reported one at a time:

| Constraint | Source | Rule |
|---|---|---|
| Ceiling | `validateSkillContent` | `description.length ≤ 1024` |
| Floor | `checkFrontmatterPreservation` | `newDesc.length ≥ oldDesc.length × 0.9` |

The valid update window is `[oldLen × 0.9, 1024]`. When `oldDesc.length > 1138` chars (`1024 ÷ 0.9 ≈ 1138`), the floor exceeds the ceiling and **no valid description value exists** — the agent hits a hard deadlock it cannot reason its way out of, no matter how good its instructions are. Because gates were checked sequentially, the agent would see the ceiling failure, shorten the description, then see the floor failure on the next attempt, lengthen it again, and loop until context ran out.

This is why `collectSkillWriteIssues` reports both violations together and surfaces the satisfiable window explicitly — the fix isn't just "show more errors," it's recognizing that some gate combinations are jointly unsatisfiable unless the *insertion-time* ceiling is enforced early enough that update-time floors never grow past it. The synthesized wisdom from that session (`f0910ba8`) frames this as one of three interconnected `skill-evolve` production-quality failure modes, alongside literal-XML tool-call emission (~17% of runs) and the historical absence of a read-only pre-validator (`vault_scan_skill_contamination` was the one gate with a dry-run counterpart; the write gates were write-time only, forcing blind retry loops). The `skill-evolve` act phase accounts for ~82% of a run's cost, so a gate design that traps the agent in a retry loop is not just a correctness bug — it is the expensive failure mode in the whole pipeline.

## Structural validation over regex

A separate, earlier hardening pass (`spore_f29557ae5fffbec893c2d321bc201c16`) fixed a related root cause: `skill-validator.ts` originally checked frontmatter with substring/regex patterns, which couldn't validate YAML structure and let malformed frontmatter and overlong descriptions slip through — especially multiline descriptions, which defeat single-line regex. The fix switched to `YAML.parse()` plus explicit field checks, and unified two previously-divergent frontmatter-extraction code paths (`validateSkillContent`'s inline regex vs. the shared `extractFrontmatterField` utility) so validation and preservation checks always see the same parsed data. The 1024-character description ceiling is now enforced at three independent checkpoints — the `vault_write_skill` gate, a repo-level smoke test over all checked-in `SKILL.md` files, and a unit-level regression test — a defense-in-depth pattern (prompt → validator gate → smoke test) that recurs through this subsystem.

## Security hardening on the write path

A third hardening pass found and fixed three input-side vulnerabilities in the skill write path (`spore_600825b0d751493bf523edba83e5270a`):

- **Path traversal** in `vault_write_skill` — skill names went straight into `path.resolve()` unsanitized, so `/`, `\`, or `..` in a name could escape the skills directory. Fixed with a pre-resolve guard that rejects those characters before `resolve()` runs, since `resolve()` normalizes traversal sequences away and a post-resolve prefix check would come too late.
- **Missing transaction** — multiple DB mutations (skill record insert, metadata update, file path write) ran outside `db.transaction()`, so a mid-sequence failure could leave orphaned records. Fixed by wrapping all mutations in one transaction.
- **Mass-assignment** in `handleUpdateCandidate` — the API route wrote the raw request body to the DB. Fixed with explicit destructuring that whitelists only `status`, `topic`, `rationale`, `confidence`, `source_ids`, `skill_id` — a whitelist rather than a blocklist, so new columns are safe-by-default.

The pattern across all three: skill write paths had accumulated "it works in practice" trust without "it's safe by design" enforcement — every fix is an input-side gate applied before any DB or filesystem operation touches the value.

## What's next: patch-based editing

A follow-up decision from the same PR #596 session (`id-hash-bb2a62f7c8e50f3d`, not yet on the release line) designs `vault_edit_skill(name, edits)` as a sibling to `vault_write_skill` for incremental updates: `str_replace`-style `{old_string, new_string}` edits applied sequentially in memory, validated with the same `collectSkillWriteIssues` gate on the reconstructed full skill, and only written atomically if every edit and every gate passes. The motivation is cost, not correctness — the `skill-evolve` act phase was regenerating entire skills to make small changes; targeted edits are projected to cut act-phase output tokens roughly 10× and full-run cost from ~$2.68 to ~$0.6–0.8. `vault_write_skill` remains the fallback for creates and structural merges.

# Citations

- `packages/myco/src/agent/tools/skill-tools.ts` — the ten-tool skill lifecycle module (candidates, records, staged write/finalize, one-shot write)
- `packages/myco/src/constants/skill-candidate-status.ts` — canonical candidate statuses and agent/REST-settable transition sets
- `packages/myco/src/agent/tools/skill-write-validator.ts` — `collectSkillWriteIssues`, the joint gate composition and `descWindow` fix
- `packages/myco/src/agent/tools/skill-validator.ts` — `validateSkillContent`, `checkFrontmatterPreservation`, `computeDescriptionFloor`, `MAX_SKILL_LINES`, `MAX_SKILL_DESCRIPTION_CHARS`
- Session `id-hash-1f55443fe11bf514` — "Fixed skill-validation failures (PR #596)," the ceiling/floor deadlock diagnosis and fix (released, tag `myco/v1.2.5`)
- Spore `id-hash-6099e735ed826ed3` (wisdom) — three interconnected skill-evolve production failure modes
- Spore `spore_f29557ae5fffbec893c2d321bc201c16` (wisdom) — structural YAML validation replacing regex, unified frontmatter extraction
- Spore `spore_600825b0d751493bf523edba83e5270a` (wisdom) — path traversal, missing transaction, and mass-assignment fixes on the skill write path
- Spore `id-hash-bb2a62f7c8e50f3d` (decision) — `vault_edit_skill` patch-based editing design (plan `d4e3d7d1cb561853`)
