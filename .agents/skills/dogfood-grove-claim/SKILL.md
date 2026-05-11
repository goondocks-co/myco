---
name: dogfood-grove-claim
description: Procedure for safely claiming a production Grove for local dogfooding of the dev binary. Use when testing changes against production-shaped Grove data without risking permanent mutations. Activate when the user says "claim", "dogfood against prod", "test against production", or "release a claimed Grove."
---

# Dogfood Grove Claim

Claim/release is a transaction with rollback. Claim takes a byte-for-byte
file-copy snapshot of the Grove `myco.db` and `vectors.db`, transfers
`served_by` from `service` to `service-dev`, and lets the dev daemon
serve the Grove. Release copies the snapshot files back over the live
Grove DB and hands `served_by` back to `service`. Any data the dev
daemon wrote during the claim window is discarded.

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
   the Grove (moves, vacuums). Claim pauses every project briefly so
   it can take the snapshot; a competing pause owner will surface a
   conflict.

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

The dev daemon now serves this Grove. Run `myco grove release prod-grove`
when you're done to restore the Grove to its pre-claim state.
```

The snapshot directory contains `grove-claim.db` and (if the source had
embeddings) `vectors-claim.db` — both byte-for-byte copies of the live
files.

Verify the dev daemon picked up the Grove:

- `myco grove list` reports `served_by=service-dev` for the claimed Grove.
- The dev daemon's `/api/groves` advertises the Grove.
- The production daemon stops serving it (cached projects time out on
  the next iteration).

## Dogfood loop

Inside the claim window, exercise:

- Capture flows (hooks, transcript ingestion, plan capture) against
  real project data.
- Agent runs that touch real sessions and spores.
- Grove `move`, `set-served-by`, settings changes — any path that
  mutates the Grove DB.
- Failure modes you'd never trigger on a fresh test Grove.

Treat all dev-side mutations as throwaway. They survive only until
release.

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

Archive directories older than 30 days are pruned automatically on
each release.

## Crash recovery

The claim manifest is the truth marker. Phases:

```
claim: claimed → flipped
release: claimed/flipped → restored → flipped → archived
```

- **Claim crashed before flipping `served_by`**: `served_by` is still
  `service`, manifest exists at `phase=claimed`. Re-run `myco grove
  claim <ref>` — it resumes from the manifest, takes the pause again,
  flips `served_by`, advances to `flipped`.
- **Claim crashed after flipping**: `served_by=service-dev`, manifest
  at `phase=flipped`. State is consistent. Run `myco grove release`
  when ready.
- **Release crashed mid-restore**: `served_by` still `service-dev`,
  manifest at `phase=claimed` or `flipped`. Re-run `myco grove release`
  — file copy is idempotent (overwrites the live DB with the snapshot
  again, no harm in repeating).
- **Release crashed after restore but before flip**: `phase=restored`.
  Re-run release; it picks up from the flip step.
- **Release crashed after flip but before archive**: `served_by=service`,
  `phase=flipped`. Re-run release; archive step completes.

If a claim is in an inconsistent state that re-running won't resolve
(e.g. the snapshot file is gone, or the manifest is corrupt), the
escape hatch is:

```
myco grove set-served-by <ref> <service|service-dev> --force
```

This is a hidden command. `--force` is required. It flips `served_by`
without touching the snapshot or the manifest. After running it,
delete the orphan claim directory by hand.

## Legacy manifests

Manifests are at **schema 2** (file-copy snapshots). Older `schema=1`
manifests on disk pointed at a `.sql` dump and used a line-based restore
parser that silently dropped any row with multi-line text content — they
are not supported by release. If you encounter a v1 manifest:

1. The release command surfaces a hard error citing the legacy manifest
   path.
2. Recover the affected Grove DB from your routine `~/myco_backups`
   dumps (the dump file is intact; only the previous restore code was
   lossy).
3. Then use `myco grove set-served-by <ref> service --force` to reset
   `served_by` manually.
4. Move the legacy claim directory aside or delete it.

## Reference

Architectural background:
[`docs/superpowers/specs/2026-05-10-portable-grove-identity-design.md`](../../../docs/superpowers/specs/2026-05-10-portable-grove-identity-design.md)

Snapshot mechanism: `packages/myco/src/grove/claim.ts` — `snapshotSqliteFile`
and `restoreSqliteFile` are the file-copy primitives.
