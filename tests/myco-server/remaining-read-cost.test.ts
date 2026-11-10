import { vectorId } from '@myco-server-worker/core/embedding/vectors.js';
import { hasEmbeddingWork } from '@myco-server-worker/core/embedding/work.js';
import { reconcileEmbedding } from '@myco-server-worker/core/embedding/reconcile.js';
import { cloudflareVectorStore } from '@myco-server-worker/platform/cloudflare/vectors.js';
import { indexFixture } from './helpers/vector-index.js';
import { prepareEmbeddingDue, retiringReceipt } from '@myco-server-worker/db/embeddings/work.js';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { machineActivity } from '@myco-server-worker/read/machines.js';
import {
  sessions_listSessions as listSessions,
} from '@myco-server-worker/read/catalog/sessions.js';
import { taskRunFacts } from '@myco-server-worker/db/runs/task-facts.js';
import { pageSegments } from '@myco-server-worker/read/transcript.js';
import { RawResourceReader } from '@myco-server-worker/core/raw-resources.js';
import { handleTranscript } from '@myco-server-worker/api/sessions.js';
import { memoryBlobStore, sqliteEnv } from './helpers/fixtures.js';
import { measuredStore } from './helpers/read-budget.js';
import { schemaD1Root } from './helpers/schema-template.js';

let mf: Miniflare;
let measured: ReturnType<typeof measuredStore>;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(null); } }',
      compatibilityDate: '2026-07-01',
      d1Databases: ['DB'],
      resourcePersistencePath: await schemaD1Root(),
    }),
  );
  const d1 = await mf.getD1Database('DB');
  measured = measuredStore(d1);
  await measured.db.prepare("INSERT INTO members(id,created_at) VALUES('owner',1)").run();
  await measured.db
    .prepare(
      "INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at) VALUES('token','owner','machine','hash',1,9999999999999,'token',1),('token-next','owner','machine','hash-next',2,9999999999999,'token',1)",
    )
    .run();
  await measured.db.prepare("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','owner',1)").run();
  await measured.db.prepare("INSERT INTO members(id,created_at) VALUES('other',1)").run();
  await measured.db
    .prepare(
      "INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at) VALUES('foreign','other','other-machine','foreign',1,9999999999999,'foreign',1)",
    )
    .run();
  await measured.db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
}, 60_000);
afterAll(() => mf.dispose());
const seq = `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)`;
async function project(id: string) {
  await measured.db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(id, id).run();
}
function report(name: string, size: number) {
  console.info('READ_COST', JSON.stringify({ name, size, reads: measured.reads(), writes: measured.writes() }));
}
const sampled = new Map<string, number[]>();
/** Records the rows `name` read after the last reset, at this size. */
function sample(name: string, size: number) {
  report(name, size);
  sampled.set(name, [...(sampled.get(name) ?? []), measured.reads()]);
}
/** The request read no more rows at the larger size than at the smaller one. */
function expectFlat(...names: string[]) {
  for (const name of names) {
    const [small, large] = sampled.get(name)!;
    expect(large, name).toBeLessThanOrEqual(small!);
  }
}

test('machine activity merges complete credential pages with tied times and a continuation', async () => {
  await project('machine');
  await project('machine-b');
  for (const size of [1000, 4000]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO events(project_id,event_id,session_id,channel,kind,created_at,received_at,token_id,payload,envelope_hash)
      SELECT CASE WHEN x%3=0 THEN 'machine-b' ELSE 'machine' END,printf('e-%06d',x),'s','capture','session.start',x/3,x,CASE WHEN x%2=0 THEN 'token-next' ELSE 'token' END,'{}','h' FROM n`,
      )
      .bind(size)
      .run();
    measured.reset();
    const first = await machineActivity(measured.db, 'machine');
    sample('machine', size);
    expect(first.rows).toHaveLength(50);
    const second = await machineActivity(measured.db, 'machine', { cursor: first.cursor! });
    expect(new Set([...first.rows, ...second.rows].map((r) => r.eventId)).size).toBe(100);
    const expected = Array.from({ length: size }, (_, i) => ({
      createdAt: Math.floor((i + 1) / 3),
      projectId: (i + 1) % 3 === 0 ? 'machine-b' : 'machine',
      eventId: 'e-' + String(i + 1).padStart(6, '0'),
    }));
    expected.sort((a, b) => b.createdAt - a.createdAt || b.projectId.localeCompare(a.projectId) || b.eventId.localeCompare(a.eventId));
    expect([...first.rows, ...second.rows].map((row) => row.projectId + ':' + row.eventId)).toEqual(
      expected.slice(0, 100).map((row) => row.projectId + ':' + row.eventId),
    );
  }
  expectFlat('machine');
  await project('rotations');
  const credentials = 60;
  await measured.db
    .prepare(
      `${seq} INSERT OR IGNORE INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
    SELECT printf('rot-%03d',x),'owner','rotations',printf('rot-hash-%03d',x),x,9999999999999,printf('rot-%03d',x),x FROM n`,
    )
    .bind(credentials)
    .run();
  // A machine whose many rotated credentials each wrote history: a page costs the same as that history grows.
  for (const events of [credentials * 100, credentials * 400]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO events(project_id,event_id,session_id,channel,kind,created_at,received_at,token_id,payload,envelope_hash)
      SELECT 'rotations',printf('rot-event-%06d',x),'s','capture','session.start',x,x,printf('rot-%03d',(x-1)%${credentials}+1),'{}','h' FROM n`,
      )
      .bind(events)
      .run();
    measured.reset();
    const result = await machineActivity(measured.db, 'rotations');
    sample('credential rotations', events);
    expect(result.rows).toHaveLength(50);
    expect(result.rows[0]!.createdAt).toBe(events);
  }
  expectFlat('credential rotations');
});

