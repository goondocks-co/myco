import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { advanceSessionDeletions, acceptSessionDeletion, deletionProgress } from '@myco-server-worker/db/sessions/deletion.js';
import { advanceRereads, requestReread } from '@myco-server-worker/db/documents/reread.js';
import { measuredStore } from './helpers/read-budget.js';

const NOW = 10_000_000_000;
const seq = (from: number, to: number) => `WITH RECURSIVE n(i) AS (SELECT ${from} UNION ALL SELECT i+1 FROM n WHERE i<${to})`;

async function seed(db: D1Database, session: string, events: number): Promise<void> {
  await db.batch([
    db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_1',?,'m','t',1,1)`).bind(session),
    db.prepare(`INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES('proj_1',?,'live',1,1)`).bind(session),
  ]);
  await db.prepare(`${seq(1, events)} INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
    SELECT 'proj_1',?||'-e'||i,?,'t','prompt','cli',json_object('promptId','p'||i,'text','x','origin','user'),'h',i,i FROM n`).bind(session, session).run();
  await db.prepare(`${seq(1, events)} INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,first_received_at,last_received_at,token_id,prompt_identity_scheme)
    SELECT 'proj_1',?||'-t'||i,?,'m','codex',1,0,0,'t','offset-v1' FROM n WHERE i<=64`).bind(session, session).run();
}

/** Reads for one wake of one deletion step at this scale, against a session whose rows already fill the phase being paged. */
async function measure(db: D1Database, session: string, events: number) {
  await seed(db, session, events);
  await acceptSessionDeletion(db as never, { projectId: 'proj_1', sessionId: session, by: 'owner', now: NOW });
  for (let walk = 0; walk < 500; walk += 1) { // Reach the events phase.
    const phase = await db.prepare(`SELECT phase FROM session_deletion_jobs WHERE session_id=?`).bind(session).first<{ phase: string }>();
    if (phase?.phase === 'events') break;
    await advanceSessionDeletions(db as never, NOW, 1);
  }
  const measured = measuredStore(db);
  await advanceSessionDeletions(measured.db as never, NOW, 1);
  const stepReads = measured.reads();
  measured.reset();
  await deletionProgress(measured.db as never, 'proj_1', session, NOW);
  const progressReads = measured.reads();
  return { stepReads, progressReads };
}

it('a deletion step and a progress read cost the same whatever the session holds, on D1', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
    await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','Project',1)").run();
    const small = await measure(db, 'small', 1_000);
    const large = await measure(db, 'large', 10_000);
    expect(large.progressReads).toBe(small.progressReads);
    expect(large.stepReads).toBeLessThanOrEqual(small.stepReads + 16);
    expect(small.stepReads).toBeGreaterThan(0);

    await requestReread(db as never, { agent: 'codex' }, 'owner', NOW);
    const reread = measuredStore(db);
    await advanceRereads(reread.db as never, NOW);
    const firstPage = reread.reads();
    reread.reset();
    await advanceRereads(reread.db as never, NOW + 1);
    expect(reread.reads()).toBeLessThanOrEqual(firstPage + 16);
  } finally { await mf.dispose(); }
}, 180_000);
