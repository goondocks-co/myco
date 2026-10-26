import { expect, it } from 'bun:test';
import { listTurns, promptInSession, turnDetail, turnCollection, TURN_COLLECTIONS, toolUsage, sessionTurnContexts } from '@myco-server-worker/read/turns.js';
import { listPrompts, listResponses, listToolCalls, listPlans, listAttachments, listContextInjections, sessionMaterialRows, sessionMaterialTailRows } from '@myco-server-worker/read/children.js';
import { listUnplacedHookRecords } from '@myco-server-worker/read/hook-placement.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { captureViewSession, withViewStores } from './helpers/view-stores.js';
import { keepSurvivingFacts, mirrorViewSession, publishMirroredSession, removeViewMaterialRows, setViewLayerValues, updateViewSearchText } from './helpers/view-instances.js';
import { memoryBlobStore, recordingLimiter, uuid } from './helpers/fixtures.js';
import { withViewReadResponse } from '@myco-server-worker/read/view-store.js';
import { writeGuardStore } from '@myco-server-worker/core/write-guard-store.js';
import { statementRecorder } from '../helpers/statement-recorder.js';
import worker from '@myco-server-worker/index.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

const scope = { projectId: 'project' };
const session = 'session';

async function conversation(db: RelationalStore): Promise<string> {
  const values: unknown[] = [];
  for (const order of ['ASC', 'DESC'] as const) {
    const first = await listTurns(db, scope, session, { order, limit: 1 });
    values.push(first);
    if (first.cursor !== null) values.push(await listTurns(db, scope, session, { order, limit: 1, cursor: first.cursor }));
  }
  values.push(await promptInSession(db, scope, session, uuid(20)), await turnDetail(db, scope, session, uuid(20)),
    await toolUsage(db, scope, session), await sessionTurnContexts(db, scope, session));
  for (const collection of TURN_COLLECTIONS) values.push(await turnCollection(db, scope, session, uuid(20), collection, { limit: 1 }));
  for (const read of [listPrompts, listResponses, listToolCalls, listPlans, listAttachments, listContextInjections]) values.push(await read(db, scope, session));
  values.push(await listUnplacedHookRecords(db, scope, session),
    await sessionMaterialRows(db, scope.projectId, session, { limit: 2, excerptChars: 20 }),
    await sessionMaterialTailRows(db, scope.projectId, session, { limit: 2, excerptChars: 20 }));
  return JSON.stringify(values);
}

it('turn sources preserve the independent captured result with poisoned and gone originals, including a frozen parent', async () => {
  await withViewStores(async (db, target) => {
    await captureViewSession(db);
    const expected = await conversation(db);
    await mirrorViewSession(db, { ...scope, sessionId: session, instanceId: 'parent', state: 'frozen' });
    await mirrorViewSession(db, { ...scope, sessionId: session, instanceId: 'tail', state: 'live', parent: 'parent' }, false);
    await publishMirroredSession(db, scope.projectId, session, 'tail', 'parent');
    expect(await conversation(db), target + ' parent').toBe(expected);
    await db.batch([
      db.prepare(`UPDATE prompt_batches SET text='poison prompt',origin='system',parent_prompt_id='missing',created_at=999,updated_at=999 WHERE project_id='project'`),
      db.prepare(`UPDATE responses SET text='poison response',prompt_id='missing',created_at=999 WHERE project_id='project'`),
      db.prepare(`UPDATE tool_calls SET tool_name='Poison',input='poison',prompt_id='missing',success=0,created_at=999 WHERE project_id='project'`),
      db.prepare(`UPDATE plans SET title='poison',content='poison',status='completed',prompt_id='missing',created_at=999,updated_at=999 WHERE project_id='project'`),
    ]);
    expect(await conversation(db), target + ' poison').toBe(expected);
    await db.batch(['prompt_batches', 'responses', 'tool_calls', 'plans'].map(table => db.prepare(`DELETE FROM ${table} WHERE project_id='project'`)));
    expect(await conversation(db), target + ' gone').toBe(expected);
    expect(await listTurns(db, { projectId: 'other' }, session)).toEqual({ rows: [], cursor: null });
  });
}, 60_000);

it('the HTTP turn collection keeps its admission source across a publication flip', async () => {
  await withViewStores(async (db, target) => {
    await captureViewSession(db);
    await db.prepare("UPDATE members SET github_id='100001',role='admin' WHERE id='member'").run();
    await mirrorViewSession(db, { ...scope, sessionId: session, instanceId: 'first', state: 'live' });
    await publishMirroredSession(db, scope.projectId, session, 'first');
    await mirrorViewSession(db, { ...scope, sessionId: session, instanceId: 'second', state: 'building' });
    await updateViewSearchText(db, scope.projectId, 'second', 'next response');
    let flipped = false;
    const recorded = statementRecorder(db, { accounting: target === 'D1' ? 'd1' : 'native', after: async entry => {
      if (flipped || !entry.sql.includes('SELECT 1 AS present FROM prompt_batches') || !entry.sql.includes('__myco_pins AS MATERIALIZED')) return;
      flipped = true;
      await publishMirroredSession(db, scope.projectId, session, 'second');
    } });
    const cookie = await ownerCookie(db, Date.now(), '100001');
    const env = { MYCO_DB: recorded.db, BUCKET: memoryBlobStore(), SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter(), ...OWNER_ENV };
    const response = await worker.fetch(new Request(`https://s/api/projects/project/sessions/session/turns/${uuid(20)}?collection=responses`, {
      headers: { cookie, 'cf-connecting-ip': '1.2.3.4' },
    }), env);
    expect(response.status, target).toBe(200);
    expect(flipped, target + ' admission control reached').toBe(true);
    expect(await response.json(), target).toMatchObject({ rows: [{ text: 'factcanary' }] });
    expect(recorded.statements.filter(entry => entry.sql.includes('FROM session_views sv')).length, target + ' one capture').toBe(1);
    expect((await listResponses(db, scope, session)).rows[0]?.text, target + ' next response control').toBe('next response');
  });
}, 60_000);

