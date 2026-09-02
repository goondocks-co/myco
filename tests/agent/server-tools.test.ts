/**
 * The title run's tools against the real routes: a refused write is a tool
 * answer the model can act on, never a failed run; a caller holding no run is
 * told the session is not found.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { ServerClient } from '@myco/member/transport.js';
import { materializedSessionMaterialTool, materializedUpdateSessionTool } from '@myco/agent/runtime/server-tools.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';

const budget = { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 };
const textOf = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;

async function setup() {
  const e = sqliteEnv();
  const now = Date.now();
  e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.provider.type', '"anthropic"', ?, 'test')`, [now]);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ?)`, [now]);
  e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at) VALUES ('proj_1', 's1', 'm1', 'tok_1', ?, ?, 'claude-code', ?, ?)`, [now - 10_000, now, now - 10_000, now]);
  e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', 's1', 'p1', 'e1', 'hello', 'user', 'h1', ?, ?, 'tok_1', ?)`, [now - 9000, now - 9000, now - 9000]);
  await ensureMember(e.db, HARNESS_MEMBER_ID, now, 'harness runtime');
  const minted = await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, now);
  const clientFor = (token: string) => new ServerClient(
    { serverUrl: 'https://s', token, projectId: 'proj_1' },
    ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set('cf-connecting-ip', '1.2.3.4');
      return worker.fetch(request, e.env);
    }) as typeof fetch,
  );
  await recordDispatch(e.db, { projectId: 'proj_1' }, { id: 'run_1', agentId: 'myco-agent', task: 'title-summary', provider: 'anthropic', model: null, runContext: JSON.stringify({ session_id: 's1', mode: 'claim' }), dispatchedBy: minted.tokenId, startedAt: now });
  e.sqlite.run(`UPDATE agent_runs SET status = 'running' WHERE id = 'run_1'`);
  return { ...e, client: clientFor(minted.token) };
}

describe('the title run\'s tools', () => {
  it('read the material, answer a refused write as a tool error, and write when the title fits', async () => {
    const { client, sqlite } = await setup();
    const ctx = { client, budget, runId: 'run_1', agentId: 'myco-agent' };
    const counter = { writes: 0 };
    const material = textOf(await materializedSessionMaterialTool(ctx).handler({ session_id: 's1' }, {}));
    expect({ status: material.status, batches: material.batches }).toEqual({ status: 'completed', batches: [{ prompt_number: 1, user_prompt: 'hello', response_excerpt: null }] });

    const update = materializedUpdateSessionTool(ctx, counter);
    expect(textOf(await update.handler({ session_id: 's1', title: 't'.repeat(81), summary: 'ok' }, {})).error).toContain('a title is 1 to 80 characters');
    expect(textOf(await update.handler({ session_id: 's1', title: 'Half' }, {})).error).toContain('both title and summary are required');
    expect(textOf(await update.handler({ session_id: 's_other', title: 'T', summary: 'S' }, {})).error).toBe('Session not found: s_other');
    expect(counter.writes).toBe(0);

    expect(textOf(await update.handler({ session_id: 's1', title: 'Retry added', summary: 'Added a retry.' }, {}))).toEqual({ session_id: 's1', title: 'Retry added', summary: 'Added a retry.' });
    expect(counter.writes).toBe(1);
    expect(sqlite.query(`SELECT title, summary FROM sessions WHERE session_id = 's1'`).get()).toEqual({ title: 'Retry added', summary: 'Added a retry.' });
    expect(textOf(await update.handler({ session_id: 's1', title: 'Again', summary: 'again' }, {})).error).toContain('already carries a title');
  });
});
