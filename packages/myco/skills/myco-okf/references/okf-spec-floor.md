# OKF 0.1 conformance floor

This is the write-time floor a page must satisfy to be a conformant OKF
document — not the full Open Knowledge Format spec, which lives upstream.
Source: the `okf/` subtree of
[GoogleCloudPlatform/knowledge-catalog](https://github.com/GoogleCloudPlatform/knowledge-catalog).
Read the upstream spec for anything not covered here; do not vendor it
wholesale into this repo.

Everything below is either a hard requirement (a conformant reader must be
able to parse and render the page) or a stated convention (deterministic,
so two independent maintainers converge on the same output). Producers MAY
add extra frontmatter keys beyond the floor; consumers MUST tolerate unknown
keys and unknown `type` values without failing.

## Frontmatter

Every non-reserved `.md` file opens with a `---`-delimited YAML frontmatter
block that parses as a mapping (not a scalar or a list).

**Required, non-empty:**

| Key | Constraint |
|---|---|
| `type` | Any non-empty string. Free-form — consumers must tolerate a `type` they don't recognize. Not an enum. |
| `title` | Non-empty string. |
| `description` | Non-empty string. |
| `timestamp` | Non-empty string. ISO 8601 (e.g. `'2026-07-10T00:00:00Z'`) is the convention; quote it so a YAML parser doesn't reinterpret it under its own timestamp-tag handling. |

A page missing any of these four, or whose frontmatter fails to parse as a
YAML mapping, is not conformant.

**Optional, common:**

| Key | Constraint |
|---|---|
| `resource` | A URI identifying what the page documents (e.g. `repo://packages/myco/src/skills/publication.ts`). Any scheme is legal; no enforced allowlist at the floor level. |
| `tags` | A YAML list of strings. |

**No `id` field.** A page's identity is its file path, not a frontmatter
value. Never write an `id`/`uuid`/`slug` key expecting it to be the page's
address — the path is the address. Moving or renaming a file is how you
change identity; do not try to preserve identity across a move via a
frontmatter key.

**Canonical key order** (for the six keys above, when present): `type` →
`resource` → `title` → `description` → `tags` → `timestamp`. Any additional
producer-added keys follow after, in whatever order the producer wrote them.
Consistent ordering isn't required for conformance, but keep it — it makes
diffs of hand-edited pages readable and matches the reference tooling's
output.

## File and directory naming

**Slugs** (file and directory segment names, minus the `.md` extension):
must match `[A-Za-z0-9_][A-Za-z0-9_.\-]*` — starts with an alphanumeric or
underscore, then any run of alphanumerics, underscores, dots, or hyphens.
No whitespace, no other punctuation, no leading `-` or `.`. Lowercase is the
convention (not enforced by the charset itself). When deriving a slug from a
title, drop diacritics, lowercase, and collapse any run of disallowed
characters to a single underscore.

**Reserved names:** `index.md` and `log.md`. Both are optional. Neither
carries frontmatter — a reserved file is plain markdown with no `---` block
at all. Never give a content page one of these two names; never put
frontmatter on one.

## Links

**Relative markdown links only.** `[label](../other-page.md)` — resolved
against the linking page's own directory. Absolute, `/`-rooted links
(`[label](/other-page.md)`) are banned: the wiki is a plain git-committed
markdown tree with no fixed serving root, so a `/`-rooted link resolves
against whatever happens to be mounted at `/` in the viewer (a filesystem
root, a different repo, nothing) rather than the wiki root. Relative links
are the only form that survives being viewed on GitHub, cloned to an
arbitrary path, or moved as a subtree.

External links (`https://…`, `mailto:…`, any other URI scheme) and same-page
anchors (`#section`) are unaffected by this rule — they're never wiki-internal
paths in the first place.

## Directory structure and indexes

Group pages by `type` (or another stable role signal) at the directory
level rather than flattening everything into one folder — e.g. `decisions/`,
`components/`, `howto/`, `gotchas/`. There's no fixed taxonomy at the floor
level; pick directory names that describe what's inside and stay consistent
within one wiki.

Every directory that contains at least one content page gets a generated
`index.md`. Regenerate it, don't hand-maintain it — the generator is
deterministic, so pages never drift out of sync with their index:

1. Group the directory's direct-child pages by their `type` frontmatter
   value (missing/empty `type` groups under `Other`).
2. Emit one `# <Type>` heading per group, headings sorted alphabetically by
   type name.
3. Within a group, list pages as bullets sorted by `title` (case-folded),
   each `* [Title](relative-link.md) - description` (omit the `- description`
   suffix when the page has no description).
4. If the directory has child directories that themselves contain pages, add
   a final `# Subdirectories` section listing each as
   `* [dirname](dirname/index.md) - <auto-summary>`, where the auto-summary
   is the single child's own description when the subdirectory holds exactly
   one page, `"N <type> pages"` for a subdirectory homogeneous in type, or
   `"N pages across M types"` otherwise.
5. Process directories deepest-first so a subdirectory's summary exists
   before its parent's index references it.

`index.md` itself carries no frontmatter, per the reserved-name rule above.

## Example page

```markdown
---
type: component
title: Capture Buffer
description: Buffers hook events on disk before the daemon ingests them.
tags:
  - capture
  - daemon
timestamp: '2026-07-10T00:00:00Z'
---

# Capture Buffer

The capture buffer sits between the hook process and the daemon HTTP API...

See [the daemon ingest path](../components/ingest.md) for what consumes
this buffer.
```

## Example generated index

```markdown
# Component

* [Capture Buffer](capture-buffer.md) - Buffers hook events on disk before the daemon ingests them.
* [Ingest Path](ingest.md) - Reads buffered batches into the vault.

# Subdirectories

* [decisions](decisions/index.md) - 3 decision pages.
```
