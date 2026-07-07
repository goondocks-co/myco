# OKF

**Your project's knowledge, as a wiki you can read without Myco.** OKF (Open Knowledge Format) is a small set of topic pages — guides, decisions, gotchas, and more — written in an open, documented format and published into an `okf/` directory in your repository. Any agent or teammate can open it straight from the checkout, with no Myco install required, and because every page is plain markdown, changes show up in a normal git diff.

Myco is the engine that keeps the wiki synthesized and fresh — it is not the wiki's data model. The pages themselves are self-contained: readable, linkable, and editable by any agent that understands markdown, whether or not Myco is anywhere nearby. OKF is a top-level opt-in capability and does **not** replace the local vault — the vault stays Myco's source of truth; the wiki is a published, portable view you choose to carry alongside your code.

## What the wiki is

A folder named `okf/` at the root of your repository, containing:

- **A handful of topic pages.** Myco reads your project — the code, its git history, and everything else Myco has learned about it — and synthesizes a small, curated set of pages rather than dumping raw data. A page might be a guide, a decision record, a gotcha, or an overview; new pages appear as your project accumulates knowledge worth writing down.
- **Hand-authored pages under `concepts/`.** This is the one part of the wiki you or your agents write directly, rather than Myco generating it.
- **An index at every level.** Each folder has its own `index.md` — a plain list of the pages inside it, organized by kind, with links down into subfolders. The top-level `index.md` is the front door; start there and follow the links.
- **A log.** `log.md` is a running record of what each refresh added, changed, or removed.

Content pages follow the OKF v0.1 format — plain markdown with a small YAML header up top; the per-folder `index.md` files and `log.md` are plain headerless markdown. Nothing about reading or navigating it requires Myco — an agent with no Myco connection at all can open `index.md`, follow its links, and understand the project.

## What OKF is not

- **Not a vault backup.** The vault holds far more than the wiki — raw sessions, embeddings, history. OKF publishes a curated set of pages, not a restore point. Use `myco backup` to protect vault data.
- **Not a second source of truth.** When the vault and the wiki disagree, the vault wins. The wiki is a snapshot as of its last refresh — every page carries a timestamp so you can tell how current it is.
- **Not a transcript export.** Sessions and their turn-by-turn history are deliberately left out. OKF carries synthesized knowledge, not episodic history.

## Browsing the wiki

The **OKF page** in the dashboard is a knowledge browser: pages are grouped by kind, and selecting one opens it rendered, right there. Links inside a page — to another page in the wiki — resolve in place, so you can follow a trail through the whole wiki without leaving the browser or triggering a page reload.

You don't need the dashboard to read it, though. The wiki is designed to be opened directly: in your editor, in a PR diff, or by any agent working from the repo. Start at `okf/index.md` and follow its links the same way you would in the browser.

## Enabling OKF

OKF is off by default. Nothing is generated, scheduled, or written to your repo until you turn it on for a project.

Enable it in either place:

- **Settings**, under the OKF section (`/settings#okf`) — flip **Enable OKF**. This is also where you can change the output path and turn the AGENTS.md pointer off.
- **The project capability panel** on the Groves page — toggle the OKF row for a quick on/off, the same way you enable Canopy or skills.

When you enable OKF, three things follow:

1. **A discovery pointer is added to `AGENTS.md`.** A small managed block tells any agent that project knowledge lives at `okf/index.md`. Myco adds and removes this block for you — leave it alone; it's kept in sync automatically.
2. **Scheduled refreshes begin.** A background pass keeps the wiki current as your project changes (see [Keeping it fresh](#keeping-it-fresh)).
3. **The wiki appears at `okf/`.** The first refresh writes the directory into your working tree.

**Review before you publish.** The `okf/` directory is repo-visible — it's meant to be committed. Before your first commit, open the diff and read what's there, the same as any generated artifact. Myco runs a publish-eligibility scan and will hold back a page that looks like it contains secrets or other content you probably didn't mean to publish; the OKF page shows you what was flagged so you can fix the source and refresh again. **Committing the wiki is always your call** — Myco writes it into your tree, but it never commits for you.

## Keeping it fresh

Once enabled, the wiki stays current on its own, and you can push it forward on demand from the Maintain & validate controls on the OKF page.

- **Scheduled refreshes.** A background pass checks whether your project has meaningfully changed since the wiki was last synthesized and refreshes only when something is actually different. Quiet projects cost nothing — there's no churn when there's nothing new to say.
- **Maintain Now.** Click **Maintain Now** on the OKF page to refresh immediately. Use it after a burst of work when you want the wiki current before a commit.
- **Validate.** Click **Validate** to check the published wiki against the OKF conformance rules without changing anything.

If a refresh is blocked because something in it looks like it shouldn't be published, the OKF page shows exactly what was flagged and offers **Acknowledge & publish** to override it once you've confirmed it's fine.

## Agents can maintain it without Myco

Because OKF is an open, documented format, any agent can read and extend the wiki on its own:

1. **No Myco needed.** The wiki is plain markdown with a documented frontmatter shape. An agent with only repo access can open `okf/index.md`, follow its links to browse the whole wiki, and — for hand-authored pages under `concepts/` — write a new one directly, matching the shape it sees in existing pages. The `AGENTS.md` pointer Myco adds to your repo tells a connected agent to start there.
2. **Myco tools, when available.** An agent connected over MCP uses the `myco_okf` tool to read pages and save or supersede hand-authored ones safely, with conflict detection built in.
3. **The CLI, as an alternative.** An agent without MCP access runs `myco okf` commands to do the same from the terminal.

Whichever way a page under `concepts/` gets written, writes go through one lock and a generation check, so two agents editing at once can't silently clobber each other — a stale write is rejected, not overwritten. The rest of the wiki — everything outside `concepts/` — is synthesized by Myco and refreshed automatically; treat those pages as Myco's territory and let the next refresh update them rather than hand-editing.

## CLI reference

The `myco okf` commands cover the whole workflow from the terminal. Each is a thin, scriptable front door to the same capability the dashboard uses.

Check the current state of the wiki — whether it exists, when it was last refreshed, and whether it's stale:

```bash
myco okf status
```

Validate the published wiki against the OKF conformance rules:

```bash
myco okf validate
```

Save a hand-authored page from a prepared markdown file (the `--id` must live under `concepts/`):

```bash
myco okf concept save --id concepts/my-note --input ./my-concept.md
```

List the published pages, or read one back:

```bash
myco okf page list
myco okf page get concepts/my-note
```

Mark one hand-authored page as superseded by another, with a reason:

```bash
myco okf concept supersede concepts/old-note concepts/new-note --reason "merged into a clearer note"
```

Run `myco okf --help` for the full option set on any command.

## Privacy

Two directories carry OKF state, and only one of them is meant to be seen:

- **`okf/`** — the published wiki. Repo-visible by design; this is what you commit and share.
- **`.myco/okf/`** — private staging used while a refresh is in progress. Myco keeps this out of git for you; it's never part of what you publish.

When the wiki is refreshed, the publish-eligibility scan looks for content that shouldn't leave your machine — anything that reads like a secret or credential holds that page back rather than publishing it. Raw session transcripts and vault internals are never projected into the wiki; what ends up there is synthesized prose. As with any generated artifact you commit, read the diff before you publish.

## Troubleshooting

- **Validation failed and I'm worried the wiki is broken.** A failed refresh or validation pass leaves the previous good wiki in place — Myco stages the new version and only swaps it in once it's valid, so a failure never corrupts what you already published. Fix the flagged source and refresh again.
- **The OKF page says the wiki is stale.** Your project has changed since the last refresh. Click **Maintain Now**, or wait for the next scheduled pass.
- **An agent got a generation conflict.** Two writers touched the same hand-authored page at once and the later write was based on an out-of-date version. The agent should re-read the current page and retry — the rejection is deliberate, protecting the other edit from being overwritten.
- **I disabled OKF — what happens to `okf/`?** Scheduled refreshes stop and the `AGENTS.md` pointer is removed. The existing `okf/` directory stays in your repo as a readable, frozen snapshot; nothing deletes it. Re-enable to resume maintaining it.
- **OKF won't turn on / isn't refreshing.** OKF is per-project and off by default — confirm it's enabled for the project you're in on the OKF page. A personal override set from the project capability panel can hold it off even when the project enables it; the OKF page's scope indicator shows when that's the case.

## Related

- [Canopy](canopy.md) — one of the sources OKF draws on when it synthesizes pages; Canopy runs on its own and doesn't require OKF.
- [Agent tools](agent-tools.md) — the `myco_okf` tool your connected agents use to browse the wiki and maintain hand-authored pages.
- [Agent harness](agent-harness.md) — the background work that keeps project knowledge, including OKF, fresh.
- [Grove management](groves.md) — where per-project capabilities like OKF are toggled.
