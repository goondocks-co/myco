import { schemaSqlite } from './helpers/schema-template.js';
import { sqliteD1 } from './helpers/d1.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { NEXT_ATTENTION } from '@myco-server-worker/db/schema-vNEXT-attention.js';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from './helpers/member-token.js';
import { MEMBER_TOKEN_TTL_MS, SERVER_FEATURES } from '@myco-server-worker/constants.js';
import {
  HARNESS_HEALTH_FEATURE,
  HARNESS_HELD_ELSEWHERE_FEATURE,
  MAX_HARNESS_DEPLOYMENT_CHARS,
  HARNESS_RUN_CAPTURE_MARGIN_MS,
  HARNESS_SILENT_MS,
} from '@goondocks/myco-shared/harness-health';
import {
  MACHINE_ACTIVE_MS,
  parseProvisionedHarnessReport,
  recordProvisionedHarnessReport,
  provisionedHarnessHealth,
  provisionedHarnessAttention,
} from '@myco-server-worker/core/harness-health.js';
import { latestHarnessCapture } from '@myco-server-worker/db/runners/harness-health.js';
import { readAttention, type AttentionItem } from '@myco-server-worker/core/attention.js';
import { envelope, memberPost, sqliteEnv, uuid } from './helpers/fixtures.js';

let clock: { mockRestore(): void } | undefined;
afterEach(() => clock?.mockRestore());
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PATH = '/members/harnesses/report';

/** A use of the harness reported after every repair marker these tests write, so a trust hold asks for approval. */
const USED_AFTER_REPAIR = NOW + 24 * HOUR;
const fact = (id: string, state: 'ready' | 'binary_missing' | 'unwritable' | 'trust_required' | 'repair_failed', action?: string,
  ranAt = state === 'trust_required' ? USED_AFTER_REPAIR : undefined) =>
  ({ id, provisioned: true as const, activityScope: 'deployment' as const, state, ...(action === undefined ? {} : { action }), ...(ranAt === undefined ? {} : { ranAt }) });

async function rig(onSql?: (sql: string) => void) {
  const fixture = sqliteEnv(onSql === undefined ? {} : { onSql });
  fixture.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at, label) VALUES ('machine_1', 'mem_machine_1', ?, 'Ada laptop'), ('machine_2', 'mem_machine_2', ?, 'Lin laptop')`, [NOW, NOW]);
  const token1 = (await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now())).token;
  const token2 = (await issueMemberToken(fixture.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now())).token;
  // Each machine refreshed its credential at NOW too, so it is in contact when attention is read then.
  for (const n of [1, 2]) await issueMemberToken(fixture.db, { memberId: `mem_machine_${n}`, machineId: `machine_${n}` }, NOW);
  const post = async (token: string, body: unknown) => {
    const res = await worker.fetch(memberPost(token, body, PATH), fixture.env);
    return { status: res.status, body: await res.json() as Record<string, unknown>, features: res.headers.get('x-myco-features') };
  };
  const attention = async (now = NOW) => (await readAttention(fixture.serverEnv, now)).items
    .filter((item): item is Extract<AttentionItem, { kind: 'harness_needs_repair' | 'harness_capture_silent' }> => item.kind === 'harness_needs_repair' || item.kind === 'harness_capture_silent');
  const session = (machine: string, id: string, agent: string, at: number, channel: 'cli' | 'import' = 'cli', createdAt = at) => {
    fixture.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, last_live_received_at,last_trust_start_at)
      VALUES ('proj_1', ?, ?, 'mt_test', ?, ?, ?, ?,?)`, [id, machine, at, at, agent, channel === 'import' ? null : at,channel === 'import' ? null : Math.min(at,createdAt)]);
    fixture.sqlite.run(`INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
      VALUES ('proj_1', ?, ?, 'mt_test', 'session.start', ?, '{}', 'test', ?, ?)`, [`event_${id}`, id, channel, createdAt, at]);
  };
  return { fixture, token1, token2, post, attention, session };
}

function upgradeFixture() {
  const sqlite = schemaSqlite({ through: NEXT_ATTENTION - 1 });
  sqlite.run("INSERT INTO projects(project_id,name,created_at) VALUES('p','Project',1)");
  sqlite.run("INSERT INTO members(id,label,created_at) VALUES('member','Reader',1)");
  sqlite.run("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','member',1)");
  const steps = sqlite.transaction(() => {
    for (const step of SCHEMA_STEPS.filter(step => step.version >= NEXT_ATTENTION)) for (const sql of step.statements) sqlite.exec(sql);
  });
  const db = sqliteD1(sqlite);
  // The machine is in contact with the upgraded Deployment: it holds a credential live at the instants the tests read.
  const upgrade = async () => { steps(); await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, NOW); };
  return { sqlite, db, upgrade };
}