test('late session pages seek past the newer prefix including timestamp ties', async () => {
  await project('sessions');
  for (const size of [1000, 4000]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,started_at)
      SELECT 'sessions',printf('s-%06d',x),'m','token',x/3,x,x/3 FROM n`,
      )
      .bind(size)
      .run();
    measured.reset();
    const result = await listSessions(measured.db, { projectId: 'sessions' }, { cursor: '20:s-000062', fidelity: 'any' });
    sample('sessions', size);
    expect(result.rows[0]?.sessionId).toBe('s-000061');
  }
  expectFlat('sessions');
});

test('retirement consumes changed identities without reproving settled receipts', async () => {
  await project('retire');
  for (const size of [1000, 4000]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO plans(project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
      SELECT 'retire',printf('p-%06d',x),'s','e','m','body','h','active',1,1,'token',1 FROM n`,
      )
      .bind(size)
      .run();
    await measured.db
      .prepare(
        `INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
      SELECT project_id,'model',record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='retire'`,
      )
      .run();
    for (let pass = 0; pass < 20; pass++) await retiringReceipt(measured.db, 'retire', ['model'], 100);
    measured.reset();
    expect(await retiringReceipt(measured.db, 'retire', ['model'], 100)).toBeNull();
    sample('retirement', size);
    await measured.db.prepare("UPDATE plans SET content=content||' changed' WHERE project_id='retire' AND plan_key='p-000001'").run();
    expect((await retiringReceipt(measured.db, 'retire', ['model'], 100))?.record_id).toBe('p-000001');
    await measured.db.prepare("DELETE FROM embedding_receipts WHERE project_id='retire' AND record_id='p-000001'").run();
  }
  expectFlat('retirement');
});

test('schedule facts read latest entries and the rolling window independently of old history', async () => {
  await project('runs');
  for (const size of [1000, 4000]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO agent_runs(id,project_id,agent_id,task,status,started_at,dispatch_spec)
      SELECT printf('run-%06d',x),'runs','agent','extract-curate','completed',x,'{"actor":"clock"}' FROM n`,
      )
      .bind(size)
      .run();
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO agent_runs(id,project_id,agent_id,task,status,started_at,dispatch_spec)
      SELECT printf('manual-%06d',x),'runs','agent','extract-curate','completed',10000+x,'{"actor":"member"}' FROM n`,
      )
      .bind(size)
      .run();
    measured.reset();
    const q = taskRunFacts(measured.db, ['extract-curate'], 10000, 'clock', 'runs');
    const facts = q.read((await q.statement.all<Record<string, unknown>>()).results);
    sample('schedule', size);
    expect([...facts.values()]).toEqual([{ live: false, lastEntryAt: size, entriesSince: 0 }]);
  }
  expectFlat('schedule');
});

