/**
 * Expand-only migration guard for the team-sync Cloudflare Worker's D1 schema.
 *
 * WHY THIS EXISTS
 * ---------------
 * The worker ingests pushed records via `INSERT OR REPLACE` over ONLY the
 * columns present in the payload (see `buildInsertParts` in
 * `packages/myco-team/worker/src/index.ts`, ~line 444). That helper always
 * supplies `id`, `machine_id`, and `synced_at`; EVERY other column comes from
 * the pushing daemon's payload. An OLDER daemon may omit a column that a newer
 * schema has since added.
 *
 * Therefore, the schema must stay EXPAND-ONLY. Any synced-table column that is
 * `NOT NULL` without a `DEFAULT` is a hazard ONLY for daemon versions that
 * don't send it. There are two cases, and they get different treatment:
 *
 *   1. ALTER TABLE ... ADD COLUMN (the load-bearing rule). A column added
 *      AFTER a table first shipped is, by definition, one that older daemons
 *      have never heard of and will never send. So an `ADD COLUMN` that is
 *      `NOT NULL` without a `DEFAULT` is a guaranteed mixed-version break:
 *      every in-flight payload that predates the column omits it, the INSERT
 *      throws, the record lands in the DLQ. This test FAILS on any such
 *      migration. This is where expand-only regressions actually happen.
 *
 *   2. CREATE TABLE base columns. The daemon pushes the FULL local row
 *      (`sanitizeSyncPayload` in db/queries/team-outbox.ts is `{...row}` minus
 *      a few local-only fields), so every column in a table's ORIGINAL DDL is
 *      always present in every daemon version that knows the table — those
 *      required columns (e.g. sessions.agent, spores.content, *.created_at)
 *      are NOT a mixed-version hazard and are grandfathered below in
 *      GRANDFATHERED_BASE_NOT_NULL. The guard's job for CREATE TABLE is to
 *      catch a NEW required column being slipped into a base DDL without a
 *      DEFAULT: anything NOT NULL/no-default that is neither worker-injected
 *      ({ id, machine_id, synced_at }) nor grandfathered fails the test. To
 *      add a genuinely-required column safely, give it a DEFAULT (expand-only)
 *      rather than extending the grandfather list.
 *
 * This test codifies that invariant so a schema change that would break
 * mixed-version clients cannot merge silently.
 *
 * DDL-ACCESS APPROACH
 * -------------------
 * The base `CREATE TABLE` constants, the `ALL_DDLS` array, and the in-function
 * `migrations` list in `schema.ts` are all MODULE-PRIVATE — only
 * `initD1Schema` and `InitD1Options` are exported. So we cannot import the
 * DDL; we read the source file text with `node:fs` and extract the
 * `CREATE TABLE` / `ALTER TABLE` statements with regex. State of the file is
 * the source of truth either way (executing initD1Schema requires a live
 * D1Database), so text extraction is both necessary and sufficient here.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNCED_TABLES as WORKER_SYNCED_TABLES } from '../../packages/myco-team/worker/src/synced-tables.js';

// ---------------------------------------------------------------------------
// Locate the worker schema source.
//
// `packages/myco/src/worker` is a symlink to `packages/myco-team/worker`, and
// the tsconfig alias `@myco-team-worker/*` maps to
// `./packages/myco-team/worker/src/*`. We resolve the real (non-symlinked)
// path by walking up from this test file to the repo root.
// ---------------------------------------------------------------------------
const THIS_DIR = dirname(fileURLToPath(import.meta.url)); // .../tests/worker
const REPO_ROOT = join(THIS_DIR, '..', '..'); // tests/worker -> tests -> repo root
const SCHEMA_PATH = join(REPO_ROOT, 'packages', 'myco-team', 'worker', 'src', 'schema.ts');

const schemaSource = readFileSync(SCHEMA_PATH, 'utf8');

/**
 * Synced tables — the ones that receive pushed records through the
 * `INSERT OR REPLACE` ingest path. Imported from the worker's authoritative
 * `SYNCED_TABLES` (a deliberately dependency-free module) rather than copied,
 * so a newly-added synced table is automatically covered by this guard instead
 * of silently skipped. Non-synced bookkeeping tables (nodes, team_config,
 * team_sync_stats, team_dlq) are written by the worker itself, never from a
 * daemon payload, so the expand-only rule does not apply to them.
 */