it('selected row identity survives a fact promotion between admission and hydration', async () => {
  await withViewStores(async (db, target) => {
    await captureViewSession(db);
    await mirrorViewSession(db, { ...scope, sessionId: session, instanceId: 'first', state: 'live' });
    await setViewLayerValues(db, scope.projectId, 'first', 'selected source');
    await publishMirroredSession(db, scope.projectId, session, 'first');
    await withViewReadResponse(db, () => 1, async bound => {
      expect(await promptInSession(bound, scope, session, uuid(20)), target).toBe(true);
      await keepSurvivingFacts(db, scope.projectId, session);
      expect((await listPrompts(bound, scope, session)).rows[0]?.text, target).toBe('selected source');
    });
    expect((await listPrompts(db, scope, session)).rows[0]?.text, target + ' new response control').toBe('factcanary');
  });
}, 60_000);

it('admission and collection hydration retain one response closure through a flip and a store decorator', async () => {
  await withViewStores(async (db, target) => {
    await captureViewSession(db);
    await mirrorViewSession(db, { ...scope, sessionId: session, instanceId: 'first', state: 'live' });
    await publishMirroredSession(db, scope.projectId, session, 'first');
    await mirrorViewSession(db, { ...scope, sessionId: session, instanceId: 'second', state: 'building' });
    await updateViewSearchText(db, scope.projectId, 'second', 'new generation');
    let assertions = 0;
    await withViewReadResponse(db, () => 1_700_000_000_000, async bound => {
      const guarded = writeGuardStore(bound, () => { assertions++; return bound.prepare('SELECT 1'); }, error => { throw error; });
      expect(await promptInSession(guarded, scope, session, uuid(20)), target).toBe(true);
      await publishMirroredSession(db, scope.projectId, session, 'second');
      expect((await listPrompts(guarded, scope, session)).rows[0]?.text, target).toBe('factcanary');
      expect(assertions, target + ' SELECT remains a read').toBe(0);
    });
    expect((await listPrompts(db, scope, session)).rows[0]?.text, target + ' control').toBe('new generation');
  });
}, 60_000);

it('surviving facts beat live rows, and live rows hide frozen duplicates before origin and status filters', async () => {
  await withViewStores(async (db, target) => {
    await captureViewSession(db);
    await mirrorViewSession(db, { ...scope, sessionId: session, instanceId: 'parent', state: 'frozen' });
    await mirrorViewSession(db, { ...scope, sessionId: session, instanceId: 'tail', state: 'live', parent: 'parent' });
    await setViewLayerValues(db, scope.projectId, 'parent', 'parent');
    await setViewLayerValues(db, scope.projectId, 'tail', 'live');
    await publishMirroredSession(db, scope.projectId, session, 'tail', 'parent');
    const values = async () => [
      (await listPrompts(db, scope, session)).rows[0]?.text,
      (await listResponses(db, scope, session)).rows[0]?.text,
      (await listToolCalls(db, scope, session)).rows[0]?.toolName,
      (await listPlans(db, scope, session)).rows[0]?.title,
    ];
    expect(await values(), target + ' live').toEqual(['live', 'live', 'live', 'live']);
    expect((await listTurns(db, scope, session, { origins: ['parent'] })).rows, target + ' losing origin').toEqual([]);
    expect((await listPlans(db, scope, session, { status: 'parent' })).rows, target + ' losing status').toEqual([]);
    await keepSurvivingFacts(db, scope.projectId, session);
    expect(await values(), target + ' fact').toEqual(['factcanary', 'factcanary', 'Read', null]);
    expect((await listTurns(db, scope, session, { origins: ['live'] })).rows, target + ' hidden live').toEqual([]);
    await publishMirroredSession(db, scope.projectId, session, 'tail', 'parent');
    await removeViewMaterialRows(db, scope.projectId, 'tail');
    expect(await values(), target + ' parent').toEqual(['parent', 'parent', 'parent', 'parent']);
  });
}, 60_000);

it('a published handle refuses a missing frozen parent', async () => {
  await withViewStores(async db => {
    await captureViewSession(db);
    await mirrorViewSession(db, { ...scope, sessionId: session, instanceId: 'parent', state: 'frozen' });
    await mirrorViewSession(db, { ...scope, sessionId: session, instanceId: 'tail', state: 'live', parent: 'parent' }, false);
    await publishMirroredSession(db, scope.projectId, session, 'tail');
    await expect(listTurns(db, scope, session)).rejects.toMatchObject({ code: 'view_state_inconsistent' });
  });
}, 60_000);
