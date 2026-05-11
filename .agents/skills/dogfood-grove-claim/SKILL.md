---
name: dogfood-grove-claim
description: Procedure for safely claiming a production Grove for local dogfooding of the dev binary. Use when testing changes against production-shaped Grove data without risking permanent mutations. Activate when the user says "claim", "dogfood against prod", "test against production", or "release a claimed Grove."
---

# Dogfood Grove Claim

Claim/release is a transaction with rollback. Claim takes a byte-for-byte
file-copy snapshot of the Grove `myco.db` and `vectors.db`, plus a
recursive snapshot of the global Groves registry (`~/.myco/groves/*`)
and every registered project's vault manifests
(`<root>/.myco/project.toml`, `project.local.toml`). It transfers
`served_by` from `service` to `service-dev` and lets the dev daemon
serve the Grove.

Release reverses everything: the claimed Grove's DB is copied back, any
Grove created during the claim window is deleted (`deleteGrove --force`),
project moves are reverted by restoring the registry files, project
vault manifests are restored from snapshot, and the cross-Grove
`registry.yaml` (`default_grove_id` pointer) is restored. Any data the
dev daemon wrote during the claim window is discarded.

Vectors round-trip alongside the main DB — no re-embed is needed on
release.

## Pre-flight checks

Before running `myco grove claim`:

1. The CLI you invoke must be the **dev binary** (the build pinned to
   `service-dev`). The command refuses to run if `isDevServiceMode()`
   returns false.
2. The target Grove must currently be `served_by = service`. Verify
   with `myco grove list` — the dev daemon won't claim its own Grove
   and won't claim a Grove already in someone else's claim window.
3. No in-flight long-running work should be active on any project in
   the Grove (moves, vacuums). Claim pauses every project in the
   claimed Grove briefly so it can take the snapshot. Release pauses
   every project in **every** Grove for the registry-restore window.

## Claim procedure

```
myco grove claim <name|id>
```

Successful output:

```
Grove claimed for dogfooding:
  Grove:    Production Grove (prod-grove)
  Snapshot: ~/myco_backups/claims/prod-grove/<ts>/grove-claim.db
  Projects: 3 paused → resumed under dev ownership
  Snapshot total size: 312MB (claimed Grove DB 128MB, vectors 26MB, registry 1.2MB, project manifests 4KB)

The dev daemon now serves this Grove. Run `myco grove release prod-grove`
when you're done to restore the Grove to its pre-claim state.
Release will also undo any new Groves, project moves, and project
manifest edits made during the claim window.
```

The snapshot directory contains:

- `grove-claim.db` — byte-for-byte copy of the claimed Grove's `myco.db`.
- `vectors-claim.db` — byte-for-byte copy of `vectors.db` (omitted if
  the source had no vectors file).
- `registry-snapshot/` — recursive copy of `~/.myco/groves/` containing
  every Grove's `grove.toml`, `grove.yaml`, `registry/projects.toml`,
  `registry/roots.toml`, plus the top-level cross-Grove
  `registry.yaml`. DB files for non-claimed Groves are **not** in the
  snapshot.
- `project-manifests/<project_id>/` — `project.toml` and
  `project.local.toml` for every registered project at claim time.

The one-line `Snapshot total size:` summary shows what's being held on
disk so the user can decide whether to clean up older claim archives.

## Disk-space caveat

Snapshot disk usage scales with the claimed Grove's DB + vectors size,
plus a fraction of a megabyte for registry/manifest metadata. On a
machine with a 100MB+ Grove DB, the snapshot directory is roughly the
same size. Archives are pruned after 30 days.

## Dogfood loop

Inside the claim window, exercise:

- Capture flows (hooks, transcript ingestion, plan capture) against
  real project data.
- Agent runs that touch real sessions and spores.
- Grove `move`, `create`, `delete`, `set-served-by`, settings changes —
  any path that mutates the Grove DB or the global registry.
- Failure modes you'd never trigger on a fresh test Grove.

Treat all dev-side mutations as throwaway. They survive only until
release.

### What release rolls back

