---
name: myco:write-myco-skill
description: Create and validate a Myco-managed SKILL.md file using vault_write_skill. Use when authoring a new skill from scratch, updating an existing skill, or fixing a skill that failed the quality gate. Applies whenever you need to produce a valid .agents/skills/<name>/SKILL.md file that passes structural validation. Also load when vault_write_skill returns a rejection error — the error message identifies the failing constraint, but this skill explains the full field contract and the known contamination pitfalls.
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

# Writing a Myco-Managed Skill

A Myco-managed skill is a SKILL.md file with YAML frontmatter that Claude Code reads to decide whether to load procedural context. The `vault_write_skill` agent tool writes the file to disk, creates or updates the skill record in the vault database, and bumps the generation counter.

## Prerequisites

- An approved skill candidate (from `vault_skill_candidates`) or a specific skill to update
- A clear scope: one procedure, one context — not a broad reference document
- The skill name in kebab-case (e.g., `register-mcp-tool`, `add-vault-table`)

## Frontmatter Structure

Every SKILL.md must open with a YAML frontmatter block containing all six required fields:

```yaml
---
name: myco:<kebab-case-name>
description: <triggering description>
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
```

### Field Reference

**`name`** — Must use the `myco:` prefix (e.g., `myco:add-vault-table`). The kebab-case portion must match the directory name under `.agents/skills/`. Do not use `/`, `\`, or `..` in the name — the path security gate rejects these before any filesystem operation.

**`description`** — The primary triggering mechanism. Claude Code reads this to decide whether to load the skill. Write it to be specific and pattern-rich:
- Name the exact conditions that should trigger the skill
- Include related component names, file paths, and tool names
- Cover edge cases and indirect triggers
- **Never shorten for brevity.** A shorter description means fewer matches. Only change the description if the trigger condition is factually wrong.

**`managed_by`** — Always `myco`. Required. Do not change.

**`user-invocable`** — Always `true` for developer-facing skills. The quality gate enforces field presence — omitting it causes a rejection even if it was present in a prior version.

**`allowed-tools`** — **Must list Claude Code tool names only.**

Valid values:
- `Read` — reading files
- `Edit` — editing existing files
- `Write` — writing new files
- `Bash` — running shell commands
- `Grep` — searching file content
- `Glob` — listing files by pattern

**Do NOT include `vault_*` tool names** (vault_create_spore, vault_search_semantic, vault_write_skill, vault_spores, vault_state, etc.). The `vault_write_skill` quality gate rejects any skill whose `allowed-tools` field contains vault_* names — in both comma-separated string and YAML list formats. This rejection happens at write time with a clear error message; the file is never touched.

- Most procedural skills need all six Claude Code tools
- Read-only or informational skills need: `Read, Bash, Grep, Glob`

## Content Structure

After the frontmatter, write the skill body:

1. **Opening summary** — 1–2 sentences describing the skill's scope
2. **Prerequisites** — what the developer needs before starting
3. **Steps** — numbered, concrete procedural steps with specific examples
4. **Common Pitfalls** — gotchas, silent failures, and surprising behaviors

Stay under 500 lines total. If the scope is too broad, split into focused sub-skills — one clear procedure per file.

## Calling vault_write_skill

```
vault_write_skill(
  name: "kebab-case-name",           // directory name — no myco: prefix here
  display_name: "Human-Readable Title",
  description: "triggering description",  // same text as frontmatter description
  content: "<full SKILL.md including frontmatter>",
  candidate_id: "uuid",              // optional: links to originating candidate
  source_ids: "id1,id2,id3",         // optional: comma-separated spore IDs
  rationale: "What changed and why"  // optional: written into skill lineage
)
```

The tool automatically:
- Writes the file to `.agents/skills/<name>/SKILL.md`
- Creates or updates the skill record in the vault database
- Bumps the generation counter
- Creates a lineage entry with the rationale

## Security Constraints

`vault_write_skill` enforces these structural gates before writing:

| Constraint | Details |
|---|---|
| Path traversal guard | Rejects names with `/`, `\`, or `..` before `path.resolve()` is called |
| Transaction atomicity | All DB mutations are wrapped in a single transaction — partial writes are impossible |
| Required fields | Rejects writes missing `name` (myco: prefix), `description`, `managed_by: myco`, `user-invocable`, or `allowed-tools` |
| allowed-tools values | Rejects vault_* names in `allowed-tools` (both string and YAML list formats) |
| 500-line limit | Rejects content over 500 lines |

## Common Pitfalls

### allowed-tools contamination from preserved frontmatter
When updating a skill by carrying forward its frontmatter (especially via "preserve all frontmatter" instructions), the `allowed-tools` field propagates whatever values are already there — including vault_* names if the source skill was contaminated. The preservation rule is not a validator: it faithfully copies errors. Always inspect `allowed-tools` before writing and replace any vault_* names with Claude Code tools.

### Missing required fields in rewrites
Mid-session rewrites often regenerate frontmatter from scratch and silently drop fields that were in the prior version. Always carry all six required fields forward explicitly, even if they appear unchanged. The quality gate enforces field presence but not value correctness — verify `allowed-tools` values manually.

### Shortened descriptions causing triggering failure
A rewrite that condenses the description for readability degrades future skill invocation. The description is a triggering signal, not prose for human readers — shorter means fewer matches. Only change the description if the trigger condition is factually incorrect.

### Path traversal in name
Skill names are used to construct file paths. Names containing `/`, `\`, or `..` are rejected before any filesystem operation. Use only alphanumeric characters and hyphens.
