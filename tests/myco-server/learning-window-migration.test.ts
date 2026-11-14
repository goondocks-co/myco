import { expect, it } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { NEXT_LEARNING_WINDOW } from '@myco-server-worker/db/schema-vNEXT-learning-window.js';
import { LEARNING_WINDOW_MS } from '@myco-server-worker/db/runs/learning-policy.js';
import { readLearningStatus } from '@myco-server-worker/core/learning-sessions.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { withDocumentStores } from './helpers/document-stores.js';

it('closes a released history backlog, retains its cards, and archives the retired setting with attribution', async () => {
  await withDocumentStores(async db => {
    const now = Date.now();
    await db.prepare("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.learning_history_enabled','true',123,'owner')").run();
    for (const [session, source, aged] of [['history', now - 2 * 86_400_000, 1], ['outside', now - LEARNING_WINDOW_MS - 1000, 0], ['current', now, 0]] as const) {
      await db.prepare("INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at) VALUES('project',?,'ready',?)").bind(session, source).run();
      await db.prepare("INSERT INTO turn_cards(project_id,session_id,turn_key,created_at,due_at) VALUES('project',?,'turn',?,?)").bind(session, source, now).run();
      await db.prepare('UPDATE learning_sessions SET aged=?,card_promoted_at=card_deadline WHERE session_id=?').bind(aged, session).run();
    }
    for (const step of SCHEMA_STEPS.filter(step => step.version >= NEXT_LEARNING_WINDOW)) await db.batch(step.statements.map(sql => db.prepare(sql)));
    const states = (await db.prepare('SELECT session_id,aged_out_at FROM learning_sessions ORDER BY session_id').all()).results as {session_id: string; aged_out_at: number | null}[];
    expect(states.map(row => [row.session_id, row.aged_out_at !== null])).toEqual([['current', false], ['history', true], ['outside', true]]);
    expect(await readLearningStatus(db, now + 1000)).toMatchObject({ agedOutSessions: 2, turnsAwaitingCards: 1, dueCards: 0 });
    expect((await db.prepare('SELECT session_id,state FROM turn_cards ORDER BY session_id').all()).results)
      .toEqual(['current', 'history', 'outside'].map(session_id => ({ session_id, state: 'pending' })));
    expect(await db.prepare("SELECT value,updated_at,updated_by FROM retired_deployment_settings WHERE leaf='agent.learning_history_enabled'").first())
      .toEqual({ value: 'true', updated_at: 123, updated_by: 'owner' });
    expect(await db.prepare("SELECT value FROM deployment_settings WHERE leaf='agent.learning_history_enabled'").first()).toBeNull();
    expect(await settingsWriter(db).setLeaf('agent.learning_history_enabled', true, 'owner', now)).toMatchObject({ applied: false, refusal: { reason: 'not_deployment_tier' } });
    expect(await settingsWriter(db).resetLeaf('agent.learning_history_enabled', 'owner', now)).toMatchObject({ applied: false, refusal: { reason: 'not_deployment_tier' } });
  }, NEXT_LEARNING_WINDOW - 1);
});
