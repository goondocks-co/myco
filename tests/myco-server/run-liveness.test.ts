/**
 * The three liveness facts the Runs page and run panel show, each recorded on the path that already writes beside it
 * and read back through the dashboard's routes:
 * - a renewal of a run's lease records when it renewed, so the panel can measure the silence from it;
 * - a runner's recorded contact counts its check-in in its hour, so the Runs page shows each runner's check-ins;
 * - a claim keeps on the attempt the hold its run waited under and when that stay in the queue began;
 * - every stay in the queue counts as one wait by the hours it began and ended, however the run left the queue: taken,
 *   or expired unclaimed, and a run back in the queue waits again from then,
 *   never through the hours it was running.
 * The wake drops check-in and wait hours past the kept window at the same whole hour as the run counts.
 *
 * Every request goes through the deployed pipeline the way a runner and a dashboard reach it.
 */
import { describe, expect, it } from 'bun:test';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { createServer } from '@myco-server-worker/pipeline.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/constants.js';
import { titleSession } from '@myco-server-worker/core/titling.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import { runStaleSweep } from '@myco-server-worker/core/jobs-run.js';
import { expireLeases } from '@myco-server-worker/core/harness.js';
import { RUN_HOUR_RETENTION_MS } from '@myco-server-worker/db/runs/run-hours.js';
import { toBase64Url } from '@myco-server-worker/base64.js';
import { runningEnv } from './helpers/running-env.js';
import { PROTOCOL, publishFixture, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { offeredHarness } from './helpers/offered-harness.js';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000 - (1_800_000_000_000 % HOUR) + 10 * 60_000;
const OWNER = 'mem_machine_1';
const OWNER_SUB = '583231';
const OFFERED = [offeredHarness('claude-code')];
type Json = Record<string, any>;

function rig() {
  const e = runningEnv({ workerLogin: true });
  turnOnGatedCapabilities(e.sqlite);
  e.sqlite.run('UPDATE deployment_ownership SET member_id = ?, revision = 1 WHERE id = 1', [OWNER]);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', ?, 'member')`, [HARNESS_MEMBER_ID, NOW]);
  let now = NOW;
  const server = createServer({ now: () => now, sourceOf: () => '192.0.2.10', fetchImpl: () => { throw new Error('unexpected OAuth'); } });
  const env = { ...e.serverEnv, secrets: OWNER_ENV };
  const send = (path: string, init: RequestInit) => server.handleRequest(new Request(`https://s${path}`, init), env);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    send(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://s', ...headers }, body: JSON.stringify(body) });
  const json = async (res: Response | Promise<Response>): Promise<Json> => {
    const answer = await res;
    if (answer.status !== 200) throw new Error(`${answer.status} ${await answer.text()}`);
    return await answer.json() as Json;
  };
  const get = async (path: string) => json(send(path, { method: 'GET', headers: { cookie: await ownerCookie(e.db, now, OWNER_SUB) } }));
  const asRunner = (token: string, path: string, body: unknown) => json(post(path, body, { authorization: `Bearer ${token}`, ...PROTOCOL }));
  /** A runner registered through the device flow, approved by the owner. */
  const register = async (name: string) => {
    const candidate = `mycorun_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
    const started = await json(post('/auth/runner/start', { name, machineId: `rm_${crypto.randomUUID()}`, machineName: 'Mac mini', os: 'darwin', candidate }));
    const approved = await json(post('/api/device/approve-runner', { user_code: started.user_code }, { cookie: await ownerCookie(e.db, now, OWNER_SUB) }));
    now += 5_000;
    expect(await json(post('/auth/runner/poll', { device_code: started.device_code }))).toMatchObject({ registered: true });
    return { token: candidate, runnerId: approved.runnerId as string };
  };
  let sessions = 0;
  /** One title-summary run queued for a session that just ended, as a session's end queues one. */
  const queueTitling = async () => {
    const id = `s${++sessions}`;
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at) VALUES ('proj_1', ?, 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?)`, [id, now - 10_000, now, now - 10_000, now]);
    e.sqlite.run(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at) SELECT project_id,event_id,session_id,token_id,'prompt','cli',json_object('promptId',prompt_id,'text',text,'origin',origin,'updatedAt',updated_at),content_hash,created_at,received_at FROM (SELECT 'proj_1' AS project_id,? AS session_id,? AS prompt_id,? AS event_id,'add a retry to the runner' AS text,'user' AS origin,? AS content_hash,? AS created_at,? AS updated_at,'tok_1' AS token_id,? AS received_at)`, [id, `p_${id}`, `e_${id}`, `h_${id}`, now - 5000, now - 5000, now - 5000]);
    await publishFixture(e);
    expect((await titleSession(e.serverEnv, { projectId: 'proj_1', sessionId: id, now, origin: 'https://s' })).outcome).toBe('queued');
  };
  const claim = (token: string) => asRunner(token, '/worker/claim', { harnesses: OFFERED, capabilities: WORKER_CAPABILITIES });
  return { e, get, asRunner, register, queueTitling, claim, now: () => now, at: (instant: number) => { now = instant; } };
}

describe('liveness on the run panel and the Runs page', () => {
  it('a renewal records when the run last renewed its hold, and the run panel serves it', async () => {
    const r = rig();
    try {
      const { token } = await r.register('mini');
      await r.queueTitling();
      const { run } = await r.claim(token);
      expect(run).toBeDefined();
      expect((await r.get(`/api/projects/proj_1/runs/${run.id}`)).run.lastRenewedAt).toBeNull();
      r.at(r.now() + 40_000);
      expect(await r.asRunner(token, '/worker/lease', { projectId: 'proj_1', runId: run.id, attemptId: run.attemptId })).toMatchObject({ held: true });
      const renewedAt = r.now();
      r.at(r.now() + 30_000);
      expect(await r.asRunner(token, '/worker/lease', { projectId: 'proj_1', runId: run.id })).toMatchObject({ held: false });
      expect((await r.get(`/api/projects/proj_1/runs/${run.id}`)).run.lastRenewedAt).toBe(renewedAt);
    } finally { r.e.sqlite.close(); }
  });

  it('a claim keeps the hold its run waited under on the attempt, and counts the wait by the hours it was queued and taken', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register('mini');
      await r.queueTitling();
      const queuedAt = r.now();
      // While no machine could take it, the queue marked what held it.
      r.e.sqlite.run("UPDATE agent_runs SET held_by = 'budget' WHERE status = 'queued'");
      r.at(queuedAt + 2 * HOUR);
      const { run } = await r.claim(token);
      const detail = await r.get(`/api/projects/proj_1/runs/${run.id}`);
      expect(detail.attempts.map((attempt: Json) => [attempt.attemptId, attempt.waitedFor, attempt.waitedSince])).toEqual([[run.attemptId, 'budget', queuedAt]]);
      expect(detail.run.heldBy).toBeNull();

      const hours = await r.get('/api/runs/hours?window=day');
      const hourOf = (at: number) => at - (at % HOUR);
      expect(hours.waits).toEqual([{ enteredHour: hourOf(queuedAt), leftHour: hourOf(r.now()), taken: true, waits: 1 }]);
      expect(hours.stillWaiting).toEqual([]);
      expect(hours.lanes.find((lane: Json) => lane.runnerId === runnerId).checkins).toEqual([hourOf(r.now())]);
    } finally { r.e.sqlite.close(); }
  });

  it('each recorded check-in counts in its runner’s hour, and the wake drops check-in and wait hours past the kept window', async () => {
    const r = rig();
    try {
      const old = NOW - RUN_HOUR_RETENTION_MS - 2 * HOUR;
      r.at(old);
      const mini = await r.register('mini');
      await r.queueTitling();
      r.at(old + 30 * 60_000);
      expect((await r.claim(mini.token)).claimed).toBe(true);
      // A runner credential lives far shorter than the kept window: the second runner registers a month later.
      r.at(NOW - 4 * HOUR);
      const studio = await r.register('studio');
      r.at(NOW - 3 * HOUR);
      expect((await r.claim(studio.token)).claimed).toBe(false);
      r.at(NOW - HOUR);
      await r.claim(studio.token);
      r.at(NOW);
      const hourOf = (at: number) => at - (at % HOUR);

      const week = await r.get('/api/runs/hours?window=week');
      const lane = (runnerId: string) => week.lanes.find((row: Json) => row.runnerId === runnerId);
      expect(lane(studio.runnerId).checkins).toEqual([hourOf(NOW - 3 * HOUR), hourOf(NOW - HOUR)]);
      expect(lane(studio.runnerId).name).toBe('studio');
      expect(lane(mini.runnerId)).toBeUndefined();
      expect(week.recordedSince).toBe(hourOf(old));

      const waitHours = () => r.e.sqlite.query('SELECT left_hour FROM run_wait_hour').all().map((row) => (row as { left_hour: number }).left_hour);
      expect(waitHours()).toEqual([hourOf(old)]);
      await runTick(r.e.serverEnv as never, NOW);
      expect(waitHours()).toEqual([]);
      const after = await r.get('/api/runs/hours?window=week');
      expect(after.recordedSince).toBe(hourOf(NOW - 3 * HOUR));
      expect(after.lanes.find((row: Json) => row.runnerId === studio.runnerId).checkins).toEqual([hourOf(NOW - 3 * HOUR), hourOf(NOW - HOUR)]);
    } finally { r.e.sqlite.close(); }
  });

  it('a run that waited and expired unclaimed counts as a wait that no machine took', async () => {
    const r = rig();
    try {
      const { token } = await r.register('mini');
      await r.claim(token);
      await r.queueTitling();
      const queuedAt = r.now();
      for (let hour = 1; hour <= 25; hour++) {
        r.at(queuedAt + hour * HOUR);
        await r.asRunner(token, '/runners/contact', {});
      }
      await runStaleSweep(r.e.serverEnv as never, r.now());
      const hourOf = (at: number) => at - (at % HOUR);
      const week = await r.get('/api/runs/hours?window=week');
      expect(week.waits).toEqual([{ enteredHour: hourOf(queuedAt), leftHour: hourOf(r.now()), taken: false, waits: 1 }]);
      expect(week.stillWaiting).toEqual([]);
    } finally { r.e.sqlite.close(); }
  });

  it('a run back in the queue waits again from then, never through the hours it was running', async () => {
    const r = rig();
    try {
      const { token } = await r.register('mini');
      await r.queueTitling();
      const queuedAt = r.now();
      r.at(queuedAt + HOUR);
      const { run } = await r.claim(token);
      // The machine went quiet; three hours later its lapsed lease puts the run back in the queue.
      r.at(queuedAt + 4 * HOUR);
      expect(await expireLeases(r.e.serverEnv as never, r.now())).toBe(1);
      const back = r.now();
      r.at(back + 30 * 60_000);
      const again = await r.claim(token);
      expect(again.run.id).toBe(run.id);
      const hourOf = (at: number) => at - (at % HOUR);
      const day = await r.get('/api/runs/hours?window=day');
      expect(day.waits.toSorted((a: Json, b: Json) => a.enteredHour - b.enteredHour)).toEqual([
        { enteredHour: hourOf(queuedAt), leftHour: hourOf(queuedAt + HOUR), taken: true, waits: 1 },
        { enteredHour: hourOf(back), leftHour: hourOf(r.now()), taken: true, waits: 1 },
      ]);
      const detail = await r.get(`/api/projects/proj_1/runs/${run.id}`);
      expect(detail.attempts.map((attempt: Json) => attempt.waitedSince)).toEqual([queuedAt, back]);
    } finally { r.e.sqlite.close(); }
  });
});
