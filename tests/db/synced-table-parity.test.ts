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
  LOCAL_ONLY_SYNC_COLUMNS,
} from '@myco/db/queries/team-outbox.js';
import {
  TEAM_DELETE_TRIGGER_TABLES,
  TABLE_MIN_SYNC_PROTOCOL,
  tablesGatedByWorkerProtocol,
  SESSIONS_TABLE,
  PROMPT_BATCHES_TABLE,
  SPORES_TABLE,
  ENTITIES_TABLE,
  GRAPH_EDGES_TABLE,
  ENTITY_MENTIONS_TABLE,
  RESOLUTION_EVENTS_TABLE,
  PLANS_TABLE,
  ARTIFACTS_TABLE,
  DIGEST_EXTRACTS_TABLE,
  SKILL_CANDIDATES_TABLE,
  SKILL_RECORDS_TABLE,
  SKILL_LINEAGE_TABLE,
  SKILL_USAGE_TABLE,
  KNOWLEDGE_RELEASE_STATE_TABLE,
  TEAM_MEMBERS_TABLE,
  OKF_GENERATIONS_TABLE,
  OKF_PAGES_TABLE,
  OKF_PAGE_REVISIONS_TABLE,
} from '@myco/db/schema-ddl.js';
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
// `schema.ts` has no imports of its own (D1Database is an ambient type), so
// pulling the raw DDL strings in for column-level comparison doesn't drag
// the Workers runtime graph into the bun test process.
import {
  SESSIONS_TABLE as WORKER_SESSIONS_TABLE,
  PROMPT_BATCHES_TABLE as WORKER_PROMPT_BATCHES_TABLE,
  SPORES_TABLE as WORKER_SPORES_TABLE,
  ENTITIES_TABLE as WORKER_ENTITIES_TABLE,
  GRAPH_EDGES_TABLE as WORKER_GRAPH_EDGES_TABLE,
  ENTITY_MENTIONS_TABLE as WORKER_ENTITY_MENTIONS_TABLE,
  RESOLUTION_EVENTS_TABLE as WORKER_RESOLUTION_EVENTS_TABLE,
  PLANS_TABLE as WORKER_PLANS_TABLE,
  ARTIFACTS_TABLE as WORKER_ARTIFACTS_TABLE,
  DIGEST_EXTRACTS_TABLE as WORKER_DIGEST_EXTRACTS_TABLE,
  SKILL_CANDIDATES_TABLE as WORKER_SKILL_CANDIDATES_TABLE,
  SKILL_RECORDS_TABLE as WORKER_SKILL_RECORDS_TABLE,
  SKILL_LINEAGE_TABLE as WORKER_SKILL_LINEAGE_TABLE,
  SKILL_USAGE_TABLE as WORKER_SKILL_USAGE_TABLE,
  KNOWLEDGE_RELEASE_STATE_TABLE as WORKER_KNOWLEDGE_RELEASE_STATE_TABLE,
  TEAM_MEMBERS_TABLE as WORKER_TEAM_MEMBERS_TABLE,
  OKF_GENERATIONS_TABLE as WORKER_OKF_GENERATIONS_TABLE,
  OKF_PAGES_TABLE as WORKER_OKF_PAGES_TABLE,
  OKF_PAGE_REVISIONS_TABLE as WORKER_OKF_PAGE_REVISIONS_TABLE,
} from '../../packages/myco-team/worker/src/schema.ts';

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

// ---------------------------------------------------------------------------
// Column-level parity — the table-membership checks above only guard "is this
// table synced at all". A table can be a member of every list above and STILL
// break sync if a column is added to the local DDL without a matching worker
// DDL/ALTER — exactly what happened when thread_id/thread_label landed on
// prompt_batches (v71) without a worker-side counterpart: sanitizeSyncPayload
// only strips LOCAL_ONLY_SYNC_COLUMNS, so any other new column rides straight
// through into the worker's `INSERT OR REPLACE INTO ${table} (${keys})`
// (buildInsertParts in index.ts builds its column list from the payload, not
// an allowlist) and D1 throws "no such column" for every unsynced row.
// ---------------------------------------------------------------------------

/**
 * Extract column names from a `CREATE TABLE (...)` DDL string.
 *
 * Splits the parenthesized body on top-level commas (paren-depth aware, so
 * `REFERENCES sessions(id)` and `CHECK (...)` don't fracture a column
 * definition) and skips table-level constraints (PRIMARY KEY / UNIQUE /
 * FOREIGN KEY / CHECK / CONSTRAINT) that aren't columns. Quoted identifiers
 * (`"user"`) are unquoted so both schemas compare on the bare name.
 */
