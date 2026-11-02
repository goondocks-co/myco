import type { BlobStore, PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { backupArtifact, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { getSession, writeTitle } from '@myco-server-worker/read/sessions.js';
import { relationalSnapshot, RelationalSnapshotTooLargeError } from '@myco-server-worker/core/relational-snapshot.js';
import type { ParserState } from '@myco-server-worker/ingest/parsers/index.js';

const PROJECT = 'proj_snapshot';
export const HOSTED_SQL_FUNCTION_ARGUMENT_CEILING = 32;
const context = { projectId: PROJECT, machineId: 'snapshot-machine', tokenId: 'snapshot-token', bodyBytes: 0, now: 1000, writeOrigin: 'server' as const };
const uuid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

async function capture(db: RelationalStore, sessionId: string, n: number): Promise<void> {
  const result = await ingestEvent(db, context, {
    eventId: uuid(n), sessionId, kind: 'prompt', createdAt: 1000, channel: 'cli',
    producer: { adapter: 'claude-code', version: 'test' },
    payload: { promptId: uuid(n + 1), text: `conversation ${sessionId}`, origin: 'user' },
  });
  if (!result.persisted || result.projected !== true) throw new Error(`capture failed: ${JSON.stringify(result)}`);
}

/** Writes between table/page reads and after an atomic snapshot has completed. */
export async function snapshotScenario(db: RelationalStore, target: RelationalStore, blobs: BlobStore, boundary: 'table' | 'page') {
  await db.prepare(`INSERT INTO projects (project_id, name, created_at) VALUES (?, 'Snapshot', 1)`).bind(PROJECT).run();
  await capture(db, 'kept', 1);
  await capture(db, 'deleted', 3);
  await writeTitle(db, PROJECT, 'kept', 'before', 'before summary');
  await db.prepare(`INSERT INTO transcripts
    (project_id, transcript_id, session_id, machine_id, first_received_at, last_received_at, token_id)
    VALUES (?, 'snapshot-transcript', 'kept', 'snapshot-machine', 1, 1, 'snapshot-token')`).bind(PROJECT).run();
  if (boundary === 'page') {
    await db.batch(Array.from({ length: 201 }, (_, n) => db.prepare(`INSERT INTO sessions
      (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      VALUES (?, ?, 'snapshot-machine', 'snapshot-token', 1, 1)`).bind(PROJECT, `page-${n}`)));
  }
  let interleaved = false;
  const mutate = async () => {
    if (interleaved) return;
    interleaved = true;
    await capture(db, 'during-backup', 5);
    await tombstoneSession({ db }, { projectId: PROJECT }, 'deleted', 'snapshot-owner', 2000);
    await writeTitle(db, PROJECT, 'kept', 'after', 'after summary');
  };
  const observe = (sql: string, statement: PreparedStatement, values: unknown[] = []): PreparedStatement => ({
    ...statement,
    bind: (...next) => observe(sql, statement.bind(...next), next),
    first: <T>() => statement.first<T>(),
    run: () => statement.run(),
    async all<T>() {
      if ((boundary === 'table' && sql.startsWith('SELECT rowid AS __rid, * FROM events '))
        || (boundary === 'page' && sql.startsWith('SELECT rowid AS __rid, * FROM sessions ') && Number(values[0]) > 0)) await mutate();
      return statement.all<T>();
    },
  });
  const observed: RelationalStore = {
    prepare: (sql) => observe(sql, db.prepare(sql)),
    async batch(statements) {
      const result = await db.batch(statements);
      if (result.some((one) => one.results.some((row) => 'snapshot_count' in (row as Record<string, unknown>)))) await mutate();
      return result;
    },
  };
  const saved = await createBackup(observed, blobs, { producer: 'snapshot-gate', now: 1500 });
  const artifact = (await backupArtifact(db, blobs, saved.id))!;
  await restoreArtifact(target, { authorization: { kind: 'recovery' }, text: artifact.text, allowForeignLineage: true });
  const restored = await target.prepare(`SELECT session_id, title FROM sessions WHERE project_id = ? ORDER BY session_id`).bind(PROJECT).all();
  const prompts = await target.prepare(`SELECT session_id,json_extract(payload,'$.text') AS text FROM events WHERE kind='prompt' AND project_id = ? ORDER BY session_id`).bind(PROJECT).all();
  const orphans = await target.prepare(`SELECT COUNT(*) AS n FROM events p WHERE p.project_id = ? AND NOT EXISTS
    (SELECT 1 FROM sessions s WHERE s.project_id = p.project_id AND s.session_id = p.session_id)`).bind(PROJECT).first();
  const tombstones = await target.prepare(`SELECT session_id FROM session_tombstones WHERE project_id = ?`).bind(PROJECT).all();
  const live = await getSession(db, { projectId: PROJECT }, 'during-backup');
  const kept = await getSession(target, { projectId: PROJECT }, 'kept');
  return { interleaved, liveReadable: live !== null, restored: restored.results, prompts: prompts.results, orphans, tombstones: tombstones.results, keptReadable: kept !== null };
}

/** Incomplete reads and missing capture parents never reach artifact publication. */
export async function snapshotRefusals(db: RelationalStore, blobs: BlobStore) {
  let publications = 0;
  const observedBlobs: BlobStore = {
    head: (key) => blobs.head(key), get: (key, options) => blobs.get(key, options), delete: (key) => blobs.delete(key),
    put: (key, value, options) => { publications += 1; return blobs.put(key, value, options); },
  };
  const refusal = async (store: RelationalStore) => {
    try { await createBackup(store, observedBlobs, { producer: 'refusal-gate', now: 1500 }); return 'published'; }
    catch (error) { return (error as Error).message; }
  };
  const shortRead: RelationalStore = {
    prepare: (sql) => db.prepare(sql),
    async batch(statements) {
      const results = await db.batch(statements);
      for (const result of results) {
        result.results = result.results.filter((row) => !String((row as { line?: unknown }).line ?? '').startsWith('{"t":"events"'));
      }
      return results;
    },
  };
  const truncated = await refusal(shortRead);
  let bounded = false;
  let transferred = 0;
  const measured: RelationalStore = {
    prepare: (sql) => db.prepare(sql),
    async batch(statements) {
      const results = await db.batch(statements);
      const result = results.find((result) => 'snapshot_count' in (result.results[0] as Record<string, unknown> ?? {}));
      if (result !== undefined) transferred = result.results.filter((row) => (row as { line: unknown }).line !== null).length;
      return results;
    },
  };
  try { await relationalSnapshot(measured, ['sessions', 'events'], 1); }
  catch (error) { bounded = error instanceof RelationalSnapshotTooLargeError; }
  await db.prepare(`UPDATE events SET session_id = 'missing-parent' WHERE project_id = ?`).bind(PROJECT).run();
  const orphan = await refusal(db);
  return { truncated, orphan, publications, bounded, transferred };
}

/** Count JSON-function arguments independently of the source serializer. */
function jsonFunctionArguments(sql: string): number[] {
  return [...sql.matchAll(/\bjson_[a-z_]+\s*\(/gi)].map((match) => {
    let depth = 1;
    let quote = '';
    let argumentsCount = 1;
    for (let at = match.index! + match[0].length; at < sql.length && depth > 0; at += 1) {
      const character = sql[at]!;
      if (quote !== '') {
        if (character === quote) {
          if (sql[at + 1] === quote) at += 1;
          else quote = '';
        }
      } else if (character === "'" || character === '"') quote = character;
      else if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      else if (character === ',' && depth === 1) argumentsCount += 1;
    }
    return argumentsCount;
  });
}

/** Wide rows preserve every NULL while respecting the hosted function-argument ceiling. */
export async function snapshotFunctionBounds(db: RelationalStore) {
  await db.prepare(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_wide', 'Wide snapshot', 1)`).run();
  await db.prepare(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('snapshot-wide-agent', 'Wide', 'built-in', 1, 1)`).run();
  await db.prepare(`INSERT INTO agent_runs (project_id, id, agent_id, status, started_at)
    VALUES ('proj_wide', 'snapshot-wide-run', 'snapshot-wide-agent', 'completed', 1)`).run();
  const expected = (await db.prepare(`SELECT * FROM agent_runs WHERE id = 'snapshot-wide-run'`).first<Record<string, unknown>>())!;
  let maxArguments = 0;
  const bounded: RelationalStore = {
    prepare(sql) {
      const argumentsCounts = jsonFunctionArguments(sql);
      maxArguments = Math.max(maxArguments, ...argumentsCounts);
      if (maxArguments > HOSTED_SQL_FUNCTION_ARGUMENT_CEILING) throw new Error(`SQL function exceeds the hosted ${HOSTED_SQL_FUNCTION_ARGUMENT_CEILING}-argument ceiling: ${maxArguments}`);
      return db.prepare(sql);
    },
    batch: (statements) => db.batch(statements),
  };
  const snapshot = await relationalSnapshot(bounded, ['agent_runs'], 1024 * 1024);
  const actual = snapshot.get('agent_runs')!.find((row) => row.id === 'snapshot-wide-run')!;
  return {
    maxArguments, columns: Object.keys(expected).length,
    nullColumns: Object.entries(expected).filter(([, value]) => value === null).map(([name]) => name),
    equal: JSON.stringify(actual) === JSON.stringify(expected), actual,
  };
}

/** Admission refuses stores before preparing any row-serialization statement. */
export async function snapshotAdmission(db: RelationalStore) {
  await db.prepare('CREATE TABLE snapshot_admission_gate (payload TEXT)').run();
  await db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10001)
    INSERT INTO snapshot_admission_gate SELECT 'small' FROM n`).run();
  const probe = async () => {
    const queries: string[] = [];
    const observed: RelationalStore = { prepare(sql) { queries.push(sql); return db.prepare(sql); }, batch: (statements) => db.batch(statements) };
    let error = '';
    try { await relationalSnapshot(observed, ['snapshot_admission_gate'], 64 * 1024 * 1024); }
    catch (failure) { error = String(failure); }
    return { error, serialization: queries.filter((sql) => /json_(?:object|set)/i.test(sql)).length,
      payloadScans: queries.filter((sql) => /length\(CAST\("payload"/i.test(sql)).length,
      metadataSizes: queries.filter((sql) => /octet_length\("payload"\)/i.test(sql)).length };
  };
  const rows = await probe();
  await db.prepare('DELETE FROM snapshot_admission_gate').run();
  await db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 8)
    INSERT INTO snapshot_admission_gate SELECT replace(hex(zeroblob(100000)), '0', 'x') FROM n`).run();
  const bytes = await probe();
  const racingProbe = async (populate: string) => {
    await db.prepare('DELETE FROM snapshot_admission_gate').run();
    let interleaved = false;
    let transferred = 0;
    const racing: RelationalStore = {
      prepare: (sql) => db.prepare(sql),
      async batch(statements) {
        const results = await db.batch(statements);
        if (results.some((result) => result.results.some((row) => 'snapshot_count' in (row as Record<string, unknown>)))) {
          transferred = results.reduce((n, result) => n + result.results.filter((row) => (row as { line?: unknown }).line != null).length, 0);
        }
        else if (!interleaved && results.some((result) => result.results.some((row) => 'admission_bytes' in (row as Record<string, unknown>)))) {
          interleaved = true;
          await db.prepare(populate).run();
        }
        return results;
      },
    };
    let error = '';
    try { await relationalSnapshot(racing, ['snapshot_admission_gate'], 64 * 1024 * 1024); }
    catch (failure) { error = String(failure); }
    return { interleaved, transferred, error };
  };
  const race = await racingProbe(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10001)
    INSERT INTO snapshot_admission_gate SELECT 'racing' FROM n`);
  const byteRace = await racingProbe(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 8)
    INSERT INTO snapshot_admission_gate SELECT replace(hex(zeroblob(100000)), '0', 'x') FROM n`);
  await db.prepare('DELETE FROM snapshot_admission_gate').run();
  await db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 8)
    INSERT INTO snapshot_admission_gate SELECT replace(hex(zeroblob(85000)), '0', char(1)) FROM n`).run();
  const accepted = (await relationalSnapshot(db, ['snapshot_admission_gate'], 64 * 1024 * 1024)).get('snapshot_admission_gate')!;
  await db.prepare('DROP TABLE snapshot_admission_gate').run();
  return { rows, bytes, race, byteRace, accepted: { rows: accepted.length, exact: accepted.every((row) => row.payload === String.fromCharCode(1).repeat(170000)) } };
}