describe('provisioned harness health', () => {
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
    const stored = r.fixture.sqlite.query(`SELECT harness, ran_at FROM machine_harness_reports WHERE machine_id = 'machine_1'`).all();
    expect(stored).toEqual([{ harness: 'codex', ran_at: ranAt }]);
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

  it('needs nobody for a former machine whose credentials lapsed, until it is in contact again', async () => {
    const r = await rig(), lapsed = NOW + MEMBER_TOKEN_TTL_MS, held = async (at: number) => (await r.attention(at)).map((item) => [item.machineId, item.kind]);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'trust_required', 'Approve Codex in system settings.')] }, NOW);
    const [current, former] = [await held(NOW), await held(lapsed)];
    await issueMemberToken(r.fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, lapsed);
    expect({ current, former, again: await held(lapsed) }).toEqual({ current: [['machine_1', 'harness_needs_repair']], former: [], again: [['machine_1', 'harness_needs_repair']] });
  });

  it('requires a live start with both clocks after repair and confirms independently of report commit order', async () => {
    const r = await rig();
    const now = Date.now();
    r.session('machine_1', 'running', 'codex', now - 2_000);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'trust_required', 'Trust Codex.')] }, now - 1_000);
    const prompt = await worker.fetch(memberPost(r.token1, envelope({ sessionId: 'running', createdAt: now })), r.fixture.env);
    expect(await prompt.json()).toMatchObject({ persisted: true });
    expect((await r.attention(now)).map(item => item.kind)).toEqual(['harness_needs_repair']);
    for (const over of [
      { eventId: uuid(202), sessionId: 'imported-start', channel: 'import', createdAt: now },
      { eventId: uuid(203), sessionId: 'skewed-start', createdAt: now - 2_000 },
    ]) {
      const response = await worker.fetch(memberPost(r.token1, envelope({ kind: 'session.start', payload: { agent: 'codex' }, ...over })), r.fixture.env);
      expect(await response.json()).toMatchObject({ persisted: true });
      await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, Date.now());
      expect((await r.attention(now)).map(item => item.kind)).toEqual(['harness_needs_repair']);
    }
    const start = await worker.fetch(memberPost(r.token1, envelope({ eventId: uuid(200), sessionId: 'new-start', kind: 'session.start', createdAt: now, payload: { agent: 'codex' } })), r.fixture.env);
    expect(await start.json()).toMatchObject({ persisted: true });
    expect(await r.attention(now)).toEqual([]);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, Date.now());
    const reportReceivedAt = Date.now() + 1;
    clock = spyOn(Date, 'now').mockReturnValue(reportReceivedAt + 1);
    const overlap = await worker.fetch(memberPost(r.token1, envelope({ eventId: uuid(201), sessionId: 'overlap', kind: 'session.start', createdAt: Date.now(), payload: { agent: 'codex' } })), r.fixture.env);
    expect(await overlap.json()).toMatchObject({ persisted: true });
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'trust_required', 'Trust Codex.')] }, reportReceivedAt);
    expect(await r.attention(Date.now())).toEqual([]);
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

  it('asks for hook approval only once the harness ran after the repair, and keeps asking through later ready reports', async () => {
    const r = await rig();
    const repaired = { ...fact('codex', 'trust_required', 'Restart Codex and trust hooks'), hookRepairAt: NOW - 2 * HOUR };
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [{ ...repaired, ranAt: NOW - 3 * HOUR }] }, NOW - 2 * HOUR);
    expect(await r.attention()).toEqual([]);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [{ ...repaired, ranAt: NOW - HOUR }] }, NOW - HOUR);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW);
    expect(await r.attention()).toEqual([expect.objectContaining({ kind: 'harness_needs_repair', state: 'trust_required', harness: 'codex' })]);
    r.session('machine_1', 'trusted', 'codex', NOW);
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW + 1);
    expect(await r.attention(NOW + 1)).toEqual([]);
  });

  it('requires evidence of later harness use to flag silence after trust was confirmed', async () => {
    const r = await rig();
    const { ranAt: _noUse, ...unused } = fact('codex', 'trust_required', 'Approve Codex in system settings.');
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [unused] }, NOW - 3 * HARNESS_SILENT_MS);
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
    r.fixture.sqlite.run('DELETE FROM machine_head');
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

  it('retains live capture at zero when an imported receipt is newer', async () => {
    const r = await rig();
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW - 2 * HOUR);
    r.session('machine_1', 'live_codex', 'codex', 0);
    r.session('machine_1', 'imported_codex', 'codex', NOW, 'import');
    expect(await latestHarnessCapture(r.fixture.db)).toEqual([{ machine_id: 'machine_1', agent: 'codex', at: 0 }]);
  });

  it('reads harness facts once per Health answer and marks both rules unavailable if that read fails', async () => {
    const sql: string[] = [];
    const r = await rig((statement) => sql.push(statement));
    await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW);
    sql.length = 0;
    await readAttention(r.fixture.serverEnv, NOW);
    expect(sql.filter((statement) => statement.includes('r.capability_hash FROM machine_harness_reports r'))).toHaveLength(1);

    const failed = await rig((statement) => {
      if (statement.includes('r.capability_hash FROM machine_harness_reports r')) throw new Error('report read failed');
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

it('accepts held tools as informational wiring without repair attention while preserving capture-silence attention', async () => {
  const r = await rig();
  const held = { activityScope: 'deployment' as const, id: 'claude-code', provisioned: true as const, state: 'held_elsewhere' as const, toolsDeployment: 'https://other.myco.example', ranAt: NOW };
  expect(SERVER_FEATURES).toContain(HARNESS_HELD_ELSEWHERE_FEATURE);
  r.session('machine_1', 'old_claude', 'claude-code', NOW - 2 * HARNESS_SILENT_MS);
  const response = await r.post(r.token1, { harnesses: [held] });
  expect(response.body).toMatchObject({ persisted: true });
  expect(response.features?.split(',')).toContain(HARNESS_HELD_ELSEWHERE_FEATURE);
  expect(await r.attention()).toEqual([expect.objectContaining({ kind: 'harness_capture_silent', harness: 'claude-code' })]);
  expect((await r.attention()).some(item => item.kind === 'harness_needs_repair')).toBe(false);
  expect(await provisionedHarnessHealth(r.fixture.db)).toEqual([{ ...held, machineId: 'machine_1', machineName: 'Ada laptop' }]);
  for (const toolsDeployment of ['', 'https://bad.example/\n', 'x'.repeat(MAX_HARNESS_DEPLOYMENT_CHARS + 1)]) {
    expect(parseProvisionedHarnessReport({ harnesses: [{ ...held, toolsDeployment }] })).toBeNull();
  }
  expect(parseProvisionedHarnessReport({ harnesses: [{ ...held, toolsDeployment: undefined }] })).toBeNull();
  expect(parseProvisionedHarnessReport({ harnesses: [{ ...held, state: 'ready' }] })).toBeNull();
  expect(parseProvisionedHarnessReport({ harnesses: [{ ...held, action: 'Provision it' }] })).toBeNull();
});

it('legacy activity cannot trigger silence, scoped replacement clears earlier use, and a trust hold keeps the use it reported', async () => {
  const r = await rig();
  r.session('machine_1', 'old', 'codex', NOW - 2 * HARNESS_SILENT_MS);
  r.session('machine_1', 'active_other', 'cursor', NOW);
  const scoped = fact('codex', 'ready', undefined, NOW);
  const { activityScope: _scope, ...legacy } = scoped;
  await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [legacy] }, NOW);
  expect(await r.attention()).toEqual([]);
  await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [scoped] }, NOW);
  expect((await r.attention()).map(item => item.kind)).toEqual(['harness_capture_silent']);
  await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW);
  expect(await r.attention()).toEqual([]);
  await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'trust_required', 'Approve capture.', NOW)] }, NOW);
  await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready')] }, NOW + 1);
  expect((await provisionedHarnessHealth(r.fixture.db))[0]).toMatchObject({ state: 'trust_required', activityScope: 'deployment', ranAt: NOW });
  expect(parseProvisionedHarnessReport({ harnesses: [{ ...scoped, activityScope: 'unavailable' }] })).toBeNull();
  expect(parseProvisionedHarnessReport({ harnesses: [{ ...scoped, activityScope: 'global' }] })).toBeNull();
});