const SYNCED_TABLES = new Set<string>(WORKER_SYNCED_TABLES);

/**
 * Columns the worker always injects in `buildInsertParts`, so an older
 * daemon omitting them is harmless — they're never sourced from the payload.
 */
const ALWAYS_INJECTED = new Set(['id', 'machine_id', 'synced_at']);

/**
 * Grandfathered base `NOT NULL` columns — original required columns present
 * in each synced table's FIRST DDL. Because the daemon pushes the full local
 * row, every daemon version that knows the table sends these, so they are NOT
 * a mixed-version hazard (see docblock case 2). Keyed by table; a `*` means
 * the column name is grandfathered across every synced table (used for the
 * ubiquitous timestamp columns).
 *
 * Do NOT extend this list to make a new required column pass. The expand-only
 * fix for a newly-required column is to give it a DEFAULT.
 */
const GRANDFATHERED_BASE_NOT_NULL: Record<string, ReadonlySet<string>> = {
  '*': new Set(['created_at', 'updated_at']),
  sessions: new Set(['agent', 'started_at']),
  prompt_batches: new Set(['session_id']),
  spores: new Set(['agent_id', 'observation_type', 'content']),
  entities: new Set(['agent_id', 'type', 'name', 'first_seen', 'last_seen']),
  graph_edges: new Set([
    'agent_id', 'source_id', 'source_type', 'target_id', 'target_type', 'type',
  ]),
  artifacts: new Set(['source_path', 'title']),
  entity_mentions: new Set(['entity_id', 'note_id', 'note_type', 'agent_id']),
  resolution_events: new Set(['agent_id', 'spore_id', 'action']),
  digest_extracts: new Set(['agent_id', 'tier', 'content', 'generated_at']),
  skill_candidates: new Set(['agent_id', 'topic', 'rationale']),
  skill_records: new Set(['agent_id', 'name', 'display_name', 'description', 'path']),
  skill_usage: new Set(['skill_id', 'session_id', 'detected_at']),
  knowledge_release_state: new Set([
    'identity_key', 'namespace', 'record_id', 'state', 'confidence', 'checked_at',
  ]),
};

function isGrandfathered(table: string, column: string): boolean {
  if (GRANDFATHERED_BASE_NOT_NULL['*'].has(column)) return true;
  return GRANDFATHERED_BASE_NOT_NULL[table]?.has(column) ?? false;
}

const VIOLATION_RULE =
  'synced-table NOT NULL columns must have a DEFAULT so older clients omitting them ' +
  "don't break ingest";

