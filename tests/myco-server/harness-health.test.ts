import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { SERVER_FEATURES } from '@myco-server-worker/constants.js';
import { HARNESS_HEALTH_FEATURE } from '@goondocks/myco-shared/harness-health';
import { HARNESS_RUN_CAPTURE_MARGIN_MS, HARNESS_SILENT_MS, MACHINE_ACTIVE_MS, parseProvisionedHarnessReport, recordProvisionedHarnessReport } from '@myco-server-worker/core/harness-health.js';
import { latestHarnessCapture } from '@myco-server-worker/read/harness-health.js';
import { readAttention, type AttentionItem } from '@myco-server-worker/core/attention.js';
import { envelope, memberPost, sqliteEnv, uuid } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const PATH = '/members/harnesses/report';

const fact = (id: string, state: 'ready' | 'binary_missing' | 'unwritable' | 'trust_required' | 'repair_failed', action?: string, ranAt?: number) =>
  ({ id, provisioned: true as const, state, ...(action === undefined ? {} : { action }), ...(ranAt === undefined ? {} : { ranAt }) });

async function rig(onSql?: (sql: string) => void) {
  const fixture = sqliteEnv(onSql === undefined ? {} : { onSql });
  fixture.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at, label) VALUES ('machine_1', 'mem_machine_1', ?, 'Ada laptop'), ('machine_2', 'mem_machine_2', ?, 'Lin laptop')`, [NOW, NOW]);
  const token1 = (await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now())).token;
  const token2 = (await issueMemberToken(fixture.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now())).token;
  const post = async (token: string, body: unknown) => {
    const res = await worker.fetch(memberPost(token, body, PATH), fixture.env);
    return { status: res.status, body: await res.json() as Record<string, unknown>, features: res.headers.get('x-myco-features') };
  };
  const attention = async (now = NOW) => (await readAttention(fixture.serverEnv, now)).items
    .filter((item): item is Extract<AttentionItem, { kind: 'harness_needs_repair' | 'harness_capture_silent' }> => item.kind === 'harness_needs_repair' || item.kind === 'harness_capture_silent');
  const session = (machine: string, id: string, agent: string, at: number, channel: 'cli' | 'import' = 'cli', createdAt = at) => {
    fixture.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, last_live_received_at)
      VALUES ('proj_1', ?, ?, 'mt_test', ?, ?, ?, ?)`, [id, machine, at, at, agent, channel === 'import' ? null : at]);
    fixture.sqlite.run(`INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
      VALUES ('proj_1', ?, ?, 'mt_test', 'session.start', ?, '{}', 'test', ?, ?)`, [`event_${id}`, id, channel, createdAt, at]);
  };
  return { fixture, token1, token2, post, attention, session };
}

