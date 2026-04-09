# Skills

**Memory is table stakes. Myco goes further.** It turns everything your team learns into [SKILL.md files](https://docs.anthropic.com/en/docs/claude-code/skills) — repeatable, evolving workflows that every agent follows. Not reference documentation, not hand-waved guidance: deployed procedures that drive consistency, quality, and excellence across every session.

Hand-written skills work well for teams with clear conventions they want to codify. Auto-generated skills work differently: they emerge from what the team has actually done. When Myco's vault accumulates enough cross-session evidence about a procedure — debugging the build, adding a new API route, configuring a symbiont — the agent identifies it as a candidate, a human approves it, and a skill is generated from the source knowledge. Over time, skills evolve as the project's understanding changes.

The payoff: new teammates ship correctly on day one. Agents stop repeating the same mistakes. Your project's hard-won knowledge becomes the default path, enforced by tooling rather than buried in a wiki. Skills reflect how work is actually done, not how someone imagined it would be done — and they stay current because the same intelligence pipeline that created them monitors for drift.

## How it works

The skill lifecycle has four stages: survey, approve, generate, evolve.

```
survey → approve → generate → evolve
(agent)   (human)   (agent)    (agent)
```

### 1. Survey

The `skill-survey` task discovers procedural candidates by exploring the vault in parallel. Three exploration phases run simultaneously:

| Phase | What it explores | Signal |
|-------|-----------------|--------|
| **explore-spores** | Wisdom spores, decisions, discoveries, gotchas, entities | High-mention-count entities indicate areas that need skills |
| **explore-sessions** | Session titles, summaries, recurring themes | 3+ sessions touching the same component is a strong candidate signal |
| **explore-plans** | Plans, artifacts, step-by-step procedures | Plans are often the most directly skill-ready content |

An **evaluate** phase runs after all three complete. It filters findings to procedural topics ("how to do X", not "what is X"), requires cross-session evidence (2+ sessions, 3+ source items), scores confidence (0.0-1.0), and creates candidates in the vault.

Candidates already in the vault are updated with new evidence rather than duplicated. Candidates whose underlying knowledge has been superseded are automatically dismissed.

### 2. Approve

Candidates appear in the Skills dashboard under the **Candidates** tab. Each candidate shows:

- **Topic** — the procedure this skill would teach
- **Confidence** — score based on knowledge density, cross-session evidence, presence of wisdom spores and plans
- **Rationale** — the agent's markdown-formatted analysis of the evidence
- **Source count** — number of spores, sessions, and plans supporting the candidate

You approve or dismiss each candidate. Only approved candidates proceed to generation.

### 3. Generate

The `skill-generate` task processes one approved candidate per run. It operates in three phases:

**Gather** — Reads all source material referenced by the candidate (spores, sessions, plans), searches for additional context via semantic and keyword search, and extracts concrete steps, file paths, gotchas, and rationale.

**Draft** — Writes a SKILL.md file from the gathered material. The skill follows a strict format (see [Skill format](#skill-format) below) and is written to a staging area (`.myco/staging/skills/`) via the `vault_stage_skill` tool. At this point the skill is not yet visible to any agent — staging isolates it while quality gates run.

**Validate** — Reviews the staged skill against quality criteria:

1. Triggering clarity (would an agent know when to use it?)
2. Procedural content (steps to take, not definitions)
3. Concreteness (real file paths and function names)
4. Length (under 500 lines)
5. Conflicts with existing skills
6. Accuracy (spot-checks claims against the vault)

If validation fails, the skill is rewritten. The validate phase can rewrite multiple times until criteria pass. Once validation succeeds, `vault_finalize_skill` atomically promotes the staged content to `.agents/skills/`, creates the database record, and records a lineage entry. A failed promotion rolls back the staging artifact — there are no half-finished skills left on disk.

### 4. Evolve

The `skill-evolve` task monitors active skills for knowledge drift. It runs in two phases:

**Assess** — For each active skill, reads the current content, searches for new knowledge since the last update, checks whether source spores have been superseded, and evaluates scope. Each skill is classified:

| Classification | Meaning |
|---------------|---------|
| **CURRENT** | Content is still accurate, no significant new knowledge |
| **STALE** | New knowledge should be incorporated (new gotchas, changed file paths, new patterns) |
| **CONFLICTED** | New knowledge directly contradicts the skill (decision reversed, pattern abandoned) |
| **OVERSIZED** | Covers too many distinct procedures — candidate for splitting |

**Evolve** — Rewrites STALE and CONFLICTED skills, preserving accurate content and incorporating new knowledge. OVERSIZED skills are split into focused sub-skills, and the parent is retired. Each rewrite bumps the skill's generation number and records a lineage entry with a rationale explaining what changed.

## Skill format

Generated skills use the SKILL.md format with Myco-specific conventions:

```markdown
---
name: myco:deploy-worker
description: |
  Use this skill when deploying or updating the Cloudflare Worker,
  running wrangler commands, or troubleshooting deployment failures.
  Activates even if the user doesn't explicitly mention deployment.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Deploy Worker

Brief context paragraph explaining what this procedure accomplishes.

## Prerequisites

What must be true before starting.

## Steps

Numbered, concrete steps with file paths and code examples.

## Common Pitfalls

Cross-cutting gotchas (inline with steps where possible).
```

Key conventions:

- **`name: myco:<kebab-case>`** — The `myco:` prefix identifies Myco-managed skills. The directory name omits the prefix (e.g., `.agents/skills/deploy-worker/SKILL.md`).
- **`managed_by: myco`** — Marks the skill as auto-managed. The evolve task only touches skills with this field.
- **`user-invocable: true`** — Makes the skill available as a slash command (e.g., `/deploy-worker`).
- **`allowed-tools`** — Scopes which tools the agent can use when executing this skill.

A validation gate enforces these conventions. Skills that fail validation (missing frontmatter fields, missing `myco:` prefix, over 500 lines) are rejected and the agent must fix them before they're accepted.

## How skills reach agents

Skills are written to `.agents/skills/<name>/SKILL.md` — the emerging cross-agent standard directory. The `SymbiontInstaller` creates symlinks from each agent's native skills directory to the canonical location:

```
.agents/skills/deploy-worker/SKILL.md          (canonical)
  ↑ symlinked from:
.claude/skills/deploy-worker/SKILL.md           (Claude Code)
.cursor/skills/deploy-worker/SKILL.md           (Cursor)
```

Agents that use `.agents/skills/` natively (Codex, VS Code Copilot, Gemini CLI, Windsurf) need no symlinks. Run `myco init` or `myco update` to refresh symlinks after new skills are generated.

## Dashboard

The Skills page is accessible from the main navigation. It has two tabs:

**Skills** — Lists all generated skills with their current status, generation number, and last update time. Click a skill to see its full evolution timeline (lineage entries with rationale for each generation).

**Candidates** — The review queue. Shows candidates discovered by the survey task, ordered by confidence score. Each candidate can be approved (moves to generation queue) or dismissed (removed from the queue).

## Scheduling

All three skill tasks ship with scheduling disabled by default. Enable them from the Agent > Tasks configuration in the dashboard, or in `myco.yaml`:

```yaml
agent:
  tasks:
    skill-survey:
      schedule:
        enabled: true
        intervalSeconds: 600    # 10 minutes
    skill-generate:
      schedule:
        enabled: true
        intervalSeconds: 600
    skill-evolve:
      schedule:
        enabled: true
        intervalSeconds: 900    # 15 minutes
```

Each task has a **pre-condition** that prevents unnecessary runs:

| Task | Pre-condition | Runs when |
|------|--------------|-----------|
| `skill-survey` | _(none)_ | On schedule, during `idle` power state |
| `skill-generate` | `has-approved-candidates` | At least one approved candidate exists |
| `skill-evolve` | `has-active-skills` | At least one active Myco-managed skill exists |

Tasks only run during the `idle` power state — they won't compete with active coding sessions. The daemon checks pre-conditions before each scheduled run and skips the task if conditions aren't met.

You can also trigger any task manually from the dashboard's Agent page.

## Configuration

The `skills` section in `myco.yaml` controls global skill behavior:

```yaml
skills:
  confidence_threshold: 0.7     # Minimum confidence for survey candidates (0.0-1.0)
  usage_stale_days: 30          # Flag unused skills after this many days
```

| Key | Default | Description |
|-----|---------|-------------|
| `confidence_threshold` | `0.7` | Candidates below this score are still created but may warrant closer review |
| `usage_stale_days` | `30` | Days of inactivity before a skill is flagged for review by the evolve task |

Per-task scheduling is configured under `agent.tasks.<task-name>.schedule` as shown above. Provider overrides work the same as any other agent task — see the [Agent Harness docs](agent-harness.md#provider-configuration) for the full precedence hierarchy.

## Lineage

Every write to a skill — creation, update, split — is recorded in the lineage table with:

- **Generation number** — monotonically increasing version counter
- **Action** — `created`, `updated`, or `retired`
- **Rationale** — human-readable explanation of what changed
- **Content snapshot** — full SKILL.md at that generation
- **Source IDs added** — spores, sessions, and plans that informed this generation

The lineage is visible on the skill detail page in the dashboard, providing a complete audit trail of how a skill evolved over time.