it('unscoped use of another harness cannot establish this Deployment machine activity', async () => {
  const r = await rig();
  r.session('machine_1', 'old_scoped', 'codex', NOW - 2 * HARNESS_SILENT_MS);
  const { activityScope: _scope, ...legacy } = fact('cursor', 'ready', undefined, NOW);
  await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [fact('codex', 'ready', undefined, NOW - 2 * HOUR), legacy] }, NOW);
  expect(await r.attention()).toEqual([]);
});

it('keeps a confirmed repair generation confirmed across later activity reports while other destinations wait', async () => {
  const r = await rig();
  const held = { ...fact('codex', 'trust_required', 'Approve capture.'), hookRepairAt: NOW - HOUR };
  await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [held] }, NOW - 100);
  r.session('machine_1', 'confirmed', 'codex', NOW - 50);
  expect(await r.attention()).toEqual([]);
  await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [{ ...held, ranAt: NOW }] }, NOW);
  expect(await r.attention()).toEqual([]);
  await recordProvisionedHarnessReport(r.fixture.db, 'machine_1', { harnesses: [{ ...held, hookRepairAt: NOW + 1 }] }, NOW + 1);
  expect(await r.attention(NOW + 1)).toEqual([expect.objectContaining({ kind: 'harness_needs_repair', state: 'trust_required', since: NOW + 1 })]);
});