test('raw segment pages cost the same as segments grow, continue past private pieces, and show a revoked member nothing', async () => {
  await project('raw');
  await measured.db.prepare("INSERT OR IGNORE INTO schema_meta(key,value) VALUES('deployment_id','local-fixture')").run();
  await measured.db
    .prepare(
      "INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,first_received_at,last_received_at,token_id) VALUES('raw','t','s','machine',1000,1,1,'token')",
    )
    .run();
  const db = measured.db;
  await measured.db
    .prepare(
      `INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
    VALUES('raw',printf('%064x',1),'00000000-0000-4000-8000-000000000001','bundle','wrapper','e','h','s','d',1,1,1)`,
    )
    .run();
  for (const size of [1000, 4000]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
    SELECT 'raw',printf('%064x',x),1,'text/plain',CASE WHEN x=50 THEN 'foreign' ELSE 'token' END,1,'00000000-0000-4000-8000-000000000001' FROM n`,
      )
      .bind(size)
      .run();
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO transcript_segments(project_id,transcript_id,base_offset,length,blob_key,created_at,event_id,token_id,received_at)
    SELECT 'raw','t',x-1,1,printf('%064x',x),1,'segment','token',1 FROM n`,
      )
      .bind(size)
      .run();
    const reader = new RawResourceReader({ db, blobs: memoryBlobStore() }, { projectId: 'raw' }, { kind: 'member', memberId: 'owner' });
    measured.reset();
    const result = await reader.transcripts('s');
    sample('raw', size);
    expect(result.transcripts).toHaveLength(1);
    expect(result.transcripts[0]!.segments).toHaveLength(48);
    expect(result.transcripts[0]!.segmentsCursor).not.toBeNull();
    const next = await reader.transcripts('s', { transcriptId: 't', segmentCursor: result.transcripts[0]!.segmentsCursor! });
    expect(next.transcripts[0]!.segments[0]!.baseOffset).toBe(50);
  }
  expectFlat('raw');
  const native = sqliteEnv();
  try {
    const url = new URL('https://local.invalid/api/projects/raw/sessions/s/transcript');
    const response = await handleTranscript(
      { ...native.serverEnv, db, blobs: memoryBlobStore() },
      {
        request: new Request(url),
        url,
        params: { projectId: 'raw', sessionId: 's' },
        member: { id: 'owner', label: null, role: 'member' },
        session: { aud: 'local-fixture', sub: 'fixture', login: 'fixture', iat: 1, exp: 9999999999999 },
        config: { clientId: 'fixture', clientSecret: 'fixture', sessionSecret: 'fixture'.repeat(8) },
        now: 100,
        source: 'local-fixture',
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ cursor: null, transcript: { transcriptId: 't', segmentsCursor: expect.any(String) } });
  } finally {
    native.sqlite.close();
  }
  await measured.db.prepare("UPDATE members SET revoked_at=1 WHERE id='owner'").run();
  expect(
    (
      await new RawResourceReader(
        { db, blobs: memoryBlobStore() },
        { projectId: 'raw' },
        { kind: 'member', memberId: 'owner' },
      ).transcripts('s')
    ).transcripts,
  ).toEqual([]);
});

