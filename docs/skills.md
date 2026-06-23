# Skills

**Memory is table stakes. Myco goes further.** It turns everything your team learns into [SKILL.md files](https://docs.anthropic.com/en/docs/claude-code/skills) — repeatable, evolving workflows that every agent follows. Not reference documentation, not hand-waved guidance: deployed procedures that drive consistency, quality, and excellence across every session.

Hand-written skills work well when you have clear conventions you want to codify. Auto-generated skills work differently: they emerge from what your team has actually done. When Myco's vault accumulates enough cross-session evidence about a procedure — debugging the build, adding a new API route, configuring a symbiont — the intelligence agent identifies it as a candidate, a human approves it, and a skill is generated from the source knowledge. Over time, skills evolve as the project's understanding changes.

The payoff: new teammates ship correctly on day one. Agents stop repeating the same mistakes. Your project's hard-won knowledge becomes the default path, enforced by tooling rather than buried in a wiki.

## The four stages

```
survey → approve → generate → evolve
(agent)   (human)   (agent)    (agent)
```

**Survey** — Myco scans the vault for recurring procedural topics. Spores, sessions, and plans that cluster around the same procedure become candidates. Cross-session evidence is required; one-off observations don't qualify.

**Approve** — Candidates appear in the Skills dashboard. You approve what becomes canon and dismiss the rest. Only approved candidates proceed to generation.

**Generate** — Myco writes a SKILL.md file from the approved candidate's source material. The skill is staged, validated against quality criteria (is it procedural? does it have concrete file paths? is it under 800 lines? does it conflict with existing skills?), and promoted to Myco's canonical skill store only when it passes — at which point every installed agent picks it up via its global skills symlink.

**Evolve** — Over time, Myco monitors active skills for drift. When new knowledge appears that should be incorporated, a skill's underlying spores get superseded, or a skill grows oversized and should be split, the evolve task rewrites it. Each rewrite bumps a generation number and records what changed.

## Skill format

Generated skills use the SKILL.md format with Myco-specific conventions:

```markdown
---
name: myco:deploy-worker
description: |
  Use this skill when deploying or updating the Cloudflare Worker,
  running wrangler commands, or troubleshooting deployment failures.
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

Cross-cutting gotchas.
```

Key conventions:

- **`name: myco:<kebab-case>`** — the `myco:` prefix identifies Myco-managed skills
- **`managed_by: myco`** — marks the skill as auto-managed; the evolve task only touches these
- **`user-invocable: true`** — makes the skill available as a slash command (e.g., `/deploy-worker`)
- **`allowed-tools`** — scopes which tools the agent can use when executing the skill

A validation gate enforces these conventions. Skills that fail validation are rejected and regenerated before they're accepted.

## How skills reach agents

Skills are written to Myco's canonical skill store and symlinked into each agent's native skills directory at the **global** install location — `~/.claude/skills/`, `~/.cursor/skills/`, `~/.codex/skills/`, `~/.copilot/skills/`, `~/.gemini/antigravity/skills/`, `~/.codeium/windsurf/skills/`, `~/.config/opencode/skills/`, and `~/.pi/agent/skills/`. Every project on your machine sees the same set of skills, kept in sync by Myco's symbiont layer — see [Supported Agents](symbionts.md) for the per-agent paths.

## Dashboard

The Skills page is accessible from the main navigation. It has two tabs:

**Skills** — Lists all generated skills with their current status, generation number, and last update time. Click a skill to see its full evolution timeline (what changed between generations and why).

**Candidates** — The review queue. Shows candidates discovered by the survey task, ordered by confidence. Approve or dismiss each one.

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

The generate and evolve tasks only run when there's work to do (approved candidates waiting, or active skills that might have drifted). They don't wake the daemon if there's nothing to process.

You can also trigger any skill task manually from the **Agent** page's **Run Task** dialog.

## Configuration

Two settings under `skills:` in `myco.yaml` control global behavior:

```yaml
skills:
  confidence_threshold: 0.7     # Minimum confidence for survey candidates
  usage_stale_days: 30          # Flag unused skills after this many days
```

Provider overrides work the same as any other agent task — see the [Intelligence Pipeline docs](agent-harness.md#configuring-providers).

## Lineage

Every change to a skill is recorded: what generation, what action (created, updated, retired), a rationale, a content snapshot, and the source IDs that informed the change. The lineage is visible on the skill detail page — you get a complete audit trail of how a skill evolved over time and why.
