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
import { TEAM_DELETE_TRIGGER_TABLES, TABLE_MIN_SYNC_PROTOCOL, tablesGatedByWorkerProtocol } from '@myco/db/schema-ddl.js';
// Relative import (not a tsconfig path alias) so the bun runner resolves the
// real worker module. We import from the dependency-free `synced-tables`
// module, NOT `index.ts`: index.ts transitively imports `agents/mcp` →
// `cloudflare:email`, which only resolves inside the Workers runtime and
// crashes a plain bun import.
import {
  SYNCED_TABLES as WORKER_SYNCED_TABLES,
  SYNCED_TABLE_SCOPE,
  MACHINE_SCOPED_TABLES,
  requiresGroveProjectId,
  stampSyncedAtAtIngestion,
} from '../../packages/myco-team/worker/src/synced-tables.ts';

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
 * Tables that are synced + backfilled + rebuilt but have NO delete trigger
 * because they are MACHINE-scoped (e.g. team_members). A machine-scoped table
 * has a single `id` (so it backfills/rebuilds fine) but no `project_id` column
 * → the standard `${table}_team_ad` trigger can't journal it (the trigger
 * captures `OLD.project_id`). The self-row isn't deleted in the normal flow,
 * so deletes are intentionally not propagated.
 *
 * Derived from SYNCED_TABLE_SCOPE so scope is declared in exactly one place;
 * this is a DISTINCT reason from NO_SINGLE_ID_TABLES (which is project-scoped
 * but lacks a single `id`). Do not conflate the two.
 *
 * Consequence: present in worker SYNCED + OBSERVED + REBUILD + BACKFILL,
 * ABSENT from DELETE_TRIGGER only.
 */
const NO_DELETE_TRIGGER_TABLES = new Set<string>(
  WORKER_SYNCED_TABLES.filter((t) => SYNCED_TABLE_SCOPE[t] === 'machine'),
);

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

describe('machine-scoped tables: project_id gate exemption', () => {
  it('exempts team_members (machine-scoped, no project_id) from the grove project_id gate', () => {
    expect(requiresGroveProjectId('team_members')).toBe(false);
  });

  it('still requires a grove project_id for project-scoped tables', () => {
    expect(requiresGroveProjectId('sessions')).toBe(true);
    expect(requiresGroveProjectId('spores')).toBe(true);
  });

  it('MACHINE_SCOPED_TABLES ⊆ worker SYNCED_TABLES (every machine-scoped table is actually synced)', () => {
    const machineScoped = new Set<string>(MACHINE_SCOPED_TABLES as readonly string[]);
    expect(minus(machineScoped, worker)).toEqual([]);
  });
});

describe('machine-scoped tables: synced_at stamped at ingestion', () => {
  it('stamps team_members synced_at at ingestion (machine-scoped, NULL over the wire)', () => {
    expect(stampSyncedAtAtIngestion('team_members')).toBe(true);
  });

  it('does not stamp project-scoped rows (keep their wire synced_at)', () => {
    expect(stampSyncedAtAtIngestion('sessions')).toBe(false);
    expect(stampSyncedAtAtIngestion('spores')).toBe(false);
  });

  it('stamps exactly the machine-scoped tables (derived from SYNCED_TABLE_SCOPE)', () => {
    for (const table of WORKER_SYNCED_TABLES) {
      expect(stampSyncedAtAtIngestion(table)).toBe(SYNCED_TABLE_SCOPE[table] === 'machine');
    }
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

  it('worker SYNCED − DELETE_TRIGGER is exactly the no-single-id + machine-scoped tables (e.g. entity_mentions, team_members)', () => {
    // Every synced table must have a delete trigger UNLESS it has no single
    // `id` (entity_mentions) or is machine-scoped so has no `project_id` for
    // the trigger to journal (team_members). A synced table missing here for
    // any OTHER reason = deletes silently stop mirroring.
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

describe('synced-table scope: derivation is wired to SYNCED_TABLE_SCOPE', () => {
  it('SYNCED_TABLE_SCOPE covers exactly SYNCED_TABLES (no table left unscoped)', () => {
    expect(new Set(Object.keys(SYNCED_TABLE_SCOPE))).toEqual(worker);
  });

  it('requiresGroveProjectId is false for machine-scoped, true for project-scoped', () => {
    expect(requiresGroveProjectId('team_members')).toBe(false);
    expect(requiresGroveProjectId('sessions')).toBe(true);
  });

  it('MACHINE_SCOPED_TABLES equals the scope map\'s machine entries', () => {
    const machineFromScope = WORKER_SYNCED_TABLES.filter(
      (t) => SYNCED_TABLE_SCOPE[t] === 'machine',
    );
    expect([...MACHINE_SCOPED_TABLES].sort()).toEqual([...machineFromScope].sort());
  });
});

describe('per-table sync-protocol floors (TABLE_MIN_SYNC_PROTOCOL)', () => {
  it('every table with a protocol floor is a real synced table (no typos)', () => {
    for (const table of Object.keys(TABLE_MIN_SYNC_PROTOCOL)) {
      expect(worker.has(table)).toBe(true);
    }
  });

  it('tablesGatedByWorkerProtocol gates protocol-3 tables against an older worker and nothing against a current or unprobed one', () => {
    const tables = ['sessions', 'spores', 'skill_lineage', 'okf_pages'];
    expect(tablesGatedByWorkerProtocol(tables, 2)).toEqual(['skill_lineage', 'okf_pages']);
    expect(tablesGatedByWorkerProtocol(tables, 3)).toEqual([]);
    expect(tablesGatedByWorkerProtocol(tables, undefined)).toEqual([]);
    expect(tablesGatedByWorkerProtocol(tables, null)).toEqual([]);
  });
});
