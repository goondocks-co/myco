# OKF

**Your project's knowledge, carried in the repo.** OKF (Open Knowledge Format) publishes a portable, human-readable copy of what Myco knows about your project into an `okf/` directory in your repository. Any agent or teammate can read it straight from the checkout — no Myco install required — and because it's plain markdown, every change shows up in a normal git diff.

Myco keeps the bundle current for you: it's generated from your vault's spores, your [Canopy](canopy.md) file knowledge, and the concepts your agents write, then refreshed on a schedule. OKF is a top-level opt-in capability and does **not** replace the local vault — the vault stays the source of truth; the bundle is a published snapshot you choose to carry alongside your code.

## What OKF is

A folder named `okf/` at the root of your repository, containing:

- **Spores** — the durable observations Myco has extracted from your sessions (gotchas, decisions, discoveries, trade-offs), written as one markdown file each.
- **Canopy knowledge** — the per-file anatomy and descriptions Canopy maintains, projected into readable concept notes.
- **Concepts** — editorial notes your agents (and you) write directly, the one part of the bundle that is hand-maintained rather than generated.
- **Guides** — short maintenance instructions that tell any agent how to keep the bundle current.
- **An index and a log** — a table of contents (`index.md`) and a running record of what each maintenance pass changed (`log.md`).

The bundle is designed to be read by anyone: a teammate reviewing a PR, a cloud agent with only repo access, or a future contributor who never installs Myco. It travels with the code because it lives in the code.

## What OKF is not

- **Not a vault backup.** The vault holds far more than the bundle — raw sessions, the knowledge graph, embeddings, history. OKF publishes a curated projection, not a restore point. Use `myco backup` to protect vault data.
- **Not a second source of truth.** When the vault and the bundle disagree, the vault wins. The bundle is a snapshot as of its last generation — it carries a generated-at timestamp precisely so you can tell how fresh it is.
- **Not a transcript export.** Sessions and their turn-by-turn history are deliberately left out. OKF carries curated knowledge, not episodic history.

## Enabling OKF

OKF is off by default. Nothing is generated, scheduled, or written to your repo until you turn it on for a project.

Enable it in either place:

- **The OKF page** in the dashboard — flip **Enable OKF**. This is the workflow home for everything below.
- **The Groves capability panel** — toggle the OKF row for a quick on/off, the same way you enable Canopy or skills.

When you enable OKF, three things follow:

1. **A discovery pointer is added to `AGENTS.md`.** A small managed block tells any agent that project knowledge lives in `okf/index.md`. Myco adds and removes this block for you — leave it alone; it's kept in sync automatically.
2. **Scheduled maintenance begins.** A background task regenerates the bundle when your knowledge changes (see [Keeping it current](#keeping-it-current)).
3. **The bundle appears at `okf/`.** The first maintenance pass writes the directory into your working tree.

**Review before you publish.** The `okf/` directory is repo-visible — it's meant to be committed. Before your first commit, open the diff and read what's there, the same as any generated artifact. Myco runs a publish-eligibility scan and will hold back a bundle that looks like it contains secrets or other content you probably didn't mean to publish; the OKF page shows you what was flagged so you can fix the source and regenerate. **Committing the bundle is always your call** — Myco writes it into your tree, but it never commits for you.

## What's inside

A generated bundle looks like this:

```
okf/
  index.md          Table of contents for the whole bundle
  log.md            What each maintenance pass added, changed, or removed
  spores/           One file per durable observation, plus an index
  canopy/           Projected per-file knowledge from Canopy, plus an index
  concepts/         Agent- and human-maintained editorial notes, plus an index
  guides/           Maintenance instructions for agents keeping the bundle current
```

Every file is markdown with a small YAML frontmatter header carrying its identity and type. A concept note, for example, reads like an ordinary doc with a few structured fields at the top:

```markdown
---
type: OKF Concept
title: Session capture flow
description: How a symbiont hook turns into a captured session.
myco_id: concepts/session-capture-flow
timestamp: 2026-07-05T00:00:00Z
---

Session capture starts when a symbiont hook fires...
```

You don't need to learn the format to use OKF — Myco generates and validates it. The shape matters when you or an agent hand-write a concept, which is covered next.

## Keeping it current

Once enabled, the bundle stays fresh on its own, and you can push it forward on demand.

- **Scheduled maintenance.** A background task checks whether your knowledge has changed since the last bundle — new spores, updated Canopy descriptions, edited concepts — and regenerates only when something is actually different. Quiet projects cost nothing; there's no churn when there's nothing new.
- **Maintain Now.** The **Maintain Now** button on the OKF page regenerates immediately. Use it after a burst of work when you want the bundle current before a commit.
- **Agents co-maintain concepts.** Connected coding agents keep the editorial `concepts/` current as they work. The generated parts — `spores/` and `canopy/` — are owned by their sources and are never hand-edited; agents only write concepts. An agent reaches for the richest tool it has:
  1. **Myco tools** — an agent connected over MCP uses the `myco_okf` tool to read the bundle and save concepts safely, with conflict detection.
  2. **CLI** — an agent without MCP runs `myco okf` commands to do the same.
  3. **Direct markdown** — as a last resort, an agent can write a well-formed concept file into `concepts/` by hand, following the guide in `guides/`.

Whichever tier an agent uses, writes to the same concept go through one lock and a generation check, so two agents editing at once can't silently clobber each other — a stale write is rejected, not overwritten.

## CLI reference

The `myco okf` commands cover the whole workflow from the terminal. Each is a thin, scriptable front door to the same capability the dashboard uses.

Check the current state of the bundle — whether it exists, when it was generated, and whether it's stale:

```bash
myco okf status
```

Regenerate the bundle from the current vault, Canopy, and concept state:

```bash
myco okf maintain
```

Preview what a maintenance pass would change without writing anything:

```bash
myco okf maintain --dry-run
```

Validate a published bundle against the OKF conformance rules:

```bash
myco okf validate
```

Save an editorial concept from a prepared markdown file (the `--id` must live under `concepts/`):

```bash
myco okf concept save --id concepts/my-note --input ./my-concept.md
```

List the published document pages, or read one back:

```bash
myco okf page list
myco okf page get concepts/my-note
```

Mark one concept as superseded by another, with a reason:

```bash
myco okf concept supersede concepts/old-note concepts/new-note --reason "merged into a clearer note"
```

Run `myco okf --help` for the full option set on any command.

## Privacy

Two directories carry OKF state, and only one of them is meant to be seen:

- **`okf/`** — the published bundle. Repo-visible by design; this is what you commit and share.
- **`.myco/okf/`** — private staging and cache used while a bundle is being built. Myco keeps this out of git for you; it's never part of what you publish.

When a bundle is generated, the publish-eligibility scan looks for content that shouldn't leave your machine — anything that reads like a secret or credential holds the bundle back rather than publishing it. What ends up in the bundle is curated project knowledge; raw session transcripts and vault internals are not projected into it. As with any generated artifact you commit, read the diff before you publish.

## Troubleshooting

- **Validation failed and I'm worried the bundle is broken.** A failed maintenance or validation pass leaves the previous good bundle in place — Myco stages a new bundle and only swaps it in once it's valid, so a failure never corrupts what you already published. Fix the flagged source and regenerate.
- **The OKF page says the bundle is stale.** Your knowledge has changed since the last generation. Click **Maintain Now**, or wait for the next scheduled pass.
- **An agent got a generation conflict.** Two writers touched concepts at once and the later write was based on an out-of-date bundle. The agent should re-read the current state and retry — the rejection is deliberate, protecting the other edit from being overwritten.
- **I disabled OKF — what happens to `okf/`?** Scheduled maintenance stops and the `AGENTS.md` pointer is removed. The existing `okf/` directory stays in your repo as a readable, frozen snapshot; nothing deletes it. Re-enable to resume maintaining it.
- **OKF won't turn on / isn't generating.** OKF is per-project and off by default — confirm it's enabled for the project you're in on the OKF page. A personal override can hold it off even when the project enables it; the OKF page's scope indicator shows when that's the case.

## Related

- [Canopy](canopy.md) — when both Canopy and OKF are enabled, Canopy's file knowledge is projected into the bundle's `canopy/` concepts.
- [Agent tools](agent-tools.md) — the `myco_okf` tool your connected agents use to read the bundle and maintain concepts.
- [Agent harness](agent-harness.md) — the `okf-maintain` task that keeps the bundle current in the background.
- [Grove management](groves.md) — where per-project capabilities like OKF are toggled.
