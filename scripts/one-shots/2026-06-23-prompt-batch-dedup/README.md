# One-shot: collapse historical prompt_batch duplicates (2026-06-23)

**This is a POINT-IN-TIME CLEANUP SCRIPT, not reusable tooling.**

It collapses byte-identical `prompt_batches` duplicates left behind by re-mine
overlap. The duplication is prevented going forward by the `content_hash` UNIQUE
guard in `packages/myco/src/db/queries/batches.ts`; this script only cleans up
rows written before that guard was active.

It is hardcoded to the original developer machine (`user=chris`) and refuses to
run anywhere else. Do not modify the guard to "generalize" it.

## What it does

For every Grove DB under `~/.myco/groves/*` and `~/.myco-dev/groves/*` (or a
single `--db <path>`):

1. Groups batches by `(session_id, origin, normalize(user_prompt))` where
   `normalize` is JS `.trim()` of the **full** prompt — the SAME normalization
   the going-forward `content_hash` guard uses. The collapse is keyed on this,
   **not** on `content_hash`: the positional hash deliberately makes
   byte-identical bug-dups *distinct*, so it cannot be the collapse key.
2. Keeps the earliest row in each group (`MIN(id)`) as canonical.
3. Lifts a `response_summary` that only a duplicate carries onto the canonical.
4. **Repoints every child reference** (`activities`, `plans`, `attachments`,
   `spores`, `knowledge_git_provenance`, `knowledge_release_state`, and the
   self-referential `parent_prompt_batch_id`) from the duplicate to the
   canonical row — no child row is ever deleted.
5. Deletes the duplicate batches.

## Safeguards

- **Dry-run by default.** Runs inside a transaction that is `ROLLBACK`'d unless
  `--apply` is passed. Always run the dry-run first and read the per-DB counts.
- **Pre/post assertions** (abort + rollback on any mismatch): exactly the
  duplicate rows are removed; every child table's row count is unchanged
  (repointed, not lost); no dangling `parent_prompt_batch_id` remains.
- **`PRAGMA foreign_keys = ON`** so an un-repointed reference aborts the DELETE
  loudly instead of orphaning a row. The repoint list covers every column with a
  declared `REFERENCES prompt_batches(id)` FK; this safety net only catches
  declared FKs, so a child column storing a `prompt_batch_id` without a FK would
  be missed.
- **Team-delete trigger suppression.** The per-row `*_team_ad` triggers
  (`TEAM_DELETE_TRIGGERS` in `schema-ddl.ts`) would enqueue one `team_outbox`
  `delete` per collapsed row on a sync-enabled member project. The script flips
  `team_sync_state.enabled` to 0 inside the transaction (the trigger re-reads it
  per row) and restores it before commit; on crash the whole transaction rolls
  back, so the flag never sticks at 0. Consequence: D1 is left with the
  pre-cleanup duplicate topology — it is not reconciled. Survivor `content_hash`
  is intentionally **not** backfilled (the partial index protects new writes).

## Accepted limitation

On byte-identical historical data this **cannot** distinguish a bug-dup from a
genuine repeated prompt — exactly as the original manual dogfood drain could
not. Collapsing a genuine byte-identical repeat is accepted. Going forward,
genuine repeats are preserved because they get distinct positional ordinals.

## Run

```bash
bun scripts/one-shots/2026-06-23-prompt-batch-dedup/collapse.mjs          # dry-run, all groves
bun scripts/one-shots/2026-06-23-prompt-batch-dedup/collapse.mjs --apply  # COMMIT
```

Kept in-tree as evidence of the cleanup, not as a runtime utility.
