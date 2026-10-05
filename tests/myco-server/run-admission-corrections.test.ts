import { expect, it } from 'bun:test';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { MAX_BODY_BYTES } from '@myco-server-worker/ingest/body.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';

async function setup(options?: Parameters<typeof sqliteEnv>[0]) {
  const f = sqliteEnv(options), now = Date.now();
  await ensureMember(f.db, HARNESS_MEMBER_ID, now, 'member', 'harness');
  const holder = await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'machine_1' }, now);
  f.sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,0)");
  await recordDispatch(f.db, { projectId: 'proj_1' }, { id: 'target', agentId: 'myco-agent', task: 'extract-curate', provider: null, model: null,
    runContext: JSON.stringify({ timeoutSeconds: 300, session_id: 'sess', mode: 'claim' }), startedAt: now, dispatchedBy: holder.tokenId });
  f.sqlite.run("UPDATE agent_runs SET status = 'running' WHERE id = 'target'");
  const server = createServer({ now: Date.now, sourceOf: () => '127.0.0.1', fetchImpl: fetch });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await server.handleRequest(new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(holder.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), f.serverEnv);
    return await res.json() as { error?: unknown; result?: unknown };
  };
  return { ...f, now, holder, server, call };
}

for (const code of ['no_project', 'body_cap', 'no_machine_identity'] as const) for (const held of ['unique', 'none', 'ambiguous'] as const) {
  it(`${code} admission receipt requires a ${held} open dispatch`, async () => {
    const f = await setup();
    try {
      if (held === 'none') f.sqlite.run("UPDATE agent_runs SET status = 'failed'");
      if (held === 'ambiguous') await recordDispatch(f.db, { projectId: 'proj_1' }, { id: 'other', agentId: 'myco-agent', task: 'extract-curate', provider: null, model: null, runContext: null, startedAt: f.now, dispatchedBy: f.holder.tokenId });
      if (code === 'no_machine_identity') f.sqlite.run('UPDATE member_credentials SET machine_id = NULL WHERE id = ?', [f.holder.tokenId]);
      const headers = memberHeaders(f.holder.token);
      if (code === 'no_project') delete headers[PROJECT_HEADER];
      const offer = code === 'body_cap' ? 'a'.repeat(MAX_BODY_BYTES + 1) : JSON.stringify({ runId: 'target', update: { status: 'failed' } });
      const post = () => f.server.handleRequest(new Request('https://s/runs/update', { method: 'POST', headers, body: offer }), f.serverEnv);
      const body = await (await post()).json() as { code: string; refusalId?: string };
      expect(body.code).toBe(code);
      if (held !== 'unique') expect(body.refusalId).toBeUndefined();
      else {
        expect(body.refusalId).toEqual(expect.any(String));
        expect((await (await post()).json() as typeof body).refusalId).toBe(body.refusalId);
        const row = f.sqlite.query("SELECT run_context AS context FROM agent_runs WHERE id = 'target'").get() as { context: string };
        expect(JSON.parse(row.context).runControlRefusals[code]).toEqual({ id: body.refusalId, tokenId: f.holder.tokenId, code });
      }
    } finally { f.sqlite.close(); }
  });
}

