/** The rig the run audit tests drive: a Deployment, its runners and its dashboard, through the deployed pipeline. */
import { expect } from 'bun:test';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { createServer } from '@myco-server-worker/pipeline.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/constants.js';
import { titleSession } from '@myco-server-worker/core/titling.js';
import { toBase64Url } from '@myco-server-worker/base64.js';
import type { OfferedHarness } from '@myco-server-worker/core/worker-selection.js';
import { runningEnv } from './running-env.js';
import { PROTOCOL, publishFixture, turnOnGatedCapabilities } from './fixtures.js';
import { OWNER_ENV, ownerCookie } from './owner.js';
import { offeredHarness } from './offered-harness.js';

const HOUR = 3_600_000;
/** The rig's clock at start: ten minutes into an hour. */
export const NOW = 1_800_000_000_000 - (1_800_000_000_000 % HOUR) + 10 * 60_000;
const OWNER = 'mem_machine_1';
const OWNER_SUB = '583231';
const OFFERED: OfferedHarness[] = [offeredHarness('claude-code')];
export type Json = Record<string, any>;

/**
 * A running Deployment reached only through its pipeline, as a runner and the owner's dashboard reach it: runners
 * registered through the device flow, titling runs queued as a session's end queues one, and a clock the test moves.
 */
export function runnerRig() {
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
  const claim = (token: string, harnesses: readonly OfferedHarness[] = OFFERED) => asRunner(token, '/worker/claim', { harnesses, capabilities: WORKER_CAPABILITIES });
  return { e, get, asRunner, register, queueTitling, claim, now: () => now, at: (instant: number) => { now = instant; } };
}
