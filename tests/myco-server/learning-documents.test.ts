import { expect, it } from 'bun:test';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { processedBody } from '@myco-server-worker/read/processed.js';
import { documentTurn } from '@myco-server-worker/content/turn-material.js';
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

it('a transcript plan larger than a page preview keeps its whole body in the canonical plan', async () => {
  await withViewStores(async (db, name) => withViewWriterDriver(async () => {
    const t0 = Date.now() - 2 * 60 * MIN;
    const blobs = memoryBlobStore();
    const body = `# Ship the release\n${'step '.repeat(60_000)}last step`;
    const text = user('turn-0', 'Plan the release') + reply(`<proposed_plan>\n${body}\n</proposed_plan>`) + user('turn-1', 'continue');
    const env = await captureViewTranscript(db, blobs, 'session', 'tx_' + 'c'.repeat(32), text, t0, 0, 'codex');
    await publishDocuments(env, t0 + 11 * MIN, { calls: 500, deadline: Date.now() + 60_000, clock: Date.now });

    const plan = (await db.prepare(`SELECT plan_key, content, blob_key, content_hash FROM plans WHERE session_id = 'session'`)
      .first<{ plan_key: string; content: string | null; blob_key: string | null; content_hash: string }>())!;
    expect({ content: plan.content, digest: plan.blob_key === plan.content_hash }, name).toEqual({ content: null, digest: true });
    expect(await db.prepare(`SELECT kind FROM processed_resources WHERE resource_id = ? AND blob_key = ?`).bind(plan.plan_key, plan.blob_key).first(), name)
      .toEqual({ kind: 'plan' });
    const read = await processedBody({ db, blobs }, { projectId: 'project' }, 'plan', plan.plan_key);
    expect({ length: read?.length, end: read?.endsWith('last step') }, name).toEqual({ length: body.length, end: true });
  }));
});

it('a turn past the page budget is never carded by rule, and falls due with its tail', async () => {
  await withViewStores(async (db, name) => withViewWriterDriver(async () => {
    const t0 = Date.now() - 2 * 60 * MIN;
    const line = (value: Record<string, unknown>, at: number) => JSON.stringify({ ...value, timestamp: new Date(at).toISOString() }) + '\n';
    const call = (id: string, tool: string, input: Record<string, unknown>, result: string, failed: boolean, at: number) =>
      line({ type: 'assistant', uuid: `c-${id}`, message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] } }, at)
      + line({ type: 'user', uuid: `r-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, ...(failed ? { is_error: true } : {}) }] } }, at + 1);
    const write = (i: number) => call(`write-${i}`, 'Write', { path: `notes-${i}.md`, content: `${i}`.repeat(240_000) }, 'written', false, t0 + 2 * i + 1);
    const failure = (at: number) => call('bash-1', 'Bash', { command: 'make release' }, 'release failed: tag exists', true, at);
    // Each large write fills a page: after six of them the failed call sits on the last page, and after four of them it
    // sits between the pages read at the turn's head and its last page.
    const cases = {
      last: [0, 1, 2, 3, 4, 5].map(write).join('') + failure(t0 + 20),
      middle: [0, 1, 2, 3].map(write).join('') + failure(t0 + 9) + [4, 5, 6].map(write).join(''),
    };
    for (const [where, turn] of Object.entries(cases)) {
      const session = `session-${where}`;
      const text = line({ type: 'user', uuid: `u-0-${where}`, message: { role: 'user', content: 'continue' } }, t0) + turn
        + line({ type: 'user', uuid: `u-1-${where}`, message: { role: 'user', content: 'Ship the release' } }, t0 + 30);
      const env = await captureViewTranscript(db, memoryBlobStore(), session, 'tx_' + (where === 'last' ? 'b' : 'd').repeat(32), text, t0, 0, 'claude-code');
      for (let wake = 0; wake < 4; wake++) await publishDocuments(env, t0 + 11 * MIN, { calls: 500, deadline: Date.now() + 60_000, clock: Date.now });

      expect(await db.prepare(`SELECT failed_tools FROM session_documents WHERE session_id = ?`).bind(session).first(), name).toEqual({ failed_tools: 1 });
      const [first] = (await db.prepare(`SELECT p.prompt_id, c.state, c.signal_reason, c.due_at IS NOT NULL AS due FROM session_prompts p
        JOIN turn_cards c ON c.project_id = p.project_id AND c.session_id = p.session_id AND c.turn_key = p.prompt_id
        WHERE p.session_id = ? AND p.turn_key = p.prompt_id ORDER BY p.ord LIMIT 1`).bind(session)
        .all<{ prompt_id: string; state: string; signal_reason: string | null; due: number }>()).results;
      expect({ where, state: first!.state, reason: first!.signal_reason, due: first!.due }, name).toEqual({ where, state: 'pending', reason: null, due: 1 });
      const read = (await documentTurn(env, 'project', session, first!.prompt_id))!;
      expect({ where, complete: read.complete }, name).toEqual({ where, complete: false });
      // The model's material is read at the turn's head and its last page.
      if (where === 'last') expect(read.input.tools.filter((tool) => !tool.success).map((tool) => tool.errorMessage), name).toEqual(['release failed: tag exists']);
    }
  }));
});

it('a card claim reads the same catalog rows whatever the session holds', async () => {
  await withViewStores(async (db, name) => {
    // Every turn is created and falls due at one instant, and as many again are postponed past now.
    const claim = async (session: string, turns: number) => {
      await db.prepare(`INSERT INTO turn_cards (project_id, session_id, turn_key, due_at, input_chars, created_at)
        SELECT 'project', ?, 'turn-' || value, CASE WHEN value % 2 = 0 THEN 1 ELSE ? END, 10, 1 FROM json_each(?)`)
        .bind(session, NOW + 60_000, JSON.stringify(Array.from({ length: 2 * turns }, (_, i) => i))).run();
      let rowsRead = 0;
      let statements = 0;
      const count = (statement: PreparedStatement): PreparedStatement => ({
        bind: (...values: unknown[]) => count(statement.bind(...values)),
        first: async <T,>() => { statements += 1; return statement.first<T>(); },
        all: async <T,>() => {
          statements += 1;
          const result = await statement.all<T>();
          rowsRead += (result as { meta?: { rows_read?: number } }).meta?.rows_read ?? 0;
          return result;
        },
        run: () => { statements += 1; return statement.run(); },
      }) as PreparedStatement;
      const counted = { ...db, prepare: (sql: string) => count(db.prepare(sql)) } as RelationalStore;
      const input = await buildCardInput({ db: counted }, 'project', session, NOW);
      return { rowsRead, statements, turns: (input?.counts as { turns: number }).turns };
    };
    const small = await claim('small', 2 * CARD_CLAIM_TURNS);
    expect({ statements: small.statements, turns: small.turns }, name).toEqual({ statements: 1, turns: CARD_CLAIM_TURNS });
    // D1 reports the rows each statement read; the native store reports none.
    if (name === 'D1') expect(small.rowsRead, name).toBeLessThanOrEqual(CARD_CLAIM_TURNS + 1);
    expect(await claim('large', 20 * CARD_CLAIM_TURNS), name).toEqual(small);
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