test('file continuation seeks each role before joining metadata and hides other uploaders', async () => {
  await project('files');
  await measured.db.prepare("UPDATE members SET revoked_at=NULL WHERE id='owner'").run();
  await measured.db
    .prepare("INSERT OR IGNORE INTO machine_claims(machine_id,member_id,claimed_at) VALUES('other-machine','other',1)")
    .run();
  for (const size of [1000, 4000]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO transcripts(project_id,transcript_id,session_id,machine_id,size,first_received_at,last_received_at,token_id,role)
      SELECT 'files',printf('file-%06d',x),'s',CASE WHEN x%3=0 THEN 'other-machine' ELSE 'machine' END,0,1,1,
        CASE WHEN x%3=0 THEN 'foreign' ELSE 'token' END,CASE WHEN x%2=0 THEN 'subagent' ELSE 'primary' END FROM n`,
      )
      .bind(size)
      .run();
    const read = (cursor?: string) =>
      new RawResourceReader(
        { db: measured.db, blobs: memoryBlobStore() },
        { projectId: 'files' },
        { kind: 'member', memberId: 'owner' },
      ).transcripts('s', { cursor });
    measured.reset();
    const first = await read();
    sample('file page', size);
    expect(first.cursor).not.toBeNull();
    const next = await read(first.cursor!);
    expect(next.cursor).not.toBeNull();
    const ids = [...first.transcripts, ...next.transcripts].map((row) => row.transcriptId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => Number(id.slice(5)) % 3 !== 0)).toBe(true);
    measured.reset();
    const late = await read(`0:file-${String(size - 20).padStart(6, '0')}`);
    expect(late.transcripts.length).toBeGreaterThan(0);
    sample('late file page', size);
  }
  expectFlat('file page', 'late file page');
});

test('processed body proof changes queue the affected receipt before the next safety deadline', async () => {
  await project('proof');
  await measured.db
    .prepare(
      "INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation) VALUES('proof','body',1,'text/plain','token',1,'00000000-0000-4000-8000-000000000001')",
    )
    .run();
  await measured.db
    .prepare(
      "INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,blob_key,content_hash,status,created_at,updated_at,token_id,received_at) VALUES('proof','p','s','e','machine','body','h','active',1,1,'token',1)",
    )
    .run();
  await measured.db
    .prepare(
      "INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at) SELECT project_id,'m',record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='proof'",
    )
    .run();
  while ((await prepareEmbeddingDue(measured.db, 'proof', 'm')).more);
  expect(await hasEmbeddingWork(measured.db, 'proof', 'm', 100)).toBe(false);
  await measured.db.prepare("DELETE FROM processed_resources WHERE project_id='proof' AND resource_id='p'").run();
  expect(await hasEmbeddingWork(measured.db, 'proof', 'm', 101)).toBe(true);
  expect((await retiringReceipt(measured.db, 'proof', ['m'], 101))?.id).toBe('p');
});

test('removed models retire through their receipt range without copying their history into the queue', async () => {
  const perReceipt: number[] = [];
  for (const size of [32, 128]) {
    const removed = `removed-${size}`;
    await project(removed);
    await measured.db
      .prepare(
        `${seq} INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
      SELECT ?2,printf('p-%06d',x),'s','e','machine','body','h','active',1,1,'token',1 FROM n`,
      )
      .bind(size, removed)
      .run();
    const sources = (
      await measured.db
        .prepare("SELECT record_id,revision FROM embedding_versions WHERE project_id=?").bind(removed)
        .all<{ record_id: string; revision: string }>()
    ).results;
    const receipts = await Promise.all(
      sources.map(async (row) => [
        await vectorId({ projectId: removed, modelKey: 'old' }, 'plan', row.record_id, row.revision),
        row.record_id,
        row.revision,
      ]),
    );
    await measured.db
      .prepare(
        `INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
      SELECT ?2,'old',json_extract(value,'$[0]'),'plan',json_extract(value,'$[1]'),json_extract(value,'$[2]'),1,1 FROM json_each(?1)`,
      )
      .bind(JSON.stringify(receipts), removed)
      .run();
    expect(await measured.db.prepare('SELECT COUNT(*) AS n FROM embedding_retirement_queue WHERE project_id=?').bind(removed).first()).toEqual({
      n: 0,
    });
    const context = {
      db: measured.db,
      blobs: memoryBlobStore(),
      vectors: cloudflareVectorStore(indexFixture()),
      provider: {
        modelKey: 'new',
        embed: async () => {
          throw new Error('retirement called provider');
        },
      },
      retireOnly: true,
    };
    measured.reset();
    for (let step = 0; step < size * 2; step++) await reconcileEmbedding(context, removed, 100 + step * 100000);
    report('removed model retirement', size);
    perReceipt.push(measured.writes() / size);
    expect(await measured.db.prepare('SELECT COUNT(*) AS n FROM embedding_receipts WHERE project_id=?').bind(removed).first()).toEqual({ n: 0 });
  }
  // Each retired receipt costs the same writes however many the model held.
  expect(perReceipt[1]!).toBeLessThanOrEqual(perReceipt[0]!);
});

test('segment continuation merges archived and hot pieces at tied offsets', async () => {
  await project('segments');
  await measured.db
    .prepare(
      "INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,first_received_at,last_received_at,token_id) VALUES('segments','t','s','machine',6,1,1,'token')",
    )
    .run();
  for (const offset of [0, 2, 4])
    await measured.db
      .prepare(
        "INSERT INTO transcript_segments(project_id,transcript_id,base_offset,length,blob_key,event_id,created_at,received_at,token_id) VALUES('segments','t',?,1,?,'e',1,1,'token')",
      )
      .bind(offset, 'hot-' + offset)
      .run();
  for (const offset of [1, 2, 3, 5])
    await measured.db
      .prepare(
        "INSERT INTO raw_archive_refs(project_id,source_kind,source_id,session_id,archive_key,size,received_at,transcript_id,base_offset,length,created_at,token_id,disposition,eligible_at) VALUES('segments','transcript',?,'s',?,1,1,'t',?,1,1,'token','archived',1)",
      )
      .bind('archived-' + offset, 'archived-' + offset, offset)
      .run();
  for (const limit of [1, 2, 3, 7]) {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const held = await pageSegments(measured.db, { projectId: 'segments' }, 't', { limit, cursor });
      keys.push(...held.rows.map((row) => row.baseOffset + ':' + row.availability));
      cursor = held.cursor ?? undefined;
    } while (cursor !== undefined);
    expect(keys).toEqual(['0:hot', '1:archived', '2:archived', '2:hot', '3:archived', '4:hot', '5:archived']);
  }
});
