/**
 * Residency detach-pull enumeration (Phase F T3) — the HOST-side paging that hands
 * a detaching member back its own rows.
 *
 * D-F-4: a detach returns the CALLER machine's contributions for one project — its
 * rows across the residency set (machine_id = caller AND project_id = project) —
 * PLUS `content_publications` for the project's artifacts regardless of machine (the
 * member needs current published-generation truth). Rows the host itself derived
 * (its own machine_id) are never in the machine-scoped set, so they are excluded by
 * construction.
 *
 * Pages are deterministic and resumable: a fixed FK-topological table order, a stable
 * within-table key order, and an opaque host-authoritative cursor `{ table, key }`
 * (the last row emitted). Re-requesting a page yields the identical rows — the member
 * re-pulls on a lost ack and re-applies idempotently. The member applies each page's
 * rows with the shared engine (`db/queries/residency-apply.ts`), so rows are shipped
 * `sanitizeSyncPayload`-consistent with the ingest path.
 */
import type { Database } from '@myco/db/client.js';
import { sanitizeSyncPayload } from '@myco/db/queries/team-outbox.js';

/** Default rows per page and byte budget — both comfortably under the 8MB
 *  per-request cap even after the JSON envelope. Whichever is hit first ends the page. */
export const RESIDENCY_PULL_PAGE_ROWS = 500;
export const RESIDENCY_PULL_PAGE_BYTES = 4_000_000;

/** One row on a pull page, tagged with the table the member applies it to. */
export interface ResidencyPullRow {
  table: string;
  row: Record<string, unknown>;
}

/** One page of the pull stream. `done` is true on the final (possibly short) page;
 *  `nextCursor` is null once done. */
export interface ResidencyPullPage {
  rows: ResidencyPullRow[];
  nextCursor: string | null;
  done: boolean;
}

/**
 * A pull-eligible table: its stable `orderCols` (both the ORDER BY and the cursor
 * key) and the base predicate that scopes it. Machine-scoped tables filter on
 * `(project_id, machine_id)`; `content_publications` has no `project_id`, so it is
 * scoped through the owning artifact rows and is NOT machine-filtered.
 */
interface PullTable {
  name: string;
  orderCols: string[];
  baseWhere(projectId: string, machineId: string): { sql: string; params: unknown[] };
}

function machineScoped(name: string, orderCols: string[]): PullTable {
  return {
    name,
    orderCols,
    baseWhere: (projectId, machineId) => ({
      sql: 'project_id = ? AND machine_id = ?',
      params: [projectId, machineId],
    }),
  };
}

/** Artifact ids that belong to a project across the two publishable artifact tables
 *  — `content_publications` carries no `project_id`, so scope comes from the owner. */
const PROJECT_ARTIFACT_IDS_SQL = `
  SELECT id FROM skill_records WHERE project_id = ?
  UNION
  SELECT id FROM okf_pages WHERE project_id = ?`;

/**
 * The FK-topological table order the pull walks: every child TABLE follows its
 * parent, so a member applying pages in order never references an unapplied parent
 * (the same order the attach send uses). `team_members` is excluded (machine-scoped
 * roster, no `project_id`). `content_publications` is last and all-machine.
 */
const RESIDENCY_PULL_TABLES: readonly PullTable[] = [
  machineScoped('sessions', ['id']),
  machineScoped('prompt_batches', ['id']),
  machineScoped('spores', ['id']),
  machineScoped('entities', ['id']),
  machineScoped('graph_edges', ['id']),
  machineScoped('resolution_events', ['id']),
  machineScoped('plans', ['id']),
  machineScoped('artifacts', ['id']),
  machineScoped('digest_extracts', ['id']),
  machineScoped('skill_candidates', ['id']),
  machineScoped('skill_records', ['id']),
  machineScoped('skill_lineage', ['id']),
  machineScoped('knowledge_release_state', ['id']),
  machineScoped('okf_generations', ['id']),
  machineScoped('okf_pages', ['id']),
  machineScoped('okf_page_revisions', ['id']),
  machineScoped('skill_usage', ['id']),
  machineScoped('entity_mentions', ['entity_id', 'note_id', 'note_type', 'agent_id']),
  {
    name: 'content_publications',
    orderCols: ['artifact_kind', 'artifact_id'],
    baseWhere: (projectId) => ({
      sql: `artifact_id IN (${PROJECT_ARTIFACT_IDS_SQL})`,
      params: [projectId, projectId],
    }),
  },
];

interface PullCursor {
  table: string;
  key: string[];
}

/** Decode an opaque cursor. A malformed/absent cursor restarts from the beginning
 *  (safe — the member re-applies idempotently), never throws into the handler. */
function decodeCursor(cursor: string | null | undefined): PullCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    if (parsed && typeof parsed.table === 'string' && Array.isArray(parsed.key)) {
      return { table: parsed.table, key: parsed.key.map((v: unknown) => String(v)) };
    }
  } catch { /* fall through to a fresh start */ }
  return null;
}

