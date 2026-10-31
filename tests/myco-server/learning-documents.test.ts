import { expect, it } from 'bun:test';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { buildCardInput } from '@myco-server-worker/core/learning-stages.js';
import { CARD_CLAIM_TURNS } from '@myco-server-worker/core/turn-cards.js';
import { captureViewTranscript } from './helpers/view-stores.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { claimNextRun } from '@myco-server-worker/core/harness.js';
import { completeBudgetMigration } from '@myco-server-worker/db/budget-activation.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { withViewStores } from './helpers/view-stores.js';
import { memoryBlobStore, recordingDeferred, recordingLimiter } from './helpers/fixtures.js';
import { withViewWriterDriver } from '../helpers/statement-recorder.js';
import { legacyWorker } from './helpers/worker-principal.js';
import { offeredHarness } from './helpers/offered-harness.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const item = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload }) + '\n';
const user = (turn: string, text: string) =>
  item('turn_context', { turn_id: turn }) + item('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const reply = (text: string) => item('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

it('the publisher settles cards, keeps transcript plans canonical and reopens a resumed session', async () => {
  await withViewStores(async (db, name) => withViewWriterDriver(async () => {
    const t0 = Date.now() - 2 * 60 * MIN;
    const blobs = memoryBlobStore();
    const text = user('turn-0', 'Plan the release') + reply('<proposed_plan>\n# Ship the release\nTag, then publish.\n</proposed_plan>') + user('turn-1', 'continue');
    const env = await captureViewTranscript(db, blobs, 'session', 'tx_' + 'a'.repeat(32), text, t0, 0, 'codex');
    await db.prepare(`UPDATE sessions SET ended_at = ? WHERE project_id = 'project' AND session_id = 'session'`).bind(t0 - 1).run();
    await publishDocuments(env, t0 + 11 * MIN, { calls: 500, deadline: Date.now() + 60_000, clock: Date.now });

    const turns = await db.prepare(`SELECT p.prompt_id, c.state, c.signal_reason, c.due_at IS NOT NULL AS due FROM session_prompts p
      JOIN turn_cards c ON c.project_id = p.project_id AND c.session_id = p.session_id AND c.turn_key = p.prompt_id
      WHERE p.session_id = 'session' AND p.turn_key = p.prompt_id ORDER BY p.ord`).all<{ prompt_id: string; state: string; signal_reason: string | null; due: number }>();
    // A turn holding a plan waits for a model; a mechanical one is carded by rule.
    expect(turns.results.map((row) => [row.state, row.signal_reason, row.due]), name).toEqual([['pending', null, 1], ['carded', 'no_human_text', 0]]);
    expect((await buildCardInput({ db }, 'project', 'session', t0 + 11 * MIN))?.counts, name).toEqual({ turns: 1 });
    expect(await db.prepare(`SELECT title, content, status FROM plans WHERE session_id = 'session'`).all(), name)
      .toMatchObject({ results: [{ title: 'Ship the release', content: expect.stringContaining('Tag, then publish.'), status: 'active' }] });
    expect(await db.prepare(`SELECT ended_at FROM sessions WHERE session_id = 'session'`).first(), name).toEqual({ ended_at: null });
  }));
});

it('a card claim reads the same catalog rows whatever the session holds', async () => {
  await withViewStores(async (db, name) => {
    const rowsRead = async (session: string, turns: number) => {
      await db.prepare(`INSERT INTO turn_cards (project_id, session_id, turn_key, due_at, input_chars, created_at)
        SELECT 'project', ?, 'turn-' || value, 1, 10, value FROM json_each(?)`).bind(session, JSON.stringify(Array.from({ length: turns }, (_, i) => i))).run();
      let rows = 0;
      let statements = 0;
      const count = (statement: PreparedStatement): PreparedStatement => ({
        bind: (...values: unknown[]) => count(statement.bind(...values)),
        first: async <T,>() => { statements += 1; const row = await statement.first<T>(); if (row !== null) rows += 1; return row; },
        all: async <T,>() => { statements += 1; const result = await statement.all<T>(); rows += result.results.length; return result; },
        run: () => { statements += 1; return statement.run(); },
      }) as PreparedStatement;
      const counted = { ...db, prepare: (sql: string) => count(db.prepare(sql)) } as RelationalStore;
      const input = await buildCardInput({ db: counted }, 'project', session, NOW);
      return { rows, statements, turns: (input?.counts as { turns: number }).turns };
    };
    const small = await rowsRead('small', 2 * CARD_CLAIM_TURNS);
    expect(small, name).toEqual({ rows: CARD_CLAIM_TURNS, statements: 1, turns: CARD_CLAIM_TURNS });
    expect(await rowsRead('large', 20 * CARD_CLAIM_TURNS), name).toEqual(small);
  });
});

it('an idle claim with learning off issues a small fixed number of statements', async () => {
  await withViewStores(async (db, name) => {
    const env = serverEnvFromBindings({ MYCO_DB: db, BUCKET: memoryBlobStore(), SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() } as never, recordingDeferred());
    await db.prepare(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.harnesses.claude-code.credential','"worker-login"',0,'test')`).run();
    await completeBudgetMigration(db, NOW);
    await ensureMember(db, 'mem_worker', NOW, 'admin');
    const principal = legacyWorker((await issueMemberToken(db, { memberId: 'mem_worker', machineId: 'm1' }, NOW)).tokenId, 'm1');
    // Card work is due, but learning is off.
    await db.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,due_at,created_at) VALUES('project','session','turn',1,1)`).run();
    const measured = measuredContentEnv({ ...env, db });
    const claim = await claimNextRun({ ...env, db: measured.env.db }, { principal, harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now: NOW + 1 });
    expect(claim, name).toMatchObject({ claimed: false });
    // Its settings, whether anything waits queued, the budget's activation, and the pulled stages' switches.
    expect(measured.usage.statements, name).toBe(4);
  });
});
