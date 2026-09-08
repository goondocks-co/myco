/**
 * The materialized tools against the real routes: a refused write is a tool
 * answer the model can act on, never a failed run; a caller holding no run is
 * told the session is not found. The sweep's tools survey by previews and pull
 * a body only when asked for one.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { insertSpore } from '@myco-server-worker/core/spores.js';
import { upsertDigest } from '@myco-server-worker/core/digests.js';
import { ServerClient } from '@myco/member/transport.js';
import {
  materializedCreateSporeTool, materializedReadDigestTool, materializedReportTool, materializedResolveSporeTool,
  materializedSessionMaterialTool, materializedSessionsTool, materializedSporeTool, materializedSporesTool,
  materializedUpdateSessionTool, materializedWriteDigestTool,
} from '@myco/agent/runtime/server-tools.js';
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
  await ensureMember(e.db, HARNESS_MEMBER_ID, now, 'member', 'harness runtime');
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
  await recordDispatch(e.db, { projectId: 'proj_1' }, { id: 'run_sweep', agentId: 'myco-agent', task: 'supersession-sweep', provider: 'anthropic', model: null, runContext: JSON.stringify({ session_id: 's1' }), dispatchedBy: minted.tokenId, startedAt: now });
  await recordDispatch(e.db, { projectId: 'proj_1' }, { id: 'run_smoke', agentId: 'myco-agent', task: 'container-smoke', provider: 'anthropic', model: null, runContext: null, dispatchedBy: minted.tokenId, startedAt: now });
  await recordDispatch(e.db, { projectId: 'proj_1' }, { id: 'run_digest', agentId: 'myco-agent', task: 'digest-only', provider: 'anthropic', model: null, runContext: JSON.stringify({ input_hash: 'digest-hash', counts: { spores: 3, sessionsInWindow: 1, windowFull: false } }), dispatchedBy: minted.tokenId, startedAt: now });
  e.sqlite.run(`UPDATE agent_runs SET status = 'running' WHERE id IN ('run_1', 'run_sweep', 'run_smoke', 'run_digest')`);
  return { ...e, now, client: clientFor(minted.token) };
}



describe('a Cortex run\'s tools', () => {
  it('read the digest, served the exact tier or nothing', async () => {
    const { client, db, now } = await setup();
    const ctx = { client, budget, runId: 'run_digest', agentId: 'myco-agent' };
    await upsertDigest(db, { projectId: 'proj_1' }, { id: 'd1', agentId: 'myco-agent', tier: 5000, content: 'the digest', substrateHash: null, generatedAt: now });

    expect(textOf(await materializedReadDigestTool(ctx).handler({ tier: 5000 }, {})))
      .toEqual({ digest: { tier: 5000, content: 'the digest', generatedAt: now, fallback: false } });
    // The run that writes the tiers is served its exact tier or nothing: a
    // neighbour's body under an absent tier's name would collapse the two.
    expect(textOf(await materializedReadDigestTool(ctx).handler({ tier: 10000 }, {})))
      .toEqual({ digest: null });
    expect(textOf(await materializedReadDigestTool(ctx).handler({}, {})))
      .toEqual({ tiers: [{ tier: 5000, generatedAt: now, contentLength: 10 }] });
  });



  it('leaves an ordinary report alone', async () => {
    const { client, sqlite } = await setup();
    const ctx = { client, budget, runId: 'run_digest', agentId: 'myco-agent' };
    const counter = { reports: 0 };
    await materializedReportTool(ctx, counter).handler({ action: 'skip', summary: 'nothing to do' }, {});
    expect(sqlite.query(`SELECT COUNT(*) c FROM cortex_instructions`).get()).toEqual({ c: 0 });
    expect(counter.reports).toBe(1);
  });
});

describe('the digest run\'s tools', () => {
  it('write one tier, filing the substrate hash and the run off the run row', async () => {
    const { client, sqlite } = await setup();
    const ctx = { client, budget, runId: 'run_digest', agentId: 'myco-agent' };
    const counter = { writes: 0 };
    const write = materializedWriteDigestTool(ctx, counter);

    expect(textOf(await write.handler({ tier: 5000, content: '# first' }, {}))).toEqual({ tier: 5000, revision_of: null });
    expect(textOf(await write.handler({ tier: 5000, content: '# second' }, {}))).toMatchObject({ tier: 5000 });
    expect(counter.writes).toBe(2);
    expect(sqlite.query(`SELECT tier, content, substrate_hash AS substrateHash FROM digest_extracts`).all())
      .toEqual([{ tier: 5000, content: '# second', substrateHash: 'digest-hash' }]);
    expect(sqlite.query(`SELECT content, run_id AS runId, metadata FROM digest_extract_revisions`).all())
      .toEqual([{ content: '# first', runId: 'run_digest', metadata: JSON.stringify({ spores: 3, sessionsInWindow: 1, windowFull: false }) }]);
  });

  it('answer a tier the deployment does not serve, and a run holding no digest surface, as tool errors', async () => {
    const { client, sqlite } = await setup();
    const counter = { writes: 0 };
    const refused = textOf(await materializedWriteDigestTool({ client, budget, runId: 'run_digest', agentId: 'myco-agent' }, counter)
      .handler({ tier: 3000, content: '# nope' }, {}));
    expect(String(refused.error)).toContain('tier is one of');

    const unheld = textOf(await materializedWriteDigestTool({ client, budget, runId: 'run_smoke', agentId: 'myco-agent' }, counter)
      .handler({ tier: 5000, content: '# nope' }, {}));
    expect(unheld).toEqual({ error: 'this run holds no such surface' });
    expect(counter.writes).toBe(0);
    expect(sqlite.query(`SELECT COUNT(*) c FROM digest_extracts`).get()).toEqual({ c: 0 });
  });
});
