---
type: Subsystem
title: OKF Publishing
description: The packages/myco/src/okf/ pipeline that derives, serializes, validates, and atomically publishes this very bundle — its path-traversal security fix, its approved deviations from the canonical OKF v0.1 spec, and the Phase 8.4 rule that synthesis must consume pre-computed vault intelligence instead of re-exploring the codebase.
timestamp: '2026-07-08T16:21:50.000Z'
---

## What this is

`packages/myco/src/okf/` is the module that produces the OKF bundle you are reading right now. It is Myco's implementation of the [Open Knowledge Format v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog) — a Google Cloud draft spec (published 2026-06-12) for a portable, human-browsable project wiki that any agent can read and maintain without Myco installed. The bundle lives in a repo-carried `okf/` directory (not `.myco/okf`, which is reserved for private staging/cache) so it is git-committed and visible to humans and other agents alike.

Two related pages cover the systems on either side of this one: [Vault Intelligence](/subsystems/vault-intelligence.md) is the substrate this module projects *from* (spores, digests, wisdom), and Myco's Own Agent Harness is the phased executor that runs the synthesis task producing this page's content.

## The core pipeline

The module is a set of small, single-purpose files sharing one concept model:

- **`paths.ts`** — derives bundle-relative filesystem paths from concept ids. A concept id is a POSIX path without the `.md` extension, built from segments matching the OKF slug charset (`[A-Za-z0-9_][A-Za-z0-9_.-]*`). `okfSlug()` turns arbitrary text (a title) into a valid segment: NFKD-decompose, strip diacritics, lowercase, collapse anything outside `[a-z0-9_.-]` to `_`.
- **`frontmatter.ts`** — typed parsing and serialization of the YAML frontmatter block, enforcing the required-key floor and stable key ordering.
- **`serialize.ts`** — renders `OkfConcept`/`OkfDocument` objects to markdown, plus the reserved root files (`index.md`, `log.md`). It escapes frontmatter-derived text at render time (`escapeInlineText`, `escapeLinkLabel`) wherever it flows into *generated* markdown (indexes, logs) — a concept's own frontmatter is stored data and is never rewritten, only text Myco re-renders into new markdown is neutralized.
- **`validate.ts`** — bundle validation across two rule families sharing one tree walk: `myco_strict` for the legacy pre-Phase-2 `OkfConcept` bundle path, and `conformance`/`strict` for the OKF v0.1 `OkfDocument` model this page's generation used. `conformance` mirrors the reference implementation's real write-time gate; `strict` is Myco's superset on top of it.
- **`links.ts`** — deterministically normalizes markdown cross-links in synthesized page bodies: converts bundle-relative paths to canonical absolute form, and downgrades a link to plain text if its target didn't end up published in this bundle. This is why a synthesis page (like this one) can link freely among planned pages without pre-verifying every target — `links.ts` reconciles it after the fact.
- **`output-root.ts`** — classifies where a bundle write is allowed to land (`resolveOutputRoot`), distinguishing the managed repo-carried root from other destinations such as one-shot/dry-run exports.
- **`projectors/`** — the Phase-1 layer that turned Myco's own data (spores, Canopy entries) into `OkfConcept` objects mechanically. Phase-1's spore→doc, canopy→doc, `type: Myco Spore` 1:1 projection was later judged to be "a data dump, not a wiki" and was superseded by agent-synthesized pages (the model this run itself uses) — but the projector plumbing (locking, atomic staging, crash recovery) was salvaged, not discarded.

## Flow: concept id to published bundle

