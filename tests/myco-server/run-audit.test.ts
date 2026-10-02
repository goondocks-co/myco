/**
 * A run's report carries the agent's audit, and a run of an outcome closes completed only on one.
 *
 * The audit is judged by its shape, never by what it says; a report without one is still recorded, is answered as a
 * failure naming what the audit lacks, and leaves the run to close failed in the reader's words with every write it
 * landed kept. Both doors a run ends through judge it alike.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { claimNextRun, endLeasedRun, HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { RUN_CLOSE_AUDIT_ERROR, RUN_SKIP_ACTION, TITLING_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { listReports, recordDispatch } from '@myco-server-worker/core/runs.js';
import { parseRunAudit, RUN_AUDIT_INSTRUCTION } from '@myco-server-worker/core/run-audit.js';
import { runErrorCode } from '@myco-server-worker/core/reader-codes.js';
import { INPUT_BUILDERS } from '@myco-server-worker/core/task-inputs.js';
import { getRunDetail } from '@myco-server-worker/read/runs.js';
import { readAttention } from '@myco-server-worker/core/attention.js';
import { titleSession } from '@myco-server-worker/core/titling.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { memberHeaders, memberPost, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { RUN_AUDIT } from '../helpers/run-audit.ts';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://s';
const SCOPE = { projectId: 'proj_1' };

async function rig() {
  const e = sqliteEnv({ workerLogin: true });
  turnOnGatedCapabilities(e.sqlite);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', ?, 'member')`, [HARNESS_MEMBER_ID, NOW]);
  await ensureMember(e.db, 'mem_worker', NOW, 'admin', 'a worker');
  const workerToken = (await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, NOW)).tokenId;
  const asRun = async (token: string, input: Record<string, unknown>) => {
    const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, {
      method: 'POST', headers: memberHeaders(token, { [PROJECT_HEADER]: 'proj_1' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_run', arguments: input } }),
    }), e.env);
    const body = await res.json() as { result?: { content?: Array<{ text?: string }> } };
    return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
  };
  const claimedTitling = async () => {
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at) VALUES ('proj_1', 's1', 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?)`, [NOW - 10_000, NOW, NOW - 10_000, NOW]);
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', 's1', 'p1', 'e1', 'add a retry to the runner', 'user', 'h1', ?, ?, 'tok_1', ?)`, [NOW - 5000, NOW - 5000, NOW - 5000]);
    expect((await titleSession(e.serverEnv, { projectId: 'proj_1', sessionId: 's1', now: NOW + 1, origin: ORIGIN })).outcome).toBe('queued');
    const claimed = await claimNextRun(e.serverEnv, { tokenId: workerToken, machineId: 'm1', harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now: NOW + 2 });
    if (!claimed.claimed) throw new Error('the titling run was not claimed');
    const title = await worker.fetch(new Request(`${ORIGIN}/mcp`, {
      method: 'POST', headers: memberHeaders(claimed.run.runToken, { [PROJECT_HEADER]: 'proj_1' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_run_sessions', arguments: { op: 'title', title: 'Add a retry to the runner', summary: 'The runner gained a retry.' } } }),
    }), e.env);
    expect(title.status).toBe(200);
    return claimed.run;
  };
  const row = (id: string) => e.sqlite.query(`SELECT status, error, error_code AS errorCode FROM agent_runs WHERE id = ?`).get(id);
  const end = (runId: string) => endLeasedRun(e.serverEnv, { tokenId: workerToken, now: NOW + 9 }, { projectId: 'proj_1', runId, status: 'completed' });
  return { e, asRun, claimedTitling, row, end };
}

describe('a run whose report carries no audit', () => {
  it('is told so by the report tool, closes failed in the reader\'s words, and keeps the title it wrote', async () => {
    const r = await rig();
    const run = await r.claimedTitling();
    const answered = await r.asRun(run.runToken, { op: 'report', action: TITLING_REPORT_ACTION, summary: 'titled one session' });
    expect(answered.ok).toBe(false);
    expect(String(answered.error)).toContain('recorded without its audit (the report carries no audit)');
    expect((await listReports(r.e.db, SCOPE, run.id)).map((report) => [report.action, report.audit])).toEqual([[TITLING_REPORT_ACTION, null]]);

    expect(await r.end(run.id)).toEqual({ ended: true, status: 'failed' });
    expect(r.row(run.id)).toEqual({ status: 'failed', error: RUN_CLOSE_AUDIT_ERROR, errorCode: 'report_without_audit' });
    expect(r.e.sqlite.query(`SELECT title FROM sessions WHERE session_id = 's1'`).get()).toEqual({ title: 'Add a retry to the runner' });
    const detail = await getRunDetail(r.e.db, SCOPE, run.id, NOW + 10, 'mem_worker');
    expect(detail?.run).toMatchObject({ errorCode: 'report_without_audit', result: 'failed_with_output' });
    expect(detail?.outcomeEvidence).toMatchObject({ hasReport: true, hasAudit: false, artifactPresent: true });
    // The rate is said where an administrator looks: the runs that ended without it, of the runs that owed it.
    const attention = await readAttention(r.e.serverEnv, NOW + 10);
    expect(attention.items.filter((item) => item.kind === 'runs_without_audit'))
      .toEqual([{ kind: 'runs_without_audit', tone: 'warn', projectId: 'proj_1', runs: 1, closed: 1, since: expect.any(Number), latestAt: expect.any(Number), runId: run.id }]);
  });

  it('closes completed once a report carries its audit, which the run\'s detail serves', async () => {
    const r = await rig();
    const run = await r.claimedTitling();
    await r.asRun(run.runToken, { op: 'report', action: TITLING_REPORT_ACTION, summary: 'titled one session' });
    expect(await r.asRun(run.runToken, { op: 'report', action: TITLING_REPORT_ACTION, summary: 'titled one session', audit: JSON.stringify(RUN_AUDIT) }))
      .toEqual({ recorded: true, action: TITLING_REPORT_ACTION });
    expect(await r.end(run.id)).toEqual({ ended: true, status: 'completed' });
    expect(r.row(run.id)).toEqual({ status: 'completed', error: null, errorCode: null });
    expect((await listReports(r.e.db, SCOPE, run.id)).map((report) => report.audit)).toEqual([null, { ...RUN_AUDIT, omitted: 0 }]);
  });

  it('closes as it did for a run claimed before attempts were recorded, which owes no audit', async () => {
    const r = await rig();
    const run = await r.claimedTitling();
    r.e.sqlite.run(`DELETE FROM agent_run_attempts WHERE run_id = ?`, [run.id]);
    expect(await r.asRun(run.runToken, { op: 'report', action: TITLING_REPORT_ACTION, summary: 'titled one session' })).toEqual({ recorded: true, action: TITLING_REPORT_ACTION });
    expect(await r.end(run.id)).toEqual({ ended: true, status: 'completed' });
    expect(r.row(run.id)).toEqual({ status: 'completed', error: null, errorCode: null });
  });

  it('owes nothing on the container\'s door, whose runs no worker claims, and closes there as it did', async () => {
    const e = sqliteEnv();
    turnOnGatedCapabilities(e.sqlite);
    e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, title, summary) VALUES ('proj_1', 's1', 'm1', 'tok_1', ?, ?, 'A title that stands', 'Its summary.')`, [NOW, NOW]);
    await ensureMember(e.db, HARNESS_MEMBER_ID, NOW, 'member', 'harness runtime');
    const minted = await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, NOW);
    await recordDispatch(e.db, SCOPE, {
      id: 'run_door', agentId: 'myco-agent', task: 'title-summary', provider: null, model: null,
      runContext: JSON.stringify({ timeoutSeconds: 120, session_id: 's1', mode: 'claim' }), dispatchedBy: minted.tokenId, startedAt: Date.now(),
    });
    e.sqlite.run(`UPDATE agent_runs SET status = 'running' WHERE id = 'run_door'`);
    const post = async (path: string, body: unknown) => await (await worker.fetch(memberPost(minted.token, body, path), e.env)).json() as Record<string, unknown>;
    expect(await post('/runs/report', { runId: 'run_door', agentId: 'myco-agent', action: RUN_SKIP_ACTION, summary: 'a title stands' }))
      .toEqual({ persisted: true, recorded: true });
    expect(await post('/runs/update', { runId: 'run_door', update: { status: 'completed', completed_at: Date.now() } }))
      .toMatchObject({ persisted: true, applied: true });
    expect(e.sqlite.query(`SELECT status, error, error_code AS errorCode FROM agent_runs WHERE id = 'run_door'`).get())
      .toEqual({ status: 'completed', error: null, errorCode: null });
  });

  it('reads a stored failure that carries no code in the same reader words', () => {
    expect(runErrorCode(RUN_CLOSE_AUDIT_ERROR)).toBe('report_without_audit');
    expect(runErrorCode(`${RUN_CLOSE_AUDIT_ERROR}: a call failed or was refused: Bash`)).toBe('report_without_audit');
  });
});

describe('the audit\'s shape', () => {
  it('refuses only an audit that says nothing a reader can check: not an object, or no step or no reasoning', () => {
    expect(parseRunAudit(RUN_AUDIT)).toMatchObject({ ok: true, repairs: [] });
    expect(parseRunAudit('{not json')).toEqual({ ok: false, error: 'audit is not a readable object' });
    expect(parseRunAudit(['a step'])).toEqual({ ok: false, error: 'audit must be an object' });
    expect(parseRunAudit({ ...RUN_AUDIT, steps: undefined })).toEqual({ ok: false, error: 'audit is missing steps' });
    expect(parseRunAudit({ ...RUN_AUDIT, steps: ['', 7] })).toEqual({ ok: false, error: 'audit is missing steps' });
    expect(parseRunAudit({ ...RUN_AUDIT, reasoning: undefined })).toEqual({ ok: false, error: 'audit is missing reasoning' });
    expect(parseRunAudit({ ...RUN_AUDIT, reasoning: '   ' })).toEqual({ ok: false, error: 'audit is missing reasoning' });
  });

  it('repairs everything else, and stores nothing it does not declare', () => {
    const repaired = parseRunAudit({
      steps: 'did the one thing', reasoning: `${'why '.repeat(1_200)}`, verdict: 'good',
      examined: ['src/a.ts', '', 9, ...Array.from({ length: 104 }, (_, i) => `src/file-${i}.ts`)],
      failures: ['a call timed out', { what: 'a write was refused', when: 'later' }, { recovery: 'none' }],
    });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(Object.keys(repaired.audit).sort()).toEqual(['commands', 'examined', 'failures', 'omitted', 'reasoning', 'steps']);
    expect(repaired.audit.steps).toEqual(['did the one thing']);
    expect(repaired.audit.reasoning).toHaveLength(4_000);
    expect(repaired.audit.commands).toEqual([]);
    expect(repaired.audit.examined).toHaveLength(100);
    expect(repaired.audit.failures).toEqual([{ what: 'a call timed out', recovery: '' }, { what: 'a write was refused', recovery: '' }]);
    expect(repaired.audit.omitted).toBe(5);
    expect(repaired.repairs).toContain('unknown fields dropped: verdict');
    expect(repaired.repairs).toContain('examined: 5 entries past 100 cut');
  });

  it('keeps commands in the shape of a command and files examined only as paths, with neither a body nor a credential', () => {
    const shaped = parseRunAudit({ ...RUN_AUDIT, commands: [`cat > .env <<'EOF'\nSTRIPE_KEY=${['rk', 'live', '51HxQwErTyUiOpAsDfGhJkL'].join('_')}\nEOF`,'curl -H "Authorization: Bearer abcdef0123456789abcdef" https://example.test/x'], examined: ['postgres://admin:S3cret@db/app'] });
    expect(shaped.ok && shaped.audit.commands).toEqual(['cat > … << …', 'curl -H … https://example.test']);
    expect(shaped.ok && shaped.audit.examined).toEqual(['…']);
  });

  it('closes a run completed on a repaired audit, whose report is answered with what was repaired', async () => {
    const r = await rig();
    const run = await r.claimedTitling();
    const answered = await r.asRun(run.runToken, { op: 'report', action: TITLING_REPORT_ACTION, summary: 'titled', audit: { steps: 'read and wrote the title', reasoning: 'the session was about retries', note: 'extra' } });
    expect(answered).toEqual({ recorded: true, action: TITLING_REPORT_ACTION, audit_repaired: ['steps read as a list of one', 'unknown fields dropped: note'] });
    expect(await r.end(run.id)).toEqual({ ended: true, status: 'completed' });
    const stored = r.e.sqlite.query(`SELECT audit FROM agent_reports WHERE run_id = ?`).get(run.id) as { audit: string };
    expect(JSON.parse(stored.audit)).toEqual({ steps: ['read and wrote the title'], examined: [], commands: [], failures: [], reasoning: 'the session was about retries', omitted: 0 });
  });

  it('is refused by the report tool where it says nothing, which records the report without it', async () => {
    const r = await rig();
    const run = await r.claimedTitling();
    const answered = await r.asRun(run.runToken, { op: 'report', action: TITLING_REPORT_ACTION, summary: 'titled', audit: { ...RUN_AUDIT, reasoning: '' } });
    expect(answered).toMatchObject({ ok: false });
    expect(String(answered.error)).toContain('(audit is missing reasoning)');
    // What is stored is the judged audit or nothing: never the offer as it came, and never a credential it carried.
    await r.asRun(run.runToken, { op: 'report', action: TITLING_REPORT_ACTION, summary: 'titled', audit: { ...RUN_AUDIT, commands: ['mysql -uroot -pPa55word app'] } });
    const stored = r.e.sqlite.query(`SELECT audit FROM agent_reports WHERE run_id = ? ORDER BY id`).all(run.id) as Array<{ audit: string | null }>;
    expect(stored[0]).toEqual({ audit: null });
    expect(JSON.parse(stored[1]!.audit!).commands).toEqual(['mysql -u… -p… …']);
  });

  it('is asked for by every outcome\'s prompt, which says to report again when the report answers with an error', async () => {
    for (const [task, builder] of Object.entries(INPUT_BUILDERS)) {
      const prompt = builder.template([]).promptTemplate ?? '';
      expect({ task, asks: prompt.includes(RUN_AUDIT_INSTRUCTION), stopsFirst: prompt.includes('Stop after the report') }).toEqual({ task, asks: true, stopsFirst: false });
    }
    expect(RUN_AUDIT_INSTRUCTION).toContain('If the report answers with an error, fix the audit and report again, then stop.');
  });
});
