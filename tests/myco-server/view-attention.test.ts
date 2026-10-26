import { expect, it } from 'bun:test';
import { OUTCOME_LOOKBACK_MS, recordViewReadRefusal, viewReadRefusalFinding, VIEW_READ_REFUSAL_KEY } from '@myco-server-worker/core/attention-state.js';
import { readAttention } from '@myco-server-worker/core/attention.js';
import { statusMetadata } from '@myco-server-worker/read/meta.js';
import { withViewReadResponse } from '@myco-server-worker/read/view-store.js';
import { listTurns } from '@myco-server-worker/read/turns.js';
import {listSessions} from '@myco-server-worker/read/sessions.js';
import {activityFeed} from '@myco-server-worker/read/activity.js';
import {sessionLineage} from '@myco-server-worker/read/lineage.js';
import {receiptPlans} from '@myco-server-worker/read/view-store.js';
import { captureViewSession, withViewStores } from './helpers/view-stores.js';
import { mirrorViewSession, publishMirroredSession } from './helpers/view-instances.js';
import { statementRecorder } from '../helpers/statement-recorder.js';
import { sqliteEnv } from './helpers/fixtures.js';
import {uuid} from './helpers/fixtures.js';

const NOW = 1_700_000_000_000;
const scope = { projectId: 'project' };

it('scalar and receipt admissions persist one finding for each observed malformed closure',async()=>{
 await withViewStores(async(db,target)=>{
  await captureViewSession(db);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'parent',state:'frozen'});
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'tail',parent:'parent',state:'live'},false);
  await publishMirroredSession(db,scope.projectId,'session','tail');
  const readers=[
   (bound:typeof db)=>listSessions(bound,scope,{fidelity:'any'}),
   (bound:typeof db)=>activityFeed(bound,scope),
   (bound:typeof db)=>sessionLineage(bound,scope,'session'),
   (bound:typeof db)=>receiptPlans(bound,scope,[{receiptId:'historical',planIds:[uuid(50)]}]),
  ];
  for(const [index,reader]of readers.entries()){
   await expect(withViewReadResponse<unknown>(db,()=>NOW+index,reader)).rejects.toMatchObject({code:'view_state_inconsistent'});
   expect(viewReadRefusalFinding((await statusMetadata(db)).viewReadRefusal,NOW+index),target+' reader '+index)
    .toMatchObject({refusals:index+1,lastRefusedAt:NOW+index});
  }
 });
},60_000);

it('status metadata adds one exact-key search while preserving empty rows-read and statement counts', async () => {
  await withViewStores(async (db, target) => {
    const observed = statementRecorder(db, { accounting: target === 'D1' ? 'd1' : 'native' });
    const before = await observed.db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).first<{ value: string }>();
    const baseline = observed.statements[0]!;
    observed.reset();
    expect(await statusMetadata(observed.db)).toEqual({ version: Number(before!.value), viewReadRefusal: null });
    expect(observed.statements).toHaveLength(1);
    const after = observed.statements[0]!;
    if (target === 'D1') expect(after.rowsRead).toBe(baseline.rowsRead);
    else expect(after.rowsRead).toBeUndefined();
    const explain = async (sql: string) => (await db.prepare('EXPLAIN QUERY PLAN ' + sql).all<{ detail: string }>()).results.map(row => row.detail);
    const plans = { baseline: await explain(baseline.sql), metadata: await explain(after.sql) };
    expect(plans.metadata.filter(detail => /SEARCH schema_meta/.test(detail))).toHaveLength(2);
    console.info('VIEW_STATUS_METADATA', JSON.stringify({ target, rowsRead: after.rowsRead, plans }));
  });
}, 60_000);