function extractColumnNames(ddl: string): Set<string> {
  const withoutComments = ddl.replace(/--[^\n]*/g, '');
  const openIndex = withoutComments.indexOf('(');
  let depth = 0;
  let closeIndex = -1;
  for (let i = openIndex; i < withoutComments.length; i++) {
    const ch = withoutComments[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }
  const body = withoutComments.slice(openIndex + 1, closeIndex);

  const parts: string[] = [];
  let partDepth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') partDepth++;
    if (ch === ')') partDepth--;
    if (ch === ',' && partDepth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);

  const tableConstraint = /^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i;
  const columns = new Set<string>();
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || tableConstraint.test(trimmed)) continue;
    const match = trimmed.match(/^"?([A-Za-z_][A-Za-z0-9_]*)"?/);
    if (match) columns.add(match[1]);
  }
  return columns;
}

/**
 * Columns that legitimately never reach D1 for reasons OTHER than
 * `LOCAL_ONLY_SYNC_COLUMNS`: `embedded` is stripped unconditionally by the
 * worker's `buildInsertParts` (`delete row.embedded`) regardless of table,
 * so no synced table needs it in its D1 DDL.
 */
const GLOBALLY_STRIPPED_COLUMNS = new Set<string>(['embedded']);

/** Local DDL string for every table in TEAM_SYNC_OBSERVED_TABLES. */
const LOCAL_DDL_BY_TABLE: Record<string, string> = {
  sessions: SESSIONS_TABLE,
  prompt_batches: PROMPT_BATCHES_TABLE,
  spores: SPORES_TABLE,
  entities: ENTITIES_TABLE,
  graph_edges: GRAPH_EDGES_TABLE,
  entity_mentions: ENTITY_MENTIONS_TABLE,
  resolution_events: RESOLUTION_EVENTS_TABLE,
  plans: PLANS_TABLE,
  artifacts: ARTIFACTS_TABLE,
  digest_extracts: DIGEST_EXTRACTS_TABLE,
  skill_candidates: SKILL_CANDIDATES_TABLE,
  skill_records: SKILL_RECORDS_TABLE,
  skill_lineage: SKILL_LINEAGE_TABLE,
  skill_usage: SKILL_USAGE_TABLE,
  knowledge_release_state: KNOWLEDGE_RELEASE_STATE_TABLE,
  team_members: TEAM_MEMBERS_TABLE,
  okf_generations: OKF_GENERATIONS_TABLE,
  okf_pages: OKF_PAGES_TABLE,
  okf_page_revisions: OKF_PAGE_REVISIONS_TABLE,
};

/** Worker D1 DDL string for the same table set. */
const WORKER_DDL_BY_TABLE: Record<string, string> = {
  sessions: WORKER_SESSIONS_TABLE,
  prompt_batches: WORKER_PROMPT_BATCHES_TABLE,
  spores: WORKER_SPORES_TABLE,
  entities: WORKER_ENTITIES_TABLE,
  graph_edges: WORKER_GRAPH_EDGES_TABLE,
  entity_mentions: WORKER_ENTITY_MENTIONS_TABLE,
  resolution_events: WORKER_RESOLUTION_EVENTS_TABLE,
  plans: WORKER_PLANS_TABLE,
  artifacts: WORKER_ARTIFACTS_TABLE,
  digest_extracts: WORKER_DIGEST_EXTRACTS_TABLE,
  skill_candidates: WORKER_SKILL_CANDIDATES_TABLE,
  skill_records: WORKER_SKILL_RECORDS_TABLE,
  skill_lineage: WORKER_SKILL_LINEAGE_TABLE,
  skill_usage: WORKER_SKILL_USAGE_TABLE,
  knowledge_release_state: WORKER_KNOWLEDGE_RELEASE_STATE_TABLE,
  team_members: WORKER_TEAM_MEMBERS_TABLE,
  okf_generations: WORKER_OKF_GENERATIONS_TABLE,
  okf_pages: WORKER_OKF_PAGES_TABLE,
  okf_page_revisions: WORKER_OKF_PAGE_REVISIONS_TABLE,
};

describe('synced-table parity: column-level (every local column reaches D1)', () => {
  it('LOCAL_DDL_BY_TABLE / WORKER_DDL_BY_TABLE cover exactly TEAM_SYNC_OBSERVED_TABLES (no table added to sync without wiring its DDL into this guard)', () => {
    expect(Object.keys(LOCAL_DDL_BY_TABLE).sort()).toEqual([...observed].sort());
    expect(Object.keys(WORKER_DDL_BY_TABLE).sort()).toEqual([...observed].sort());
  });

  for (const table of TEAM_SYNC_OBSERVED_TABLES) {
    it(`every local "${table}" column that reaches sanitizeSyncPayload exists on the worker D1 DDL`, () => {
      const localColumns = extractColumnNames(LOCAL_DDL_BY_TABLE[table]);
      const workerColumns = extractColumnNames(WORKER_DDL_BY_TABLE[table]);
      const strippedForThisTable = new Set<string>([
        ...GLOBALLY_STRIPPED_COLUMNS,
        ...(LOCAL_ONLY_SYNC_COLUMNS[table] ?? []),
      ]);

      const syncedLocalColumns = [...localColumns].filter((c) => !strippedForThisTable.has(c));
      const missingFromWorker = syncedLocalColumns.filter((c) => !workerColumns.has(c));

      expect(missingFromWorker).toEqual([]);
    });
  }
});
