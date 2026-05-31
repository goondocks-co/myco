/**
 * Cross-package + cross-list parity guard for the team-sync "what gets
 * pushed" table set.
 *
 * The synced-table membership is expressed as FIVE independently
 * hand-maintained lists across TWO packages:
 *
 *   1. worker  `SYNCED_TABLES`            — packages/myco-team/worker/src/synced-tables.ts
 *      The AUTHORITATIVE "what the worker accepts / pushes to D1" set.
 *   2. daemon  `TEAM_SYNC_OBSERVED_TABLES`— packages/myco/src/db/queries/team-outbox.ts
 *      What the daemon counts for drift / sync-summary. Must mirror the worker set.
 *   3. daemon  `REBUILD_TABLES`           — same file. Tables the operator rebuild re-pushes.
 *   4. daemon  `TEAM_SYNC_BACKFILL_TABLES`— same file. Tables the startup unsynced sweep scans.
 *   5. daemon  `TEAM_DELETE_TRIGGER_TABLES`— packages/myco/src/db/schema-ddl.ts
 *      Tables with an AFTER DELETE trigger that journals deletes into team_outbox.
 *
 * The risk this test exists to kill: a FORGOTTEN addition. Add a synced table
 * to the worker (or any daemon list) and miss one of the others, and deletes
 * silently stop mirroring, or rebuild/drift silently skips the table — with no
 * compile error and no runtime crash.
 *
 * Every difference between the lists is INTENTIONAL and documented. Each one is
 * encoded below as a named exclusion constant so that changing it later is a
 * conscious, reviewable edit — not silent drift. If someone adds a table to one
 * list without updating the others (or without adding it to the matching
 * exclusion), the relevant assertion fails and names the offending table.
 *
 * Imports the REAL constants from both packages (worker `SYNCED_TABLES` is
 * imported by relative path from a dependency-free module so the Workers
 * runtime graph isn't pulled in) — never a checked-in copy that could go stale.
 */
import { describe, it, expect } from 'bun:test';
import {
  TEAM_SYNC_OBSERVED_TABLES,
  TEAM_SYNC_BACKFILL_TABLES,
  REBUILD_TABLES,
} from '@myco/db/queries/team-outbox.js';
import { TEAM_DELETE_TRIGGER_TABLES } from '@myco/db/schema-ddl.js';
// Relative import (not a tsconfig path alias) so the bun runner resolves the
// real worker module. We import from the dependency-free `synced-tables`
// module, NOT `index.ts`: index.ts transitively imports `agents/mcp` →
// `cloudflare:email`, which only resolves inside the Workers runtime and
// crashes a plain bun import.
import { SYNCED_TABLES as WORKER_SYNCED_TABLES } from '../../packages/myco-team/worker/src/synced-tables.ts';

// ---------------------------------------------------------------------------
// Documented exclusions — each is a deliberate, reviewable difference.
// Editing any of these sets is a conscious decision, surfaced in code review.
// ---------------------------------------------------------------------------

/**
 * Tables that are synced (pushed to D1 + counted for drift) but have NO single
 * `id` column, so they cannot have a delete trigger (the trigger journals
 * `OLD.id`) and cannot be backfilled/rebuilt by `id` (backfillRows selects by
 * `id`). `entity_mentions` uses a composite key (entity_id, note_id,
 * note_type, agent_id).
 *
 * Consequence: present in worker SYNCED_TABLES + daemon OBSERVED, ABSENT from
 * REBUILD / BACKFILL / DELETE_TRIGGER.
 */
const NO_SINGLE_ID_TABLES = new Set<string>(['entity_mentions']);

/**
 * Tables synced + rebuilt but EXCLUDED from `TEAM_SYNC_BACKFILL_TABLES`
 * because they have no `synced_at` column. `backfillUnsynced` filters on
 * `synced_at IS NULL`, which would error on these. They still rebuild via the
 * 'all'-mode path (`1 = 1` predicate) so a rebuild produces an exact mirror.
 * `skill_usage` syncs eagerly via `syncRow` on insert instead.
 */
const NO_SYNCED_AT_TABLES = new Set<string>(['skill_usage']);

/**
 * Tables that are synced + backfilled + rebuilt but have NO delete trigger.
 * `team_members` has a single `id` (so it backfills/rebuilds fine) but no
 * `project_id` column → the standard `${table}_team_ad` trigger can't journal
 * it (the trigger captures `OLD.project_id`). It is machine-scoped and
 * self-only; its self-row isn't deleted in the normal flow, so deletes are
 * intentionally not propagated.
 *
 * Consequence: present in worker SYNCED + OBSERVED + REBUILD + BACKFILL,
 * ABSENT from DELETE_TRIGGER only.
 */
const NO_DELETE_TRIGGER_TABLES = new Set<string>(['team_members']);

// ---------------------------------------------------------------------------
// Set helpers
// ---------------------------------------------------------------------------