describe('provisioned harness health', () => {
  it('does not read capture history for healthy reports without a prior trust hold', async () => {
    const sql: string[] = [];
    const r = await rig((statement) => sql.push(statement));
    sql.length = 0;
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW);
    expect(sql.some((statement) => statement.includes('JOIN events'))).toBe(false);
    sql.length = 0;
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'trust_required', 'Approve Codex in system settings.')] }, NOW + 1);
    expect(sql.some((statement) => statement.includes('JOIN events'))).toBe(false);
    sql.length = 0;
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW + 2);
    expect(sql.some((statement) => statement.includes('JOIN events'))).toBe(true);
  });

  it('advertises the additive report and accepts a machine-bound snapshot with one action for each broken harness', async () => {
    const r = await rig();
    expect(SERVER_FEATURES).toContain(HARNESS_HEALTH_FEATURE);
    const first = await r.post(r.token1, { harnesses: [fact('codex', 'binary_missing', 'Run Myco repair on this machine.')] });
    expect(first).toMatchObject({ status: 200, body: { persisted: true } });
    expect(first.features?.split(',')).toContain(HARNESS_HEALTH_FEATURE);
    expect(await r.attention(Date.now())).toEqual([expect.objectContaining({ kind: 'harness_needs_repair', machineId: 'machine_1', machineName: 'Ada laptop', harness: 'codex', state: 'binary_missing', action: 'Run Myco repair on this machine.' })]);
    await r.post(r.token2, { harnesses: [fact('cursor', 'unwritable', 'Grant Cursor settings write access.')] });
    expect((await r.attention(Date.now())).map((item) => item.machineId)).toEqual(['machine_1', 'machine_2']);
    const ranAt = Date.now();
    await r.post(r.token1, { harnesses: [fact('codex', 'ready', undefined, ranAt)] });
    const stored = r.fixture.sqlite.query(`SELECT harnesses FROM machine_harness_reports WHERE machine_id = 'machine_1'`).get() as { harnesses: string };
    expect(JSON.parse(stored.harnesses)).toEqual([expect.objectContaining({ id: 'codex', ranAt })]);
    expect((await r.attention(Date.now())).map((item) => item.machineId)).toEqual(['machine_2']);
  });

  it('refuses malformed facts before changing the stored snapshot', async () => {
    const r = await rig();
    await r.post(r.token1, { harnesses: [fact('codex', 'repair_failed', 'Open the Codex settings and repair Myco.')] });
    const invalid = [
      { harnesses: [fact('codex', 'ready'), fact('codex', 'ready')] },
      { harnesses: [fact('codex', 'binary_missing')] },
      { harnesses: [fact('codex', 'trust_required', 'Trust it.\nDelete data.')] },
      { harnesses: [{ ...fact('codex', 'ready'), path: '/Users/private' }] },
      { harnesses: [fact('co/dex', 'ready')] },
      { harnesses: [{ ...fact('codex', 'ready'), ranAt: -1 }] },
      { harnesses: [{ ...fact('codex', 'ready'), ranAt: 1.5 }] },
      { harnesses: [{ ...fact('codex', 'ready'), ranAt: 'yesterday' }] },
    ];
    for (const body of invalid) expect(await r.post(r.token1, body)).toMatchObject({ status: 200, body: { persisted: false, code: 'invalid_field' } });
    expect((await r.attention(Date.now()))[0]).toMatchObject({ state: 'repair_failed' });
    expect(parseProvisionedHarnessReport({ harnesses: [] })).toEqual({ harnesses: [] });
  });

  it('keeps trust required until that harness captures after the first report, even when its report repeats', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'trust_required', 'Approve Codex in system settings.')] }, NOW - 3 * HOUR);
    r.session('machine_1', 'earlier', 'codex', NOW - 4 * HOUR);
    expect((await r.attention()).map((item) => item.kind)).toEqual(['harness_needs_repair']);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'trust_required', 'Approve Codex in system settings.')] }, NOW - HOUR);
    r.session('machine_1', 'later', 'codex', NOW - 2 * HOUR);
    expect(await r.attention()).toEqual([]);
    expect(await r.attention(NOW + 31 * 24 * HOUR)).toEqual([]);
  });

  it('retains trust required when a later file probe says ready, until captured use proves the hook ran', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'trust_required', 'Approve Codex in system settings.')] }, NOW - 3 * HOUR);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW - 2 * HOUR);
    expect((await r.attention()).map((item) => item.kind)).toEqual(['harness_needs_repair']);
    r.session('machine_1', 'used_codex', 'codex', NOW - HOUR);
    expect(await r.attention()).toEqual([]);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW);
    expect(await r.attention()).toEqual([]);
  });

  it('does not treat an imported transcript as proof that a newly changed hook ran', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'trust_required', 'Approve Codex in system settings.')] }, NOW - 3 * HOUR);
    r.session('machine_1', 'imported_codex', 'codex', NOW - HOUR, 'import');
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW);
    expect((await r.attention()).map((item) => item.kind)).toEqual(['harness_needs_repair']);
  });

  it('does not let a delayed pre-repair session start confirm newly changed hooks', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'trust_required', 'Approve Codex in system settings.')] }, NOW - 3 * HOUR);
    r.session('machine_1', 'late_old_start', 'codex', NOW - HOUR, 'cli', NOW - 4 * HOUR);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW);
    expect((await r.attention()).map((item) => item.kind)).toEqual(['harness_needs_repair']);
    r.session('machine_1', 'new_start', 'codex', NOW + 2, 'cli', NOW + 1);
    expect(await r.attention(NOW + 2)).toEqual([]);
  });

  it('requires new captured use after a second reported hook change', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'trust_required', 'Approve Codex in system settings.')] }, NOW - 4 * HOUR);
    r.session('machine_1', 'first_use', 'codex', NOW - 3 * HOUR);
    expect(await r.attention()).toEqual([]);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'trust_required', 'Approve Codex in system settings.')] }, NOW - 2 * HOUR);
    expect((await r.attention()).map((item) => item.kind)).toEqual(['harness_needs_repair']);
    r.session('machine_1', 'second_use', 'codex', NOW - HOUR);
    expect(await r.attention()).toEqual([]);
  });

  it('a new repair marker prevents a start queued before that repair from confirming trust', async () => {
    const r = await rig();
    const pending = { ...fact('codex', 'trust_required', 'Restart Codex and trust hooks'), hookRepairAt: 1 };
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [pending] }, NOW - 4 * HOUR);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [{ ...pending, hookRepairAt: 2 }] }, NOW - HOUR);
    r.session('machine_1', 'queued_old_start', 'codex', NOW, 'cli', NOW - 2 * HOUR);
    expect((await r.attention()).map((item) => item.kind)).toEqual(['harness_needs_repair']);
    r.session('machine_1', 'after_new_repair', 'codex', NOW - 1);
    expect(await r.attention()).toEqual([]);
  });

  it('requires evidence of later harness use to flag silence after trust was confirmed', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'trust_required', 'Approve Codex in system settings.')] }, NOW - 3 * HARNESS_SILENT_MS);
    r.session('machine_1', 'trusted_codex', 'codex', NOW - 2 * HARNESS_SILENT_MS);
    r.session('machine_1', 'active_claude', 'claude-code', NOW - MACHINE_ACTIVE_MS + 1);
    expect(await r.attention()).toEqual([]);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready', undefined, NOW - HOUR)] }, NOW - HOUR);
    expect(await r.attention()).toEqual([expect.objectContaining({ kind: 'harness_capture_silent', harness: 'codex', lastCapturedAt: NOW - 2 * HARNESS_SILENT_MS })]);
  });

  it('flags an unusually quiet provisioned harness only while the same machine is active, and clears on capture', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW - 3 * HARNESS_SILENT_MS);
    r.session('machine_1', 'old_codex', 'codex', NOW - HARNESS_SILENT_MS - 1);
    expect(await r.attention()).toEqual([]);
    r.session('machine_2', 'other_machine', 'claude-code', NOW - 1);
    expect(await r.attention()).toEqual([]);
    r.session('machine_1', 'imported_other_agent', 'claude-code', NOW - MACHINE_ACTIVE_MS + 2, 'import');
    expect(await r.attention()).toEqual([]);
    r.session('machine_1', 'other_agent', 'claude-code', NOW - MACHINE_ACTIVE_MS + 1);
    expect(await r.attention()).toEqual([]);
    const oldCapture = NOW - HARNESS_SILENT_MS - 1;
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready', undefined, oldCapture)] }, NOW - HOUR);
    expect(await r.attention()).toEqual([]);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready', undefined, oldCapture + HARNESS_RUN_CAPTURE_MARGIN_MS)] }, NOW - HOUR);
    expect(await r.attention()).toEqual([]);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready', undefined, oldCapture + HARNESS_RUN_CAPTURE_MARGIN_MS + 1)] }, NOW - HOUR);
    expect(await r.attention()).toEqual([expect.objectContaining({ kind: 'harness_capture_silent', harness: 'codex', machineId: 'machine_1', lastCapturedAt: NOW - HARNESS_SILENT_MS - 1 })]);
    r.session('machine_1', 'new_codex', 'codex', NOW - 1);
    expect(await r.attention()).toEqual([]);
  });

  it('uses recent worker contact as machine activity without inventing a captured session for another harness', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready', undefined, NOW - 2 * HOUR)] }, NOW - 2 * HARNESS_SILENT_MS);
    r.session('machine_1', 'old_codex', 'codex', NOW - HARNESS_SILENT_MS - 1);
    const credential = r.fixture.sqlite.query(`SELECT id FROM member_credentials WHERE machine_id = 'machine_1'`).get() as { id: string };
    r.fixture.sqlite.run(`INSERT INTO worker_contacts (credential_id, machine_id, last_seen_at, updated_at) VALUES (?, 'machine_1', ?, ?)`, [credential.id, NOW - MACHINE_ACTIVE_MS, NOW]);
    expect((await r.attention()).map((item) => item.kind)).toEqual(['harness_capture_silent']);
    r.fixture.sqlite.run(`UPDATE worker_contacts SET last_seen_at = ? WHERE credential_id = ?`, [NOW - MACHINE_ACTIVE_MS - 1, credential.id]);
    expect(await r.attention()).toEqual([]);
  });

  it('local harness use establishes machine activity even when every capture and worker is quiet', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready', undefined, NOW - 1)] }, NOW - HOUR);
    r.session('machine_1', 'quiet_codex', 'codex', NOW - 2 * HARNESS_SILENT_MS);
    expect(await r.attention()).toEqual([expect.objectContaining({ kind: 'harness_capture_silent', harness: 'codex', lastMachineActivityAt: NOW - 1 })]);
  });

  it('warns after recent local use even when the latest capture is older than thirty days', async () => {
    const r = await rig();
    const ancientCapture = NOW - 90 * HARNESS_SILENT_MS;
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready', undefined, NOW - HOUR)] }, NOW - HOUR);
    r.session('machine_1', 'ancient_codex', 'codex', ancientCapture);
    r.session('machine_1', 'active_other', 'claude-code', NOW - MACHINE_ACTIVE_MS + 1);
    expect(await r.attention()).toEqual([expect.objectContaining({ kind: 'harness_capture_silent', harness: 'codex', lastCapturedAt: ancientCapture })]);
  });

  it('indexes recent live capture by machine and harness without reading the event log for Health', async () => {
    const sql: string[] = [];
    const r = await rig((statement) => sql.push(statement));
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW - 2 * HOUR);
    r.session('machine_1', 'live_codex', 'codex', NOW - HOUR);
    r.session('machine_1', 'imported_codex', 'codex', NOW, 'import');
    expect(await latestHarnessCapture(r.fixture.db)).toEqual([{ machine_id: 'machine_1', agent: 'codex', at: NOW - HOUR }]);
    expect(sql.some((statement) => statement.includes('JOIN events'))).toBe(false);
    const query = sql.find((statement) => statement.includes('JOIN json_each(r.harnesses)'));
    expect(query).toBeDefined();
    const plan = r.fixture.sqlite.query(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>;
    expect(plan.some((step) => step.detail.includes('SEARCH s USING COVERING INDEX idx_sessions_harness_live') && step.detail.includes('machine_id=?') && step.detail.includes('agent=?'))).toBe(true);
  });

  it('reads harness facts once per Health answer and marks both rules unavailable if that read fails', async () => {
    const sql: string[] = [];
    const r = await rig((statement) => sql.push(statement));
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW);
    sql.length = 0;
    await readAttention(r.fixture.serverEnv, NOW);
    expect(sql.filter((statement) => statement.includes('SELECT r.machine_id, r.harnesses, r.reported_at'))).toHaveLength(1);

    const failed = await rig((statement) => {
      if (statement.includes('SELECT r.machine_id, r.harnesses, r.reported_at')) throw new Error('report read failed');
    });
    expect((await readAttention(failed.fixture.serverEnv, NOW)).unavailable.filter((kind) => kind.startsWith('harness_')))
      .toEqual(['harness_needs_repair', 'harness_capture_silent']);
  });

  it('updates the indexed live capture receipt only for newly admitted non-import events', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW);
    const send = async (body: unknown) => (await worker.fetch(memberPost(r.token1, body), r.fixture.env)).json() as Promise<{ persisted: boolean; duplicate?: boolean }>;
    const before = Date.now();
    const start = envelope({ eventId: uuid(211), sessionId: 'new_capture', kind: 'session.start', createdAt: before - 1_000, payload: { agent: 'codex', startedAt: before - 1_000 } });
    expect((await send(start)).persisted).toBe(true);
    const captured = await latestHarnessCapture(r.fixture.db);
    expect(captured).toEqual([expect.objectContaining({ machine_id: 'machine_1', agent: 'codex' })]);
    expect(captured[0]!.at).toBeGreaterThanOrEqual(before);
    const stored = r.fixture.sqlite.query(`SELECT last_live_received_at FROM sessions WHERE session_id = 'new_capture'`).get() as { last_live_received_at: number };
    expect(stored.last_live_received_at).toBe(captured[0]!.at);
    expect(await send(start)).toMatchObject({ persisted: true, duplicate: true });
    const imported = envelope({ eventId: uuid(212), sessionId: 'new_capture', kind: 'session.start', channel: 'import', createdAt: before - 500,
      payload: { agent: 'codex', startedAt: before - 500 } });
    await send(imported);
    expect((r.fixture.sqlite.query(`SELECT last_live_received_at FROM sessions WHERE session_id = 'new_capture'`).get() as { last_live_received_at: number }).last_live_received_at).toBe(stored.last_live_received_at);
  });
});