function encodeCursor(cursor: PullCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

/** The cursor key of a row for a table (its order-columns, stringified). */
function rowKey(table: PullTable, row: Record<string, unknown>): string[] {
  return table.orderCols.map((c) => String(row[c]));
}

/** One page of rows starting at `table` after `afterKey` (LIMIT `limit`). */
function queryTablePage(
  db: Database,
  table: PullTable,
  projectId: string,
  machineId: string,
  afterKey: string[] | null,
  limit: number,
): Record<string, unknown>[] {
  const base = table.baseWhere(projectId, machineId);
  const conditions = [base.sql];
  const params = [...base.params];
  if (afterKey) {
    const cols = table.orderCols.join(', ');
    const placeholders = table.orderCols.map(() => '?').join(', ');
    conditions.push(`(${cols}) > (${placeholders})`);
    params.push(...afterKey);
  }
  const orderBy = table.orderCols.join(', ');
  return db.prepare(
    `SELECT * FROM ${table.name} WHERE ${conditions.join(' AND ')} ORDER BY ${orderBy} LIMIT ?`,
  ).all(...params, limit) as Record<string, unknown>[];
}

/**
 * Serve one detach-pull page for `(projectId, machineId)`, resuming at `cursor`.
 * Walks the fixed table order, filling the page up to the row/byte budget; the
 * cursor points at the last row emitted so the next call resumes exactly. `done`
 * (and a null cursor) is returned only once every table is exhausted.
 *
 * Not a repeatable-read snapshot: the cursor is key-ordered, so a row INSERTed mid
 * pull whose key sorts BELOW the current cursor (in a table already passed) is not
 * re-scanned and would be skipped. This is rare and non-lossy in practice — the host
 * keeps every row (D-F-3, no delete on detach), and capture DIVERTS the caller's own
 * forwards away from this project during the `pulling` window — so a missed row is
 * still on the host for a later re-attach/reconcile, never dropped.
 */
export function pullResidencyPage(
  db: Database,
  input: {
    projectId: string;
    machineId: string;
    cursor?: string | null;
    maxRows?: number;
    maxBytes?: number;
  },
): ResidencyPullPage {
  // Clamp to >= 1 so the per-table LIMIT is always positive and the row loop's
  // fill-return is the only way a page fills mid-table (below).
  const maxRows = Math.max(1, input.maxRows ?? RESIDENCY_PULL_PAGE_ROWS);
  const maxBytes = input.maxBytes ?? RESIDENCY_PULL_PAGE_BYTES;
  const decoded = decodeCursor(input.cursor);
  const startIndex = decoded
    ? Math.max(0, RESIDENCY_PULL_TABLES.findIndex((t) => t.name === decoded.table))
    : 0;

  const rows: ResidencyPullRow[] = [];
  let bytes = 0;

  for (let ti = startIndex; ti < RESIDENCY_PULL_TABLES.length; ti += 1) {
    const table = RESIDENCY_PULL_TABLES[ti];
    // Resume within the cursor's table; every later table starts fresh.
    let afterKey: string[] | null = ti === startIndex && decoded && decoded.table === table.name
      ? decoded.key
      : null;

    for (;;) {
      const need = maxRows - rows.length;
      // A table is only entered with room to spare: the row loop's fill-return
      // (below) caps `rows.length` at `maxRows` and returns the moment the page
      // fills, so `need >= 1` here (given the maxRows >= 1 clamp). This guard is a
      // belt-and-suspenders against a zero LIMIT, never the page-full exit — so it
      // stops scanning rather than minting a (would-be empty-key) resume cursor.
      if (need <= 0) break;
      const page = queryTablePage(db, table, input.projectId, input.machineId, afterKey, need);
      for (const raw of page) {
        const sanitized = sanitizeSyncPayload(table.name, raw);
        rows.push({ table: table.name, row: sanitized });
        bytes += JSON.stringify(sanitized).length;
        afterKey = rowKey(table, raw);
        if (rows.length >= maxRows || bytes >= maxBytes) {
          return { rows, nextCursor: encodeCursor({ table: table.name, key: afterKey }), done: false };
        }
      }
      // A short page means the table is exhausted — advance to the next table.
      if (page.length < need) break;
    }
  }

  return { rows, nextCursor: null, done: true };
}

/**
 * The done-page stub test: does the project still hold rows from any machine NOT in
 * `excludeMachineIds`? The caller passes the host's own machine id (its
 * intelligence-stamped rows never make a project a live member project) and,
 * per D-F-3, the departing member's machine id — so the answer is "does any OTHER
 * member still have rows here". Checks the machine-scoped residency tables; a true
 * on any one short-circuits. A project with no such rows is a true stub the caller
 * may deregister.
 */
export function projectHasForeignMachineRows(
  db: Database,
  projectId: string,
  excludeMachineIds: string[],
): boolean {
  const machineTables = RESIDENCY_PULL_TABLES.filter((t) => t.name !== 'content_publications');
  const exclude = excludeMachineIds.length > 0
    ? `AND machine_id NOT IN (${excludeMachineIds.map(() => '?').join(', ')})`
    : '';
  const parts = machineTables.map(
    (t) => `SELECT 1 FROM ${t.name} WHERE project_id = ? ${exclude}`,
  );
  const params: unknown[] = [];
  for (const _ of machineTables) params.push(projectId, ...excludeMachineIds);
  const row = db.prepare(
    `SELECT EXISTS(${parts.join(' UNION ALL ')}) AS has_rows`,
  ).get(...params) as { has_rows: number } | undefined;
  return (row?.has_rows ?? 0) !== 0;
}