const observed = new Set<string>(TEAM_SYNC_OBSERVED_TABLES as readonly string[]);
const worker = new Set<string>(WORKER_SYNCED_TABLES as readonly string[]);
const backfill = new Set<string>(TEAM_SYNC_BACKFILL_TABLES as readonly string[]);
const rebuild = new Set<string>(REBUILD_TABLES as readonly string[]);
const triggers = new Set<string>(TEAM_DELETE_TRIGGER_TABLES as readonly string[]);

/** Members of `a` not in `b`. */
function minus(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x)).sort();
}

describe('synced-table parity: worker SYNCED_TABLES is the authoritative set', () => {
  it('the daemon OBSERVED set equals the worker SYNCED_TABLES exactly (no documented exclusions either way)', () => {
    // OBSERVED and worker SYNCED must be byte-for-byte the same membership:
    // both count/push the full synced set including entity_mentions.
    const observedMissingFromWorker = minus(observed, worker);
    const workerMissingFromObserved = minus(worker, observed);

    expect({
      // Tables the daemon observes that the worker would reject → drift counts
      // a table that can never sync.
      inDaemonObservedButNotWorkerSynced: observedMissingFromWorker,
      // Tables the worker accepts that the daemon never counts → silent drift
      // blind spot.
      inWorkerSyncedButNotDaemonObserved: workerMissingFromObserved,
    }).toEqual({
      inDaemonObservedButNotWorkerSynced: [],
      inWorkerSyncedButNotDaemonObserved: [],
    });
  });

  it('has no duplicate entries in any list', () => {
    expect(observed.size).toBe(TEAM_SYNC_OBSERVED_TABLES.length);
    expect(worker.size).toBe(WORKER_SYNCED_TABLES.length);
    expect(backfill.size).toBe(TEAM_SYNC_BACKFILL_TABLES.length);
    expect(rebuild.size).toBe(REBUILD_TABLES.length);
    expect(triggers.size).toBe(TEAM_DELETE_TRIGGER_TABLES.length);
  });
});

describe('synced-table parity: daemon subset relationships', () => {
  it('REBUILD_TABLES ⊆ worker SYNCED_TABLES (rebuild never re-pushes a non-synced table)', () => {
    expect(minus(rebuild, worker)).toEqual([]);
  });

  it('TEAM_SYNC_BACKFILL_TABLES ⊆ REBUILD_TABLES (backfill is a subset of rebuild)', () => {
    expect(minus(backfill, rebuild)).toEqual([]);
  });

  it('TEAM_DELETE_TRIGGER_TABLES ⊆ worker SYNCED_TABLES (no trigger for a non-synced table)', () => {
    expect(minus(triggers, worker)).toEqual([]);
  });
});

describe('synced-table parity: documented exclusions are the ONLY differences', () => {
  it('OBSERVED − REBUILD is exactly the no-single-id tables (e.g. entity_mentions)', () => {
    // A synced table missing from REBUILD must be there because it has no
    // single `id`. Any OTHER table here means someone added a synced table
    // and forgot to add it to REBUILD_TABLES.
    const observedNotRebuilt = minus(observed, rebuild);
    const unexpected = observedNotRebuilt.filter((t) => !NO_SINGLE_ID_TABLES.has(t));
    expect({
      observedButNotInRebuild: observedNotRebuilt,
      unexpectedMissingFromRebuild: unexpected,
    }).toEqual({
      observedButNotInRebuild: [...NO_SINGLE_ID_TABLES].sort(),
      unexpectedMissingFromRebuild: [],
    });
  });

  it('REBUILD − BACKFILL is exactly the no-synced_at tables (e.g. skill_usage)', () => {
    const rebuiltNotBackfilled = minus(rebuild, backfill);
    const unexpected = rebuiltNotBackfilled.filter((t) => !NO_SYNCED_AT_TABLES.has(t));
    expect({
      rebuildButNotInBackfill: rebuiltNotBackfilled,
      unexpectedMissingFromBackfill: unexpected,
    }).toEqual({
      rebuildButNotInBackfill: [...NO_SYNCED_AT_TABLES].sort(),
      unexpectedMissingFromBackfill: [],
    });
  });

  it('worker SYNCED − DELETE_TRIGGER is exactly the no-single-id + no-project_id tables (e.g. entity_mentions, team_members)', () => {
    // Every synced table must have a delete trigger UNLESS it has no single
    // `id` (entity_mentions) or no `project_id` for the trigger to journal
    // (team_members). A synced table missing here for any OTHER reason =
    // deletes silently stop mirroring.
    const expectedNoTrigger = new Set<string>([...NO_SINGLE_ID_TABLES, ...NO_DELETE_TRIGGER_TABLES]);
    const syncedWithoutTrigger = minus(worker, triggers);
    const unexpected = syncedWithoutTrigger.filter((t) => !expectedNoTrigger.has(t));
    expect({
      syncedButNoDeleteTrigger: syncedWithoutTrigger,
      unexpectedMissingTrigger: unexpected,
    }).toEqual({
      syncedButNoDeleteTrigger: [...expectedNoTrigger].sort(),
      unexpectedMissingTrigger: [],
    });
  });
});