for (const op of ['prompt', 'title', 'map'] as const) for (const loss of ['lease', 'revocation', 'mid_batch_revocation', 'none'] as const) {
  it(`${op} commits its domain write and attribution together under ${loss}`, async () => {
    let armed = false;
    const f = await setup({ onSql: (sql, sqlite) => {
      if (!armed || !sql.startsWith('INSERT INTO agent_run_events')) return;
      armed = false;
      if (loss === 'lease') sqlite.run("UPDATE agent_runs SET lease_expires_at = 1 WHERE id = 'target'");
      if (loss === 'revocation') sqlite.run('UPDATE members SET revoked_at = 1 WHERE id = ?', [HARNESS_MEMBER_ID]);
    } });
    try {
      f.sqlite.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,started_at,ended_at) VALUES('proj_1','sess','m','t',0,0,0,1)");
      f.sqlite.run("INSERT INTO prompt_batches(project_id,session_id,prompt_id,event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at) VALUES('proj_1','sess','prompt','ev','hello','user','h',0,0,'t',0)");
      if (op === 'title') f.sqlite.run("UPDATE agent_runs SET task = 'title-summary' WHERE id = 'target'");
      if (op === 'map') {
        const repository = { url: 'https://example.test/source', branch: 'main', commit: 'a'.repeat(40) };
        f.sqlite.run("INSERT INTO project_repositories(project_id,revision,url,branch,updated_at,updated_by) VALUES('proj_1','r1',?,?,0,'test')", [repository.url, repository.branch]);
        f.sqlite.run("UPDATE agent_runs SET task = 'canopy-map', run_context = ? WHERE id = 'target'", [JSON.stringify({ timeoutSeconds: 300, repository, canopy: { inputHash: 'b'.repeat(64), priorRevision: null } })]);
      }
      if (loss === 'mid_batch_revocation') f.sqlite.exec(`CREATE TRIGGER revoke_domain AFTER ${op === 'map' ? 'INSERT' : 'UPDATE'}
        ON ${op === 'prompt' ? 'prompt_batches' : op === 'title' ? 'sessions' : 'canopy_maps'} BEGIN
        UPDATE members SET revoked_at = 1 WHERE id = '${HARNESS_MEMBER_ID}'; END`);
      armed = true;
      const answer = op === 'prompt' ? await f.call('myco_run_prompts', { op: 'mark_processed', prompt_id: 'prompt' })
        : op === 'title' ? await f.call('myco_run_sessions', { op: 'title', title: 'title', summary: 'summary' })
        : await f.call('myco_run_map', { op: 'write', artifact: { directories: [{ path: 'src', annotation: 'Source', groundedIn: [{ path: 'src/a.ts', sha256: 'c'.repeat(64) }] }], domains: [{ id: 'main', title: 'Main', files: [{ path: 'src/a.ts', annotation: 'Entry', groundedIn: [{ path: 'src/a.ts', sha256: 'c'.repeat(64) }] }] }] } });
      const count = (sql: string) => (f.sqlite.query(sql).get() as { n: number }).n;
      const changed = op === 'prompt' ? count("SELECT processed AS n FROM prompt_batches WHERE prompt_id = 'prompt'")
        : op === 'title' ? count("SELECT COUNT(*) AS n FROM sessions WHERE title IS NOT NULL") : count('SELECT COUNT(*) AS n FROM canopy_maps');
      const attributed = count("SELECT COUNT(*) AS n FROM agent_run_events WHERE event_type = 'run_write'");
      expect(changed).toBe(loss === 'none' ? 1 : 0);
      expect(attributed).toBe(changed);
      if (loss !== 'none') expect(answer.error).toBeDefined();
    } finally { f.sqlite.close(); }
  });
}

for (const op of ['save', 'obsolete', 'consolidate'] as const) for (const revoke of [false, true]) {
  it(`spore ${op} preserves domain and author atomicity with revocation=${revoke}`, async () => {
    const f = await setup();
    try {
      f.sqlite.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,started_at,ended_at) VALUES('proj_1','sess','m','t',0,0,0,1)");
      f.sqlite.run("INSERT INTO prompt_batches(project_id,session_id,prompt_id,event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at) VALUES('proj_1','sess','prompt','ev','hello','user','h',0,0,'t',0)");
      for (const id of ['a', 'b']) f.sqlite.run("INSERT INTO spores(project_id,id,agent_id,observation_type,status,content,created_at) VALUES('proj_1',?,'myco-agent','gotcha','active','source',0)", [id]);
      if (revoke) f.sqlite.exec(`CREATE TRIGGER revoke_spore AFTER ${op === 'obsolete' ? 'UPDATE' : 'INSERT'} ON spores BEGIN
        UPDATE members SET revoked_at = 1 WHERE id = '${HARNESS_MEMBER_ID}'; END`);
      const args = op === 'save' ? { op, content: 'observation', type: 'gotcha', prompt_id: 'prompt' }
        : op === 'obsolete' ? { op, id: 'a', reason: 'obsolete' }
        : { op, source_spore_ids: ['a', 'b'], consolidated_content: 'wisdom', observation_type: 'wisdom', prompt_id: 'prompt' };
      const answer = await f.call('myco_spores', args);
      const count = (sql: string) => (f.sqlite.query(sql).get() as { n: number }).n;
      expect(count("SELECT COUNT(*) AS n FROM spores WHERE author = 'target'"))
        .toBe(!revoke && op !== 'obsolete' ? 1 : 0);
      expect(count("SELECT COUNT(*) AS n FROM resolution_events WHERE author = 'target'"))
        .toBe(revoke || op === 'save' ? 0 : op === 'obsolete' ? 1 : 2);
      expect(count("SELECT COUNT(*) AS n FROM spores WHERE status != 'active'"))
        .toBe(revoke || op === 'save' ? 0 : op === 'obsolete' ? 1 : 2);
      if (revoke) expect(answer.error).toBeDefined();
    } finally { f.sqlite.close(); }
  });
}