- **New Groves created during the claim**: deleted (`deleteGrove --force`,
  taking the Grove's entire DB with them).
- **Projects moved between Groves**: registry rows restored, vault
  manifests repointed back to the original Grove. The project's data
  is in the claimed Grove's DB (restored from snapshot).
- **Project vault manifest edits**: every snapshotted `project.toml`
  and `project.local.toml` is copied back to its vault.
- **`default_grove_id` pointer**: restored from the snapshot
  `registry.yaml`.

### What release does NOT roll back

Non-claimed Groves' **databases** are not snapshotted (only their
registry metadata is). If during the claim window you move a project
**from another Grove into the claimed Grove**, the source Grove's DB
keeps the duplicate copy of the moved data — restoring registry files
makes the registry consistent with pre-claim, but the rows in the
non-claimed Grove's DB remain. For the primary dogfood flow (claim a
Grove → maybe create a new one → move projects into the new one →
release), this never matters because the new Grove is deleted and its
DB along with it.

If you need a fully transactional rollback that includes other Groves'
DBs, this is a known scope cut. See open issue notes in the source.

## Release procedure

```
myco grove release <name|id>
```

Successful output:

```
Grove released:
  Grove:    Production Grove (prod-grove)
  Restored: ~/myco_backups/claims/prod-grove/<ts>/grove-claim.db
  Archive:  ~/myco_backups/claims/prod-grove/archive/<ts>/
  served_by → service
```

Verify the Grove is back:

- `myco grove list` reports `served_by=service`.
- The production daemon picks the Grove back up.
- Data the dev daemon added during the claim window is gone.
- Data the dev daemon deleted during the claim window is back.
- Any Grove created during the claim window is gone.
- Any project moved during the claim window is back in its original
  Grove with its vault manifest repointed.

Archive directories older than 30 days are pruned automatically on
each release.

## Crash recovery

The claim manifest is the truth marker. Phases:

```
claim: claimed → flipped
release: claimed/flipped → restored → registry-restored → flipped → archived
```

- **Claim crashed before flipping `served_by`**: `served_by` is still
  `service`, manifest exists at `phase=claimed`. Re-run `myco grove
  claim <ref>` — it resumes from the manifest, takes the pause again,
  flips `served_by`, advances to `flipped`.
- **Claim crashed after flipping**: `served_by=service-dev`, manifest
  at `phase=flipped`. State is consistent. Run `myco grove release`
  when ready.
- **Release crashed mid-DB-restore**: `served_by` still `service-dev`,
  manifest at `phase=claimed` or `flipped`. Re-run `myco grove release`
  — file copy is idempotent.
- **Release crashed after DB restore, before registry restore**:
  `phase=restored`. Re-run release; it picks up from the registry step.
- **Release crashed after registry restore, before flip**:
  `phase=registry-restored`. Re-run release; it picks up from the flip
  step.
- **Release crashed after flip but before archive**: `served_by=service`,
  `phase=flipped`. Re-run release; archive step completes.

If a claim is in an inconsistent state that re-running won't resolve
(e.g. the snapshot files are gone, or the manifest is corrupt), the
escape hatch is:

```
myco grove set-served-by <ref> <service|service-dev> --force
```

This is a hidden command. `--force` is required. It flips `served_by`
without touching the snapshot or the manifest. After running it,
delete the orphan claim directory by hand.

## Legacy manifests

Manifests are at **schema 3** (file-copy snapshots + registry +
project manifests). Older manifests on disk are rejected by release
with a clear error:

- `schema=1` was a SQL-dump snapshot whose line-based restore parser
  silently truncated multi-line text rows.
- `schema=2` was a file-copy snapshot of the claimed Grove's DB only,
  with no registry or project-manifest snapshot. A schema-2 release
  cannot undo a Grove create or project move that landed during the
  claim window.

If you encounter a v1 or v2 manifest:

1. The release command surfaces a hard error citing the legacy schema.
2. For v1: recover the affected Grove DB from your routine
   `~/myco_backups` dumps.
3. For v2: copy `snapshot_db_path` back over the live Grove DB by hand.
4. Then use `myco grove set-served-by <ref> service --force` to reset
   `served_by` manually.
5. Move the legacy claim directory aside or delete it.

## Reference

Architectural background:
[`docs/superpowers/specs/2026-05-10-portable-grove-identity-design.md`](../../../docs/superpowers/specs/2026-05-10-portable-grove-identity-design.md)

Snapshot mechanism: `packages/myco/src/grove/claim.ts` —
`snapshotSqliteFile` and `restoreSqliteFile` are the file-copy
primitives; `copyRegistryTree`, `snapshotProjectManifests`, and
`restoreRegistryState` implement the transactional rollback.