it('refusal attention survives another session revalidating and expires without a write', async () => {
  const base = sqliteEnv();
  await withViewStores(async (db, target) => {
    for (const [session, offset] of [['x', 0], ['y', 100]] as const) {
      await captureViewSession(db, 'project', session, { idOffset: offset });
      await mirrorViewSession(db, { ...scope, sessionId: session, instanceId: session + '-parent', state: 'frozen' });
      await mirrorViewSession(db, { ...scope, sessionId: session, instanceId: session + '-tail', state: 'live', parent: session + '-parent' }, false);
      await publishMirroredSession(db, 'project', session, session + '-tail');
    }
    const observed = statementRecorder(db, { accounting: target === 'D1' ? 'd1' : 'native' });
    const read = (session: string, now: number) => withViewReadResponse(observed.db, () => now, bound => listTurns(bound, scope, session));
    await expect(read('x', NOW)).rejects.toMatchObject({ code: 'view_state_inconsistent' });
    await expect(read('y', NOW + 1)).rejects.toMatchObject({ code: 'view_state_inconsistent' });
    await publishMirroredSession(db, 'project', 'y', 'y-tail', 'y-parent');
    await read('y', NOW + 2);
    const metadata = await statusMetadata(db);
    expect(viewReadRefusalFinding(metadata.viewReadRefusal, NOW + 2)).toMatchObject({ kind: 'view_state_inconsistent', refusals: 2, lastRefusedAt: NOW + 1 });
    observed.reset();
    const env = { ...base.serverEnv, db: observed.db };
    const attention = await readAttention(env, NOW + 2);
    expect(attention.items.filter(item => item.kind === 'view_state_inconsistent')).toEqual([viewReadRefusalFinding(metadata.viewReadRefusal, NOW + 2)!]);
    expect(observed.statements.filter(entry => entry.sql.includes('AS __myco_status_refusal'))).toHaveLength(1);
    expect(observed.statements.some(entry => /\b(?:session_views|view_visible)\b/.test(entry.sql))).toBe(false);
    expect(observed.statements.some(entry => /^(?:INSERT|UPDATE|DELETE)\b/i.test(entry.sql.trim()))).toBe(false);
    expect(viewReadRefusalFinding(metadata.viewReadRefusal, NOW + 1 + OUTCOME_LOOKBACK_MS)).not.toBeNull();
    expect(viewReadRefusalFinding(metadata.viewReadRefusal, NOW + 2 + OUTCOME_LOOKBACK_MS)).toBeNull();
    expect((await statusMetadata(db)).viewReadRefusal).toBe(metadata.viewReadRefusal);
    await expect(read('x', NOW + 3 + OUTCOME_LOOKBACK_MS)).rejects.toMatchObject({ code: 'view_state_inconsistent' });
    expect(viewReadRefusalFinding((await statusMetadata(db)).viewReadRefusal, NOW + 3 + OUTCOME_LOOKBACK_MS)?.refusals).toBe(1);
  });
}, 60_000);

it('the refusal rule and schema rule report their own availability from their shared read', async () => {
  const { db, serverEnv } = sqliteEnv();
  await db.prepare('INSERT INTO schema_meta(key,value) VALUES(?,?)').bind(VIEW_READ_REFUSAL_KEY, 'malformed').run();
  const attention = await readAttention(serverEnv, NOW);
  expect(attention.unavailable).toContain('view_state_inconsistent');
  expect(attention.unavailable).not.toContain('schema_mismatch');
  await db.prepare('DELETE FROM schema_meta WHERE key=?').bind(VIEW_READ_REFUSAL_KEY).run();
  const broken = { ...db, prepare: (sql: string) => {
    if (sql.includes('AS __myco_status_refusal')) throw new Error('unreadable metadata');
    return db.prepare(sql);
  } };
  const failed = await readAttention({ ...serverEnv, db: broken }, NOW);
  expect(failed.unavailable).toContain('view_state_inconsistent');
  expect(failed.unavailable).toContain('schema_mismatch');
  await expect(recordViewReadRefusal(broken, { projectId: 'project', sessionId: 'session', fence: 1, code: 'view_state_inconsistent' }, NOW)).resolves.toBeUndefined();
});
