---
name: myco:write-myco-skill
description: |
  Use this skill whenever you need to create or update a Myco-managed SKILL.md file for
  this project. This covers the full procedure: choosing a name, drafting procedural content,
  calling vault_write_skill to atomically write and register the skill, and verifying it
  appears in Claude Code as a slash command. Activate even if the user says only "create a
  skill" or "write a skill" — this skill handles naming conventions, required frontmatter
  fields, the quality gate, and candidate auto-linkage, even if the user doesn't ask about
  those details explicitly.
managed_by: myco
version: 1
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Writing a Myco-Managed Skill

Skills in this project are procedural how-to guides that teach agents how to accomplish
specific tasks. They live in `.agents/skills/<name>/SKILL.md`, are validated and registered
by `vault_write_skill`, and become slash commands (e.g., `/myco:write-myco-skill`) in Claude
Code. Use this procedure any time you are creating a new skill or updating an existing one.

## Prerequisites

- The `vault_write_skill` MCP tool is available (provided by the Myco MCP server)
- You have a clear, specific topic for the skill — a procedural task, not a concept
- If generating from a candidate: have the `candidate_id` from `vault_skill_candidates`
- Relevant source material gathered: search `vault_search_semantic` or `vault_search_fts`
  for related spores before drafting so the skill reflects real project knowledge

## Steps

### 1. Choose a name and check for an existing skill

Pick a kebab-case name that describes the procedure (e.g., `add-symbiont`, `run-agent-task`).
Check whether one already exists before creating:

```bash
ls .agents/skills/
```

The directory name must be kebab-case with no slashes, backslashes, or `..` — the write gate
enforces path-traversal safety and will reject names containing those characters.

### 2. Draft the SKILL.md content

Skills must be **procedural how-to guides** ("how to X") — not definitions, gotcha catalogs,
or taxonomy documents. A skill that reads as a list of facts rather than a sequence of steps
won't trigger correctly in Claude Code.

**Required frontmatter fields** — the gate enforces all five; missing any returns a specific
validation error:

| Field | Required value |
|---|---|
| `name` | `myco:<name>` — the `myco:` namespace prefix is mandatory |
| `description` | Non-empty string; this is the primary trigger mechanism |
| `managed_by` | `myco` |
| `user-invocable` | `true` |
| `allowed-tools` | Comma-separated list, e.g., `Read, Edit, Write, Bash, Grep, Glob` |

Skeleton to start from:

```markdown
---
name: myco:<name>
description: |
  Triggering paragraph. Be explicit about when this activates. Name concrete keywords,
  file names, and scenarios. Include "even if the user doesn't explicitly ask..." language
  to counter undertriggering.
managed_by: myco
version: 1
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Skill Title

Context paragraph (2–3 sentences).

## Prerequisites

## Steps

## Common Pitfalls
```

**`allowed-tools` guidance:** most procedural skills need `Read, Edit, Write, Bash, Grep, Glob`.
Narrow to `Read, Grep, Glob` for read-only audit skills. The field is still required even
when narrowed.

**Hard limit: ≤500 lines total** (frontmatter + body). The gate rejects files over this limit.
Be concise — one numbered step per action, prose only where reasoning matters.

**The description is the trigger.** Write it so that an agent reading only the description
knows whether this skill applies. Include specific nouns: file names, tool names, scenarios.

### 3. Call `vault_write_skill`

```json
{
  "name": "my-skill-name",
  "display_name": "Human-Readable Title",
  "description": "One-sentence summary matching the frontmatter description intent",
  "content": "<full SKILL.md text including frontmatter>",
  "candidate_id": "<uuid — only when generating from an approved candidate>",
  "source_ids": "[\"spore-id-1\", \"spore-id-2\"]",
  "rationale": "Initial generation from candidate survey"
}
```

Pass `name` as the bare kebab-case directory name — **no `myco:` prefix here**. The prefix
belongs only in the frontmatter `name` field inside `content`. Passing `myco:my-skill-name`
as the `name` parameter will fail the path-safety gate.

The tool executes atomically in order: validate frontmatter → write file to disk → insert or
update DB record. Disk is written first; the DB row is only created after a confirmed disk
success — no orphaned DB records are possible. If validation fails, the tool returns a
specific list of errors to fix before retrying. The whole operation is safe to retry.

### 4. Verify the slash command in Claude Code

Claude Code reads skills from `.claude/skills/`, not `.agents/skills/`. A symlink between
the two is created by `SymbiontInstaller` during `myco init` / `myco update`. If the slash
command `/myco:<name>` doesn't appear in Claude Code after writing the skill:

```bash
myco update
```

Other agents (Cursor, Windsurf) read `.agents/skills/` directly — the symlink is only
needed for Claude Code.

### 5. Confirm candidate auto-linkage

When you pass `candidate_id`, `vault_write_skill` auto-searches for an `approved` candidate
whose topic matches the skill and transitions it to `generated`. Verify it worked:

```json
vault_skill_candidates({ "action": "get", "id": "<candidate-id>" })
```

`skill_id` should be set and `status` should be `"generated"`. If the topic string didn't
match closely enough for auto-detection, update the candidate manually:

```json
vault_skill_candidates({
  "action": "update",
  "id": "<candidate-id>",
  "status": "generated",
  "skill_id": "<uuid returned by vault_write_skill>"
})
```

## Common Pitfalls

**`myco:` prefix goes in frontmatter, not in the `name` parameter.** The `name` passed to
`vault_write_skill` is the directory name. The `myco:` prefix appears only in the SKILL.md
frontmatter field `name: myco:<name>`. This is the most common cause of a path-safety
rejection.

**Don't attempt to split disk and DB writes yourself.** `vault_write_skill` ensures disk
is written before the DB record is created. Replicating this manually (e.g., writing the
file via Bash then creating a DB row) bypasses the transaction guard and can leave the
vault in an inconsistent state.

**Updating an existing skill uses the same call.** Pass the same `name` — the tool detects
the existing file, overwrites it atomically, and increments the DB generation counter. No
delete-then-recreate is needed.

**Content type matters for triggering.** The gate doesn't enforce procedural style, but
skills written as reference docs ("X is a Y that does Z") won't activate reliably. Write
"how to" steps: "Run X, then Y, because Z" — not "X is the tool used for Z."

**Frontmatter uses hyphens, not underscores.** The gate checks `user-invocable` and
`allowed-tools` (hyphenated). Using `user_invokable` or `allowed_tools` will produce a
validation error even if the values are correct.