it('an upgrade retains live trust evidence when an imported session owns the newer receipt', async () => {
  const { sqlite, db, upgrade } = upgradeFixture();
  try {
    await recordProvisionedHarnessReport(db, 'machine', { harnesses: [fact('codex', 'trust_required', 'Trust Codex.')] }, 100_000);
    sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,agent,first_received_at,last_received_at,last_live_received_at)
      VALUES('p','live','machine','token','codex',250000,250000,250000),('p','imported','machine','token','codex',300000,300000,NULL)`);
    sqlite.run(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
      VALUES('p','live-start','live','token','session.start','cli','{}','hash',200000,250000),
      ('p','imported-start','imported','token','session.start','import','{}','hash',300000,300000)`);
    await upgrade();
    expect(await provisionedHarnessAttention(db, 300_000)).toEqual([]);
    expect(await latestHarnessCapture(db)).toEqual([{ machine_id: 'machine', agent: 'codex', at: 250_000 }]);
  } finally { sqlite.close(); }
});

it('an upgrade keeps a non-head start confirmed through receipt replacement while a session remains', async () => {
  const { sqlite, db, upgrade } = upgradeFixture();
  try {
    await recordProvisionedHarnessReport(db, 'machine', { harnesses: [fact('codex', 'trust_required', 'Trust Codex.')] }, NOW + 2_000);
    sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,agent,first_received_at,last_received_at,last_live_received_at)
      VALUES('p','a','machine','token','codex',?1,?1,?1),('p','b','machine','token','codex',?2,?2,?2)`, [NOW + 1_000, NOW + 3_000]);
    sqlite.run(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
      VALUES('p','a-start','a','token','session.start','cli','{}','hash',?1,?1),('p','b-start','b','token','session.start','cli','{}','hash',?2,?2)`, [NOW + 1_000, NOW + 3_000]);
    expect(sqlite.query('SELECT session_id FROM machine_capture_heads').get()).toEqual({ session_id: 'a' });
    await upgrade();
    expect(await provisionedHarnessAttention(db, NOW + 4_000)).toEqual([]);
    expect(sqlite.query('SELECT session_id,last_trust_start_at FROM sessions ORDER BY session_id').all())
      .toEqual([{ session_id: 'a', last_trust_start_at: null }, { session_id: 'b', last_trust_start_at: null }]);
    expect(await latestHarnessCapture(db)).toEqual([{ machine_id: 'machine', agent: 'codex', at: NOW + 3_000 }]);
    sqlite.run("DELETE FROM sessions WHERE project_id='p' AND session_id='a'");
    expect(await provisionedHarnessAttention(db, NOW + 4_000)).toEqual([]);
    sqlite.run("DELETE FROM sessions WHERE project_id='p' AND session_id='b'");
    expect(await provisionedHarnessAttention(db, NOW + 4_000)).toEqual([expect.objectContaining({ kind: 'harness_needs_repair', harness: 'codex' })]);
  } finally { sqlite.close(); }
});

it('an upgrade cannot let a future client clock confirm a later repair epoch', async () => {
  const { sqlite, db, upgrade } = upgradeFixture();
  try {
    await recordProvisionedHarnessReport(db, 'machine', { harnesses: [fact('codex', 'trust_required', 'Trust Codex.')] }, NOW);
    sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,agent,first_received_at,last_received_at,last_live_received_at)
      VALUES('p','skewed','machine','token','codex',?1,?1,?1)`, [NOW + 10_000]);
    sqlite.run(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
      VALUES('p','skewed-start','skewed','token','session.start','cli','{}','hash',?1,?2)`, [NOW + 4 * MINUTE, NOW + 10_000]);
    await upgrade();
    expect(await provisionedHarnessAttention(db, NOW + 30_000)).toEqual([]);
    await recordProvisionedHarnessReport(db, 'machine', { harnesses: [{ ...fact('codex', 'trust_required', 'Trust Codex.'), hookRepairAt: NOW + MINUTE }] }, NOW + MINUTE);
    expect(await provisionedHarnessAttention(db, NOW + 90_000)).toEqual([expect.objectContaining({ kind: 'harness_needs_repair', harness: 'codex' })]);
  } finally { sqlite.close(); }
});
