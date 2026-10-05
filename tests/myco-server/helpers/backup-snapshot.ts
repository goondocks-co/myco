import type { BlobStore, PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { backupArtifact, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { getSession, writeTitle } from '@myco-server-worker/read/sessions.js';
import { relationalSnapshot, RelationalSnapshotTooLargeError } from '@myco-server-worker/core/relational-snapshot.js';
import { parserCheckpointStatements, readParserCheckpoint } from '@myco-server-worker/ingest/parser-checkpoint.js';
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
  await db.prepare(`INSERT INTO transcript_parser_state_chunks
    (project_id, transcript_id, cursor_offset, chunk_index, chunk_count, payload)
    VALUES (?, 'snapshot-transcript', 0, 0, 1, '{"planIndex":17}')`).bind(PROJECT).run();
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
  await restoreArtifact(target, { text: artifact.text, allowForeignLineage: true });
  const restored = await target.prepare(`SELECT session_id, title FROM sessions WHERE project_id = ? ORDER BY session_id`).bind(PROJECT).all();
  const prompts = await target.prepare(`SELECT session_id, text FROM prompt_batches WHERE project_id = ? ORDER BY session_id`).bind(PROJECT).all();
  const orphans = await target.prepare(`SELECT COUNT(*) AS n FROM prompt_batches p WHERE p.project_id = ? AND NOT EXISTS
    (SELECT 1 FROM sessions s WHERE s.project_id = p.project_id AND s.session_id = p.session_id)`).bind(PROJECT).first();
  const tombstones = await target.prepare(`SELECT session_id FROM session_tombstones WHERE project_id = ?`).bind(PROJECT).all();
  const continuation = await target.prepare(`SELECT cursor_offset, chunk_index, chunk_count, payload
    FROM transcript_parser_state_chunks WHERE project_id = ? AND transcript_id = 'snapshot-transcript'`).bind(PROJECT).all();
  const live = await getSession(db, { projectId: PROJECT }, 'during-backup');
  const kept = await getSession(target, { projectId: PROJECT }, 'kept');
  return { interleaved, liveReadable: live !== null, restored: restored.results, prompts: prompts.results, orphans, tombstones: tombstones.results, continuation: continuation.results, keptReadable: kept !== null };
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
        result.results = result.results.filter((row) => !String((row as { line?: unknown }).line ?? '').startsWith('{"t":"prompt_batches"'));
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
  try { await relationalSnapshot(measured, ['sessions', 'prompt_batches'], 1); }
  catch (error) { bounded = error instanceof RelationalSnapshotTooLargeError; }
  const missingTranscript: RelationalStore = {
    prepare: (sql) => db.prepare(sql),
    async batch(statements) {
      const results = await db.batch(statements);
      for (const result of results) {
        const kept = result.results.filter((row) => !String((row as { line?: unknown }).line ?? '').startsWith('{"t":"transcripts"'));
        const removed = result.results.length - kept.length;
        result.results = kept.map((row) => removed === 0 ? row : {
          ...row as Record<string, unknown>, snapshot_count: (row as { snapshot_count: number }).snapshot_count - removed,
        });
      }
      return results;
    },
  };
  const continuationParent = await refusal(missingTranscript);
  await db.prepare(`UPDATE prompt_batches SET session_id = 'missing-parent' WHERE project_id = ?`).bind(PROJECT).run();
  const orphan = await refusal(db);
  return { truncated, orphan, publications, bounded, transferred, continuationParent };
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

/** Restoring an artifact reuses a live checkpoint and admits the exact checkpoint into a fresh destination. */
export async function backupCheckpointRestoreScenario(db: RelationalStore, fresh: RelationalStore, blobs: BlobStore, sameCursor: boolean) {
  const projectId = `proj_checkpoint_${sameCursor ? 'same' : 'advanced'}`;
  const transcriptId = 'checkpoint-transcript';
  await db.prepare(`INSERT INTO projects (project_id, name, created_at) VALUES (?, 'Checkpoint', 1)`).bind(projectId).run();
  await db.prepare(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
    VALUES (?, 'checkpoint-session', 'checkpoint-machine', 'checkpoint-token', 1, 1)`).bind(projectId).run();
  await db.prepare(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, first_received_at, last_received_at, token_id, size)
    VALUES (?, ?, 'checkpoint-session', 'checkpoint-machine', 1, 1, 'checkpoint-token', 200)`)
    .bind(projectId, transcriptId).run();
  const state = (calls: number, marker: string): ParserState => ({
    pending: Object.fromEntries(Array.from({ length: calls }, (_, index) => [String(index), {
      toolCallId: `checkpoint-call-${index}`, toolName: 'Read', createdAt: 1, offset: index,
      input: { path: marker.repeat(100_000) },
    }])), planPosition: calls,
  });
  const oldState = state(5, 'a');
  const newState = state(3, 'b');
  const checkpoint = async (prior: number, to: number, state: ParserState) => {
    await db.batch(await parserCheckpointStatements(db, { projectId, transcriptId, parsedOffset: prior }, to, state, undefined, prior !== 0,
      (context) => db.prepare(`UPDATE transcripts SET parsed_offset = ?, parser_context = ?
        WHERE project_id = ? AND transcript_id = ? AND parsed_offset = ?`).bind(to, context, projectId, transcriptId, prior)));
  };
  const held = async (store: RelationalStore) => {
    const parent = (await store.prepare(`SELECT parsed_offset, parser_context FROM transcripts WHERE project_id = ? AND transcript_id = ?`)
      .bind(projectId, transcriptId).first<{ parsed_offset: number; parser_context: string }>())!;
    const chunks = (await store.prepare(`SELECT cursor_offset, chunk_index, chunk_count, payload FROM transcript_parser_state_chunks
      WHERE project_id = ? AND transcript_id = ? ORDER BY chunk_index`).bind(projectId, transcriptId).all()).results;
    return { parent, chunks };
  };
  const read = async (store: RelationalStore) => {
    const current = await held(store);
    const marker = JSON.parse(current.parent.parser_context) as { mycoParserState: { digest: string } };
    return readParserCheckpoint(store, { projectId, transcriptId, parsedOffset: current.parent.parsed_offset }, marker.mycoParserState.digest);
  };
  await checkpoint(0, 100, oldState);
  const older = await held(db);
  const saved = await createBackup(db, blobs, { producer: 'checkpoint-restore-gate', now: 1 });
  const artifact = (await backupArtifact(db, blobs, saved.id))!;
  await checkpoint(100, sameCursor ? 100 : 200, newState);
  const advanced = await held(db);
  await restoreArtifact(db, { text: artifact.text });
  await restoreArtifact(db, { text: artifact.text });
  const live = await held(db);
  await restoreArtifact(fresh, { text: artifact.text, allowForeignLineage: true });
  await restoreArtifact(fresh, { text: artifact.text, allowForeignLineage: true });
  const restored = await held(fresh);
  return {
    oldChunks: older.chunks.length, newChunks: advanced.chunks.length,
    digestsDiffer: older.parent.parser_context !== advanced.parent.parser_context,
    liveUnchanged: JSON.stringify(live) === JSON.stringify(advanced),
    liveStateMatches: JSON.stringify(await read(db)) === JSON.stringify(newState),
    freshMatches: JSON.stringify(restored) === JSON.stringify(older),
    freshStateMatches: JSON.stringify(await read(fresh)) === JSON.stringify(oldState),
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
