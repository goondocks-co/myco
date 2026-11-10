import { expect } from 'bun:test';
import { toBase64Url } from '@myco-server-worker/base64.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.ts';
import { documentsPublished } from '../harness.ts';
import { client, event, owner, pick, setting, type RouteTarget, type SeedTarget } from './requests.ts';

/** The runs, runner and backup a Deployment's owner started. */
export interface RunsSeed {
  queued: string;
  claimed: string;
  runner: { id: string; token: string };
  backup: string;
}

const dispatch = async (target: SeedTarget): Promise<string> => {
  const answer = await owner(target, '/api/harness/dispatch', { method: 'POST', body: JSON.stringify({ task: 'title-summary', projectId: target.projectId, timeoutSeconds: 120 }) });
  expect(answer.status).toBe(200);
  return String(answer.body.runId);
};

/**
 * A runner the owner approved through the device flow, which reports its model catalog and claims the turn cards an
 * ended session is due (an attempt), a run the owner dispatched and left queued, and a backup the owner made.
 */
export async function seedRuns(target: SeedTarget, stamp: number, ended: string): Promise<RunsSeed> {
  // The owner lets workers run scheduled work within a daily budget, on a harness each worker signs in itself.
  for (const [leaf, value] of [['agent.harnesses.claude-code.credential', 'worker-login'], ['agent.scheduled_tasks_enabled', true], ['agent.budget.daily_usd', 1]] as const) {
    expect((await setting(target, `/api/settings/${leaf}`, { value })).status).toBe(200);
  }
  // An ended session is due for its turn cards, which the runner claims.
  await event(target, ended, 'session.end', { endedAt: stamp - 3_000_000 }, stamp - 3_000_000);
  await documentsPublished(target, ended);
  const token = `mycorun_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const started = await client(target, '/auth/runner/start', { name: 'upgrade-mini', machineId: `upgrade-runner-${stamp}`, machineName: 'Upgrade mini', os: 'linux', candidate: token });
  expect(started.status).toBe(200);
  const approved = await owner(target, '/api/device/approve-runner', { method: 'POST', body: JSON.stringify({ user_code: started.body.user_code }) });
  expect(approved.status).toBe(200);
  expect((await client(target, '/auth/runner/poll', { device_code: started.body.device_code })).body).toMatchObject({ registered: true });
  const runner = { id: String(approved.body.runnerId), token };
  expect((await client(target, '/runners/contact', { machineId: `upgrade-runner-${stamp}` }, token)).body).toMatchObject({ persisted: true });
  const catalog = await client(target, '/worker/models', { catalog: {
    observedOrder: 1, harness: 'opencode', source: { kind: 'command', command: 'opencode models' }, signIn: 'worker-login', fetchedAt: stamp,
    models: [{ id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }],
  } }, token);
  expect(catalog.status).toBe(200);
  const claim = await client(target, '/worker/claim', { harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES }, token);
  expect(claim.body).toMatchObject({ claimed: true });
  const claimed = String(claim.body.run.id);
  const queued = await dispatch(target);
  const backup = await owner(target, '/api/backups', { method: 'POST', body: '{}' });
  expect(backup.status).toBe(200);
  return { queued, claimed, runner, backup: String(backup.body.backup.id) };
}

/** What the owner reads of the seeded runs, runner, catalog and backup. */
export async function observeRuns(target: RouteTarget, seed: RunsSeed): Promise<Record<string, unknown>> {
  const project = `/api/projects/${target.projectId}`;
  const run = async (id: string) => {
    const answer = await owner(target, `${project}/runs/${id}`);
    return [answer.status, pick(answer.body.run, ['id', 'task', 'status', 'startedBy']), answer.body.attemptCount];
  };
  const runners = await owner(target, '/api/runners');
  const backups = await owner(target, '/api/backups');
  return {
    queued: await run(seed.queued),
    claimed: await run(seed.claimed),
    runner: [runners.status, (runners.body.runners ?? []).filter((row: { id: string }) => row.id === seed.runner.id).map((row: { models?: unknown[] }) => ({
      ...pick(row, ['id', 'name', 'state', 'offers']),
      // The model catalog the runner reported.
      models: (row.models ?? []).map((catalog) => pick(catalog, ['harness', 'source', 'available', 'fetchedAt'])),
    }))],
    backup: [backups.status, (backups.body.backups ?? []).filter((row: { id: string }) => row.id === seed.backup).map((row: unknown) => pick(row, ['id', 'present']))],
  };
}
