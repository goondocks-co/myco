---
name: myco-okf
description: >-
  Create or maintain an OKF-conformant project wiki — a portable,
  git-committed markdown knowledge base that lives in the repo, not the
  vault. Use when asked to create a wiki, build or generate a project wiki,
  document this codebase as a wiki, maintain/update/sync the wiki with the
  code, or when the request mentions OKF, "Open Knowledge Format", or
  knowledge catalog. Also use when asked to turn Myco's captured
  intelligence (Canopy map, digest, spores, sessions, skills) into
  human-readable documentation that ships with the repo. Any symbiont can
  run this procedure — it needs no daemon machinery beyond the ordinary
  Myco tools.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
user-invocable: true
---

# Myco OKF — Project Wiki Synthesis

Synthesize or maintain a project wiki that any OKF-conformant reader can
render: plain markdown files with YAML frontmatter, committed to the repo,
grouped into directories with generated `index.md` files. No database, no
daemon feature, no bundle machinery — the wiki is the artifact. This skill
is the entire mechanism.

Full conformance rules: `references/okf-spec-floor.md`. Read it before
writing your first page — the frontmatter shape, key order, slug charset,
link rules, and index format below all cite it.

## The core lesson: never a source dump

The single biggest failure mode for a synthesis agent handed "document this
repo" is producing empty or generic content — because it either dumps raw
file contents into pages verbatim, or mechanically walks the file tree
top-to-bottom without ever asking what's worth documenting. Both produce a
wiki nobody would read.

The fix: **start from Myco's pre-computed intelligence, not from the source
tree.** The vault already holds the reasoning, decisions, and gotchas that
took real sessions to work out — that's higher-signal than anything you can
re-derive by re-reading source cold, and it's already written in prose. Use
it as your outline; use the source tree to verify and fill gaps, not as your
starting point.

## Procedure

### 1. Establish the wiki root

Pinned convention:

- If an OKF-conformant directory already exists in the repo (a directory
  whose `.md` files mostly carry valid frontmatter per the floor doc, an
  `index.md` in the reserved no-frontmatter form, or a name like `okf/`),
  **adopt it** — write and update pages there. Don't create a second wiki
  root next to an existing one.
- If no such directory exists, **create `okf/` at the repo root** (the
  default a Myco-generated wiki has always used).
- If you find **multiple plausible candidates** (e.g. an `okf/` AND a
  `wiki/` that both look conformant), **stop and ask the user** which one is
  the real wiki root. Don't guess and don't merge them silently.

To check a candidate directory: sample a few of its `.md` files (skip
`index.md`/`log.md`) and confirm they open with `---` frontmatter carrying a
non-empty `type`. If most do, it's the wiki.

### 2. Pull vault intelligence first

Before touching the source tree, gather what Myco already knows, in this
order:

1. **Canopy map** — `myco_cortex({"op":"canopy_map"})`. This is the
   structural map of the repo: what exists, at what path, at what altitude.
   It replaces "list every file" — use it to decide what deserves a wiki
   page, not to read the whole tree.
2. **Digest** — `myco_cortex({"op":"digest","tier":5000})` (go to `10000`
   only if you have budget and the wiki needs deep historical grounding).
   This is pre-synthesized project narrative: why things are built the way
   they are. It is the closest thing to a first draft of your "decisions"
   and "architecture" pages.
3. **Targeted search** — `myco_search({"query": "<component or topic>"})`
   for each area the Canopy map or digest surfaced as wiki-worthy. Follow
   each result's `retrieve` hint to pull the full record (`myco_spores`,
   `myco_sessions`, `myco_plans`, `myco_skills`).
4. **Spores directly** — `myco_spores({"op":"list", ...})` for durable
   gotchas and decisions the search pass didn't surface by keyword.
5. **Skills** — `myco_skills({"op":"list"})`. An existing skill is often
   itself the best source for a "howto" wiki page — it's already a
   procedure, just not in OKF form.

Write down, before you open a single source file, the list of pages you
intend to produce or update and why each one earns a page. If you can't
justify a page from what step 2 surfaced, it's probably not worth writing
yet.

### 3. Explore the repo targeted, like a coding agent