interface ColumnViolation {
  table: string;
  column: string;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract every `CREATE TABLE [IF NOT EXISTS] <name> ( ... )` block from SQL
 * text. Returns `{ table, body }` where `body` is the text inside the
 * outermost parentheses. Brace/paren-depth aware so nested parens in CHECK
 * constraints or DEFAULT expressions don't truncate the body early.
 */
export function extractCreateTables(sql: string): Array<{ table: string; body: string }> {
  const out: Array<{ table: string; body: string }> = [];
  const header =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = header.exec(sql)) !== null) {
    const table = m[1];
    const bodyStart = header.lastIndex; // index just past the opening '('
    let depth = 1;
    let i = bodyStart;
    for (; i < sql.length && depth > 0; i += 1) {
      const ch = sql[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    // i now points just past the matching ')'
    const body = sql.slice(bodyStart, i - 1);
    out.push({ table, body });
  }
  return out;
}

/**
 * Split a CREATE TABLE body into top-level, comma-separated definition
 * fragments. Respects parenthesis depth so a multi-column PRIMARY KEY,
 * UNIQUE(...), or a DEFAULT expression containing commas is not split.
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

const TABLE_CONSTRAINT_KEYWORDS = /^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i;

/**
 * True if a top-level fragment is a table-level constraint (PRIMARY KEY,
 * FOREIGN KEY, UNIQUE, CHECK, CONSTRAINT) rather than a column definition.
 */
function isTableConstraint(fragment: string): boolean {
  return TABLE_CONSTRAINT_KEYWORDS.test(fragment.trim());
}

/**
 * Given a single column-definition fragment, return its column name. The name
 * is the first token, optionally quoted with ", ', or backtick.
 */
function columnNameOf(fragment: string): string {
  const m = /^\s*["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/.exec(fragment);
  return m ? m[1] : '';
}

/**
 * True when a column-definition fragment declares NOT NULL. Tolerant of
 * arbitrary whitespace/newlines between NOT and NULL.
 */
function isNotNull(fragment: string): boolean {
  return /\bNOT\s+NULL\b/i.test(fragment);
}

/**
 * True when a column-definition fragment carries a DEFAULT clause. Matches
 * DEFAULT followed by a string literal, number, CURRENT_TIMESTAMP/DATE/TIME,
 * a parenthesized expression, or a bare keyword/identifier (e.g. NULL, TRUE).
 */
function hasDefault(fragment: string): boolean {
  return /\bDEFAULT\s+(?:'[^']*'|"[^"]*"|-?\d[\d.]*|\(|CURRENT_(?:TIMESTAMP|DATE|TIME)\b|[A-Za-z_])/i.test(
    fragment,
  );
}

/**
 * Find every synced-table column that violates the expand-only rule in a
 * block of CREATE TABLE DDL.
 */
function findCreateTableViolations(sql: string): ColumnViolation[] {
  const violations: ColumnViolation[] = [];
  for (const { table, body } of extractCreateTables(sql)) {
    if (!SYNCED_TABLES.has(table)) continue;
    for (const fragment of splitTopLevel(body)) {
      if (isTableConstraint(fragment)) continue;
      const column = columnNameOf(fragment);
      if (!column) continue;
      if (ALWAYS_INJECTED.has(column)) continue;
      if (isGrandfathered(table, column)) continue;
      if (isNotNull(fragment) && !hasDefault(fragment)) {
        violations.push({ table, column });
      }
    }
  }
  return violations;
}

/**
 * Extract every `ALTER TABLE <name> ADD COLUMN <def>` statement and return
 * the table + the column-definition text (everything after ADD COLUMN).
 *
 * In the worker source each migration is a single JS string literal on its
 * own line, so we capture to the end of the line. The captured text may carry
 * a trailing JS-quote/comma artifact (e.g. `... DEFAULT '[]'",`) — those are
 * stripped by `stripTrailingJsArtifact`. Crucially we do NOT stop the capture
 * at the first quote, because that would sever a string DEFAULT value
 * (`DEFAULT 'initial'`) and produce a false NOT-NULL-no-default positive.
 */
export function extractAddColumns(sql: string): Array<{ table: string; def: string }> {
  const out: Array<{ table: string; def: string }> = [];
  const re =
    /ALTER\s+TABLE\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s+ADD\s+COLUMN\s+([^\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    out.push({ table: m[1], def: stripTrailingJsArtifact(m[2]) });
  }
  return out;
}

/**
 * Strip a trailing JS-string-literal close from a captured SQL fragment:
 * a closing quote (`'`, `"`, or backtick) that matches the implied opening
 * quote of the source literal, plus any trailing comma/semicolon/whitespace.
 * Leaves SQL-internal quoted values intact.
 */
function stripTrailingJsArtifact(raw: string): string {
  let s = raw.trim();
  // Drop a trailing comma/semicolon left over from the JS array element.
  s = s.replace(/[;,]\s*$/, '');
  // Drop one trailing JS quote char if it is unbalanced within the fragment
  // (i.e. it closes the source string literal rather than a SQL value).
  const last = s[s.length - 1];
  if (last === '"' || last === '`') {
    const count = (s.match(new RegExp(last === '`' ? '`' : '"', 'g')) ?? []).length;
    if (count % 2 === 1) s = s.slice(0, -1);
  } else if (last === "'") {
    const count = (s.match(/'/g) ?? []).length;
    if (count % 2 === 1) s = s.slice(0, -1);
  }
  return s.trim();
}

/**
 * Find every ADD COLUMN migration that adds a NOT NULL column to a synced
 * table without a DEFAULT.
 */
function findAddColumnViolations(sql: string): ColumnViolation[] {
  const violations: ColumnViolation[] = [];
  for (const { table, def } of extractAddColumns(sql)) {
    if (!SYNCED_TABLES.has(table)) continue;
    const column = columnNameOf(def);
    if (!column) continue;
    if (ALWAYS_INJECTED.has(column)) continue;
    if (isNotNull(def) && !hasDefault(def)) {
      violations.push({ table, column });
    }
  }
  return violations;
}

function formatViolations(violations: ColumnViolation[]): string {
  return violations
    .map((v) => `  - ${v.table}.${v.column}: ${VIOLATION_RULE}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worker D1 schema is expand-only', () => {
  it('every synced-table CREATE TABLE NOT NULL column has a DEFAULT (or is worker-injected)', () => {
    const violations = findCreateTableViolations(schemaSource);
    expect(
      violations,
      violations.length
        ? `Expand-only violation(s) in CREATE TABLE DDL:\n${formatViolations(violations)}`
        : '',
    ).toEqual([]);
  });

  it('every ADD COLUMN migration on a synced table is nullable or has a DEFAULT', () => {
    const violations = findAddColumnViolations(schemaSource);
    expect(
      violations,
      violations.length
        ? `Expand-only violation(s) in ALTER TABLE ... ADD COLUMN migrations:\n${formatViolations(
            violations,
          )}`
        : '',
    ).toEqual([]);
  });

  it('actually parsed the synced tables (guard against a silent zero-match no-op)', () => {
    const found = extractCreateTables(schemaSource)
      .map((t) => t.table)
      .filter((t) => SYNCED_TABLES.has(t));
    // Every declared synced table must have a CREATE TABLE in the source.
    for (const table of SYNCED_TABLES) {
      expect(found, `missing CREATE TABLE for synced table "${table}"`).toContain(table);
    }
    // And we must have parsed at least the full synced set.
    expect(found.length).toBe(SYNCED_TABLES.size);
  });

  // -------------------------------------------------------------------------
  // Positive controls — prove the guard is not a no-op. If the parser ever
  // regresses into accepting everything, these fail loudly.
  // -------------------------------------------------------------------------
  describe('positive controls (parser catches real violations)', () => {
    it('flags a CREATE TABLE with a NOT NULL column lacking a DEFAULT', () => {
      const scratch = `CREATE TABLE sessions (a TEXT NOT NULL)`;
      const violations = findCreateTableViolations(scratch);
      expect(violations).toEqual([{ table: 'sessions', column: 'a' }]);
    });

    it('flags a multi-line NOT NULL-no-default column and ignores valid siblings', () => {
      const scratch = `
        CREATE TABLE IF NOT EXISTS spores (
          id            TEXT NOT NULL,
          machine_id    TEXT NOT NULL,
          good_default  TEXT NOT NULL DEFAULT 'x',
          good_num      INTEGER NOT NULL DEFAULT 0,
          nullable_ok   TEXT,
          bad_column    TEXT
                        NOT NULL,
          synced_at     INTEGER,
          PRIMARY KEY (id, machine_id)
        )`;
      const violations = findCreateTableViolations(scratch);
      expect(violations).toEqual([{ table: 'spores', column: 'bad_column' }]);
    });

    it('flags an ADD COLUMN NOT NULL without a DEFAULT', () => {
      const scratch = `ALTER TABLE plans ADD COLUMN must_have TEXT NOT NULL`;
      const violations = findAddColumnViolations(scratch);
      expect(violations).toEqual([{ table: 'plans', column: 'must_have' }]);
    });

    it('does NOT flag valid NOT NULL DEFAULT forms (no false positives)', () => {
      const scratch = `
        CREATE TABLE sessions (
          a TEXT NOT NULL DEFAULT 'active',
          b INTEGER NOT NULL DEFAULT 0,
          c REAL NOT NULL DEFAULT 1.0,
          d TEXT NOT NULL DEFAULT '[]',
          e INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          f INTEGER DEFAULT 0,
          g TEXT
        )`;
      expect(findCreateTableViolations(scratch)).toEqual([]);

      const adds = [
        "ALTER TABLE plans ADD COLUMN k TEXT NOT NULL DEFAULT 'initial'",
        'ALTER TABLE plans ADD COLUMN n INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE plans ADD COLUMN o TEXT',
        'ALTER TABLE plans ADD COLUMN p INTEGER',
      ].join('\n');
      expect(findAddColumnViolations(adds)).toEqual([]);
    });

    it('does NOT treat table-level constraints as columns', () => {
      const scratch = `
        CREATE TABLE entity_mentions (
          entity_id TEXT NOT NULL DEFAULT '',
          UNIQUE (entity_id, note_id, note_type, agent_id),
          PRIMARY KEY (entity_id, note_id)
        )`;
      expect(findCreateTableViolations(scratch)).toEqual([]);
    });
  });
});
