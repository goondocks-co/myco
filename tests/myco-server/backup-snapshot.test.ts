import { describe, expect, it } from 'bun:test';
import { Miniflare } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { backupCheckpointRestoreScenario, HOSTED_SQL_FUNCTION_ARGUMENT_CEILING, snapshotFunctionBounds, snapshotAdmission, snapshotRefusals, snapshotScenario } from './helpers/backup-snapshot.js';

type Outcome = Awaited<ReturnType<typeof snapshotScenario>>;
function check(result: Outcome, boundary: 'table' | 'page') {
  expect(result.interleaved).toBe(true);
  expect(result.liveReadable).toBe(true);
  expect(result.orphans).toEqual({ n: 0 });
  expect(result.keptReadable).toBe(true);
  expect(result.prompts).toEqual([
    { session_id: 'deleted', text: 'conversation deleted' },
    { session_id: 'kept', text: 'conversation kept' },
  ]);
  expect(result.tombstones).toEqual([]);
  expect(result.continuation).toEqual([{ cursor_offset: 0, chunk_index: 0, chunk_count: 1, payload: '{"planIndex":17}' }]);
  expect(result.restored).toHaveLength(boundary === 'page' ? 203 : 2);
  expect(result.restored).toContainEqual({ session_id: 'kept', title: 'before' });
  expect(result.restored).toContainEqual({ session_id: 'deleted', title: null });
}

function checkFunctions(result: Awaited<ReturnType<typeof snapshotFunctionBounds>>) {
  expect(result.columns).toBeGreaterThan(16);
  expect(result.maxArguments).toBeGreaterThan(0);
  expect(result.maxArguments).toBeLessThanOrEqual(HOSTED_SQL_FUNCTION_ARGUMENT_CEILING);
  expect(result.nullColumns.length).toBeGreaterThan(0);
  for (const column of result.nullColumns) {
    expect(Object.hasOwn(result.actual, column)).toBe(true);
    expect(result.actual[column]).toBeNull();
  }
  expect(result.equal).toBe(true);
}

function checkCheckpoint(result: Awaited<ReturnType<typeof backupCheckpointRestoreScenario>>) {
  expect(result.oldChunks).toBeGreaterThan(result.newChunks);
  expect(result.newChunks).toBeGreaterThan(0);
  expect(result.digestsDiffer).toBe(true);
  expect(result.liveUnchanged).toBe(true);
  expect(result.liveStateMatches).toBe(true);
  expect(result.freshMatches).toBe(true);
  expect(result.freshStateMatches).toBe(true);
}

function checkAdmission(result: Awaited<ReturnType<typeof snapshotAdmission>>) {
  expect(result.rows.error).toContain('10001 rows');
  expect(result.rows.error).toContain('myco server backup');
  expect(result.rows.serialization).toBe(0);
  expect(result.rows.payloadScans).toBe(0);
  expect(result.bytes.error).toContain('conservative bytes');
  expect(result.bytes.error).toContain('myco server backup');
  expect(result.bytes.serialization).toBe(0);
  expect(result.bytes.metadataSizes).toBeGreaterThan(0);
  expect(result.bytes.payloadScans).toBe(0);
  expect(result.race.interleaved).toBe(true);
  expect(result.race.error).toContain('10001 rows');
  expect(result.race.transferred).toBe(0);
  expect(result.byteRace.interleaved).toBe(true);
  expect(result.byteRace.error).toContain('conservative bytes');
  expect(result.byteRace.transferred).toBe(0);
  expect(result.accepted).toEqual({ rows: 8, exact: true });
}

describe('relational backup snapshot', () => {
  for (const boundary of ['table', 'page'] as const) {
    it(`native SQLite: capture, tombstone and editorial writes at the ${boundary} boundary restore one committed snapshot`, async () => {
      const source = sqliteEnv();
      const target = sqliteEnv();
      try {
        checkAdmission(await snapshotAdmission(source.db));
        checkCheckpoint(await backupCheckpointRestoreScenario(source.db, target.db, source.bucket, boundary === 'page'));
        checkFunctions(await snapshotFunctionBounds(source.db));
        check(await snapshotScenario(source.db, target.db, source.bucket, boundary), boundary);
        const refusal = await snapshotRefusals(source.db, source.bucket);
        expect(refusal.truncated).toContain('incomplete');
        expect(refusal.orphan).toContain('missing session');
        expect(refusal.continuationParent).toContain('transcript_parser_state_chunks names a missing transcript');
        expect(refusal.publications).toBe(0);
        expect({ bounded: refusal.bounded, transferred: refusal.transferred }).toEqual({ bounded: true, transferred: 0 });
      }
      finally { source.sqlite.close(); target.sqlite.close(); }
    });

    it(`D1 workerd: capture, tombstone and editorial writes at the ${boundary} boundary restore one committed snapshot`, async () => {
      const bundle = await Bun.build({ entrypoints: [`${import.meta.dir}/helpers/backup-snapshot.ts`], format: 'esm', target: 'browser' });
      if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'));
      const mf = new Miniflare({
        modules: [
          { type: 'ESModule', path: 'worker.js', contents: `import { backupCheckpointRestoreScenario, snapshotFunctionBounds, snapshotAdmission, snapshotRefusals, snapshotScenario } from './snapshot.js';
            export default { async fetch(request, env) {
              try {
                const admission = await snapshotAdmission(env.DB);
                const checkpoint = await backupCheckpointRestoreScenario(env.DB, env.TARGET, env.BUCKET, '${boundary}' === 'page');
                const functions = await snapshotFunctionBounds(env.DB);
                const result = await snapshotScenario(env.DB, env.TARGET, env.BUCKET, '${boundary}');
                return Response.json({ admission, result, refusal: await snapshotRefusals(env.DB, env.BUCKET), functions, checkpoint });
              }
              catch(e) { return Response.json({ error: String(e.stack) }, { status: 500 }); }
            } };` },
          { type: 'ESModule', path: 'snapshot.js', contents: await bundle.outputs[0]!.text() },
        ],
        compatibilityDate: '2026-07-01', d1Databases: ['DB', 'TARGET'], r2Buckets: ['BUCKET'],
      });
      try {
        for (const name of ['DB', 'TARGET']) {
          const db = await mf.getD1Database(name);
          for (const step of SCHEMA_STEPS) await db.batch(step.statements.map((sql) => db.prepare(sql)));
        }
        const response = await mf.dispatchFetch('http://snapshot/');
        const answer = await response.json() as { admission: Awaited<ReturnType<typeof snapshotAdmission>>; result: Outcome; refusal: Awaited<ReturnType<typeof snapshotRefusals>>; functions: Awaited<ReturnType<typeof snapshotFunctionBounds>>; checkpoint: Awaited<ReturnType<typeof backupCheckpointRestoreScenario>> };
        expect({ status: response.status, error: response.status === 200 ? undefined : answer }).toEqual({ status: 200, error: undefined });
        checkAdmission(answer.admission);
        check(answer.result, boundary);
        checkCheckpoint(answer.checkpoint);
        checkFunctions(answer.functions);
        expect(answer.refusal.truncated).toContain('incomplete');
        expect(answer.refusal.orphan).toContain('missing session');
        expect(answer.refusal.continuationParent).toContain('transcript_parser_state_chunks names a missing transcript');
        expect(answer.refusal.publications).toBe(0);
        expect({ bounded: answer.refusal.bounded, transferred: answer.refusal.transferred }).toEqual({ bounded: true, transferred: 0 });
      } finally { await mf.dispose(); }
    }, 60_000);
  }
});