Now open source files — but only the ones step 2 pointed at, and only to
verify or fill a specific gap (confirm a function signature, check whether a
described behavior is still current, find the file path a spore referenced
but didn't quote). This is the same navigation discipline you'd use fixing
a bug: follow a lead to a file, read what's relevant, move on. It is not a
second pass over the whole tree.

If step 2 came up thin for an area you know is important (a first run
against a project with little vault history yet), it's fine to explore more
broadly there — but keep it scoped to that area, and prefer writing a
shorter, honest page over padding with restated code.

### 4. Write or update pages

Each page: YAML frontmatter satisfying the floor (`type`, `title`,
`description`, `timestamp` all non-empty; canonical key order; see the
reference doc), then a body written in your own words. Cite what grounds a
claim (a file path, a spore, a decision) rather than quoting large blocks of
source or tool output verbatim — a page that's 90% pasted JSON or a raw file
dump is the failure mode this skill exists to avoid.

`type` is a free string — pick values that describe the page's role and
stay consistent within one wiki. Reasonable starting set: `overview`,
`component`, `decision`, `howto`, `gotcha`, `reference`. Not enforced, not
exhaustive — use what fits the project.

Updating an existing page: read it first, preserve what's still accurate,
correct what's drifted, and don't rewrite frontmatter you don't need to
change (in particular, don't touch `timestamp` unless the page's content is
actually changing).

Links between pages are relative markdown links, resolved against the
linking page's directory (`[Ingest Path](../components/ingest.md)`).
Absolute `/`-rooted links are not conformant here — see the reference doc
for why.

### 5. Regenerate `index.md` for every directory you touched

For each directory with at least one content page (new or pre-existing),
regenerate its `index.md` following the exact algorithm in
`references/okf-spec-floor.md` — grouped by `type`, sorted headings, bullets
sorted by title, a `Subdirectories` section when applicable, no frontmatter.
Regenerate deterministically from the current page set; don't hand-edit an
index incrementally, or it will drift from what the pages actually say.

### 6. Scan before advising a commit

Run the bundled scanner against the whole wiki root — not just the pages you
touched — before telling the user their wiki is ready to commit. Scanning
the full tree is a strict superset of scanning just the diff, and it's the
only way to catch a finding in a page you didn't edit this run:

```bash
node scripts/scan-content.mjs <wiki-root>
```

Run it from this skill's own directory — a project checkout of this repo has
it at `packages/myco/skills/myco-okf/scripts/scan-content.mjs`; a linked
install has it at `.agents/skills/myco-okf/scripts/scan-content.mjs` or, for
a global skill, `~/.myco/skills/myco-okf/scripts/scan-content.mjs`. Locate
whichever of these exists on this host and invoke it with a path (absolute
or relative) to the wiki root as the sole argument.

It flags four finding classes: secrets (API keys, tokens, private-key
headers), absolute local filesystem paths, raw session/machine identifiers
(UUIDs, `session_id:` / `prompt_batch_id:` / `machine_id:` keys), and
`resource: repo://…` frontmatter references to sensitive-looking repo files
(`.env` and `.env.*`, `.npmrc`/`.pypirc`/`.netrc`/`.dockercfg`, SSH private
keys like `id_rsa`/`*_ed25519`, and `.key`/`.pem`/`.p12`/`.pfx` files) —
defense-in-depth against a spore or session excerpt that happened to carry
one of these, or a page whose `resource` points at a credential file. Exit
code 0 means clean. Exit code 1 means findings were printed to stderr, each
with a masked excerpt and a stable hash — resolve each one (redact the
offending text) before proceeding. Exit code 2 means the invocation itself
was wrong (missing argument, or the target isn't a directory) — fix the
command and re-run; it says nothing about the content. Do not silently
ignore a finding; if you believe it's a false positive, say so explicitly
to the user rather than dropping it.

**If `node`/`Bash` isn't available on this host**, fall back to manually
checking each new or changed page against this checklist before advising a
commit:

- No string matching an AWS access key (`AKIA` + 16 alnum chars), a GitHub
  token (`gh[pousr]_...`), a Slack token (`xox[baprs]-...`), a Google API key
  (`AIza...`), a `-----BEGIN ... PRIVATE KEY-----` block, or a bare
  `bearer <token>`.
- No absolute local path (`/Users/...`, `/home/...`, `/root/...`, or a
  Windows `C:\Users\...` form).
- No raw `session_id:`/`prompt_batch_id:`/`machine_id:` value, and no bare
  UUID that looks like one of those identifiers.
- No `resource: repo://…` frontmatter value pointing at a sensitive repo
  file: `.env` or `.env.*`, `.npmrc`, `.pypirc`, `.netrc`, `.dockercfg`, an
  SSH private key (`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, or any
  `*_rsa`/`*_dsa`/`*_ecdsa`/`*_ed25519` name), or a `.key`/`.pem`/`.p12`/
  `.pfx` file.

### 7. Hand back to the user

Summarize what you wrote or changed (pages added/updated, indexes
regenerated) and the scan result. Do not commit automatically — leave the
diff for the user's normal review-and-commit flow; this skill produces
files on disk, not a git action.

## Self-check before finishing

Walk this list against your actual output before reporting done:

- [ ] Wiki root: adopted an existing conformant directory, or created
      `okf/`, or asked the user when candidates were ambiguous — never
      silently created a second root.
- [ ] Every non-reserved `.md` you touched has parseable frontmatter with
      non-empty `type`, `title`, `description`, `timestamp`, in canonical
      key order.
- [ ] No `id` frontmatter key anywhere — identity is the file path.
- [ ] Every new file/directory segment matches the slug charset.
- [ ] Every internal link is relative; no `/`-rooted links.
- [ ] `index.md`/`log.md` (where present) carry no frontmatter.
- [ ] `index.md` regenerated for every touched directory, grouped by type,
      sorted per the reference doc's algorithm.
- [ ] The scan script (or its checklist fallback) ran clean, or every
      finding was resolved or explicitly called out to the user.

## References

- `references/okf-spec-floor.md` — the OKF 0.1 conformance floor this
  skill targets: frontmatter shape, key order, slug charset, link rules,
  reserved names, index generation algorithm, worked examples.
- `scripts/scan-content.mjs` — standalone, zero-dependency pre-commit
  content scanner (step 6).