A concept id enters at `assertSafeConceptId` (in `paths.ts`) — the single choke point every consumer (the `myco_okf` MCP tool, `/api/okf/concepts`, the CLI, and this synthesis run's `okf_write_page`) passes through before touching the filesystem. From there: `conceptPathForId` derives the on-disk path, `frontmatter.ts` parses/serializes the YAML block, `serialize.ts` renders the body (escaping only re-rendered text), `validate.ts` checks the result against the active rule family, and `links.ts` normalizes cross-links once every page in a run is staged. The whole bundle mutates through `OkfBundle`, which serializes writes on a per-output-root lock with `bundle_generation`/`expected_generation` conflict detection and publishes via atomic staging → rename, so a crash mid-write cannot leave `okf/` empty (recovery restores the newest `backup-*` before any stale-backup sweep runs).

## The path-traversal fix (bug_fix-919ea4ee)

A branch-wide adversarial review pass (5 reviewers, after every individual plan had already passed its own review) caught a CRITICAL that no per-plan review had: `conceptPathForId(id)` in `paths.ts` was originally `${id}.md` with **no validation** — traversal rejection existed only in the sibling `deriveConceptId` (used for machine-generated ids), not on the caller-supplied id path every consumer actually uses. That meant `getConcept('../../x')` could read any `.md` outside the bundle, and a crafted `saveConcept` id could write attacker-controlled content anywhere the daemon can write, reachable via the MCP tool, the HTTP API, and the CLI.

The fix was structural rather than a patch at each call site: a new exported `assertSafeConceptId(id)` was added *inside* `conceptPathForId` itself, so every derivation — read or write — is guarded at the one function every path flows through, and a future caller cannot reintroduce the hole by adding a new entry point. The generalized lesson from this fix: when a value flows to a filesystem path, validate at the single id→path function, not per-callsite — and audit any "sibling sanitizer only guards the generated path" seam for the caller-supplied path it doesn't cover. Regression coverage lives in `tests/okf/path-traversal-security.test.ts` and `tests/okf/bundle-review-fixes.test.ts`; the same review pass fixed seven other findings in the same commit (f15e6fbe on `feature/okf-phase1`), including a publish-eligibility acknowledgment-bypass (an ack keyed on `(code, path)` let a *different* secret at an already-acknowledged path ride the prior ack — fixed by binding acks to a content hash) and the crash-window backup-loss case described above.

## Approved deviations from the canonical OKF v0.1 spec

OKF v0.1 is deliberately minimal — the spec's own text has exactly two hard conformance rules: every non-reserved `.md` has parseable YAML frontmatter, and that block has a non-empty `type`. Everything else is convention, taken from the reference implementation (`reference_agent`) rather than the spec text itself. Myco's `validate.ts` documents this split directly: it distinguishes what the *spec* requires from what the *reference implementation* additionally enforces, and where Myco has deliberately gone further or differently. The confirmed deviations found in the intelligence base:

1. **Frontmatter four-key floor, not the spec's one-key minimum.** The reference validator (`reference_agent/bundle/document.py`) requires `type`, `title`, `description`, `timestamp` even though the published spec text only mandates `type`. Myco builds to the stricter four-key floor for practical compatibility with the reference tooling, while import/validation still tolerates a bundle that only satisfies the bare spec text.
2. **Absolute, not relative, cross-links.** The reference agent bans absolute `/…` links (they break on GitHub) and emits relative ones. Myco generates absolute bundle-relative links instead (root-anchored, e.g. `/architecture/overview.md`, via `bundleLink()` in `serialize.ts`/`paths.ts`), following the spec text's own §5.1 recommendation over the reference agent's actual behavior — reasoning: the published spec governs over reference-agent behavior, and absolute links are move-stable (relocating a page doesn't rewrite every link to it). `validate.ts` stays permissive on this axis: both link forms are accepted, and `strict` only warns `prefer_absolute_link` on a relative one — it never hard-fails either form, since rejecting either would reject an otherwise spec-conformant bundle.
3. **Relationship/citation links render into concept bodies; `OkfConcept.links` stays structurally empty for projector-emitted concepts.** `renderConcept` appends a `## Related` section for any non-empty links array, which would duplicate the spec-mandated `# Relationships`/`# Referenced Files` body sections — so link *reason* metadata (supersession, file_path, map_reference) is prose-only in the emitted bundle, not machine-readable.
4. **Published-mode privacy is structural, not a filter pass.** Projectors set `source.projectId = null` in published mode so rendering can't inject `myco_project`; machine/session/run ids are similarly excluded from the published surface and only exist in Myco's own local mode.

The full intelligence base does not enumerate a fixed count of approved deviations beyond these; treat this list as the confirmed subset rather than a closed inventory — the open question of a complete enumeration remains unresolved in the vault.

## Phase 8.4: synthesis must consume pre-computed intelligence, not re-explore

The rule this very run is following was learned the hard way. An earlier OKF synthesis dogfood run was built with only `vault_search_*` tools and no access to the digest, spores, or skill records that every sibling synthesis task (`cortex-instructions`, `cortex-prompt-builder`, `vault-evolve`, `digest-only`, `vault-seed`) already used. Given only that surface, the agent tried to rediscover the entire codebase file by file — 424 tool calls, 8.4M tokens, $12.11 — and still produced substantively empty content, because it never consulted the Canopy map or digests Myco had already computed.

The corrected model, adopted in Phase 8.4: the Canopy map is the guide (the reason it is built at all) — a synthesis agent starts there and goes targeted from it using semantic search, full-text search, and file tools, the way any coding agent explores a repo, rather than being handed one unbounded pre-reduced projection. Two further decisions came out of the same diagnosis: retiring the old "hand it a reduced projection" model (`okf_read_sources`'s prior `SOURCE_LIMIT=1_000_000` dumped the entire codebase — all Canopy entries, all spores, the full file tree — as a single blob that overflowed usable context), and adding `okf_read_spec` as a provider-agnostic harness tool that does a server-side fetch of the canonical spec, rather than vendoring a static copy (a maintenance liability that drifts) or relying on a provider-specific WebFetch surface. This page itself was produced by exactly this corrected loop: `okf_read_sources(kind: "map")` for orientation, `vault_search_canopy`/`vault_search_semantic`/`vault_spores` for targeted intelligence, and a bounded handful of `fs_read`/`code_grep` spot-verifications — not a full re-exploration.

See also [Vault Intelligence](/subsystems/vault-intelligence.md) for the digest/spore substrate this rule depends on, and Myco's Own Agent Harness for the phased executor (explore → plan → map/synthesize → publish) that enforces phase sequencing around this rule.

## Related pages

- [Myco: Overview](/overview.md) — the three-actor model and monorepo layout this subsystem sits within.
- [Vault Intelligence: Spores, Digest, Wisdom](/subsystems/vault-intelligence.md) — the source substrate OKF synthesis consumes.
- Myco's Own Agent Harness — the phase-loop that runs the synthesis producing this bundle.
- [Session Capture Flow](/architecture/session-capture-flow.md) — how the raw session data behind every spore this module projects from was captured in the first place.

# Citations

- `packages/myco/src/okf/paths.ts` — traversal-safe path derivation, `okfSlug`, `assertSafeConceptId`
- `packages/myco/src/okf/serialize.ts` — concept/reserved-file rendering, escaping rules
- `packages/myco/src/okf/validate.ts` — `myco_strict` vs `conformance`/`strict` rule families
- `packages/myco/src/okf/frontmatter.ts`, `packages/myco/src/okf/links.ts`, `packages/myco/src/okf/output-root.ts` (Canopy summaries)
- `bug_fix-919ea4ee` — branch-wide review pass, path-traversal fix and seven other findings
- `decision-0858961a` — absolute vs. relative link generation decision
- `decision-de220a72` — projector link/body rendering and published-mode privacy decisions
- `decision-58b07172` — grounded OKF v0.1 spec facts and the iteration-2 reframe
- `gotcha-9f0e7bba` — spec's one-key floor vs. reference validator's four-key practical floor
- `decision-185c1082` — OKF as an opt-in capability, source-of-truth split
- `id-hash-2f88012dc300c59e` (architecture) and `id-hash-309c77acc85648ad` (wisdom) — Phase 8.4 intelligence-consumption redesign
- `id-hash-ec1c997d6c2e658d` (wisdom) — Phase 1 bundle-location and review design decisions
