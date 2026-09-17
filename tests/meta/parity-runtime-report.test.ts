/** What the parity driver reports about the runtime under test when a scenario fails. */
import { expect, it } from 'bun:test';
import { runScenario, type ParityScenario, type ParityTarget } from '../parity/harness.ts';

const target = (runtime?: ParityTarget['runtime']): ParityTarget => ({
  name: 'cloudflare',
  url: 'http://127.0.0.1:1',
  memberToken: 'mt_parity',
  projectId: 'proj_parity',
  ownerHeaders: () => ({}),
  memberHeaders: () => ({}),
  grantHeaders: () => ({}),
  clockWake: async () => {},
  sql: async () => [],
  ...(runtime === undefined ? {} : { runtime }),
  stop: async () => {},
});

const failing = (message: string): ParityScenario => ({
  name: 'a scenario that reaches a dead runtime',
  run: async () => { throw new Error(message); },
});

it('names the runtime that exited, its status and its last output', async () => {
  const dead = target(() => ({ alive: false, exitCode: 1, tail: 'POST /api/backups/restore-upload 400\nERROR' }));
  const raised = await runScenario(dead, failing('Unable to connect')).then(() => null, (error: Error) => error);
  expect(raised?.message).toContain('the cloudflare runtime exited (code 1)');
  expect(raised?.message).toContain('a scenario that reaches a dead runtime');
  expect(raised?.message).toContain('Unable to connect');
  expect(raised?.message).toContain('restore-upload 400');
  // The scenario's own failure is the report's cause.
  expect((raised?.cause as Error).message).toBe('Unable to connect');
});

it('reports a failure writing the runtime log, whether or not the runtime is up', async () => {
  const noisy = target(() => ({ alive: true, exitCode: null, tail: '', logFailure: '.wrangler/parity-dev-x.log: EACCES' }));
  const live = await runScenario(noisy, failing('a real assertion failed')).then(() => null, (error: Error) => error);
  expect(live?.message).toBe('a real assertion failed\nlog sink failed: .wrangler/parity-dev-x.log: EACCES');
  expect((live?.cause as Error).message).toBe('a real assertion failed');

  const gone = target(() => ({ alive: false, exitCode: 70, tail: 'ERROR', logFailure: 'disk full' }));
  const dead = await runScenario(gone, failing('Unable to connect')).then(() => null, (error: Error) => error);
  expect(dead?.message).toContain('log sink failed: disk full');
  expect(dead?.message).toContain('the cloudflare runtime exited (code 70)');
});

it('passes a live runtime\'s failure through untouched, and a target that reports none', async () => {
  const live = target(() => ({ alive: true, exitCode: null, tail: '' }));
  const raised = await runScenario(live, failing('a real assertion failed')).then(() => null, (error: Error) => error);
  expect(raised?.message).toBe('a real assertion failed');

  const silent = target();
  const quiet = await runScenario(silent, failing('a real assertion failed')).then(() => null, (error: Error) => error);
  expect(quiet?.message).toBe('a real assertion failed');

  // A scenario that passes stays passing.
  await runScenario(live, { name: 'a scenario that holds', run: async () => {} });
});
