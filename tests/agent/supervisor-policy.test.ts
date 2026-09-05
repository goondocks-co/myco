/**
 * The harness supervisor's rules, without a process.
 *
 * Every refusal the launch endpoint answers, the drain, and the exit condition
 * are decided here, so the integration test can be about sockets and children
 * rather than about which answer is correct.
 */
import { describe, expect, it } from 'bun:test';
import {
  bearerMatches, decideChildExit, decideLaunch, decideSignal,
  LAUNCH_REFUSAL_STATUS, RUN_ID_PATTERN, type SupervisorState,
} from '@myco/agent/runtime/supervisor-policy.js';

const idle: SupervisorState = { draining: false, running: [] };
const holding = (...running: string[]): SupervisorState => ({ draining: false, running });
const draining = (...running: string[]): SupervisorState => ({ draining: true, running });

describe('what a launch is answered with', () => {
  it('admits a run this supervisor is not already running', () => {
    expect(decideLaunch(idle, 'run_1')).toEqual({ admit: true });
    expect(decideLaunch(holding('run_1', 'run_2'), 'run_3')).toEqual({ admit: true });
  });

  it('refuses a run id it is already running, which would be two runtimes for one run', () => {
    expect(decideLaunch(holding('run_1'), 'run_1')).toEqual({ admit: false, refusal: 'duplicate' });
    expect(decideLaunch(holding('run_0', 'run_1'), 'run_1')).toEqual({ admit: false, refusal: 'duplicate' });
  });

  it('refuses everything while draining, including a run it has never seen', () => {
    expect(decideLaunch(draining(), 'run_1')).toEqual({ admit: false, refusal: 'draining' });
    expect(decideLaunch(draining('run_1'), 'run_2')).toEqual({ admit: false, refusal: 'draining' });
    // The drain is the answer even where a duplicate would also apply: neither starts.
    expect(decideLaunch(draining('run_1'), 'run_1')).toEqual({ admit: false, refusal: 'draining' });
  });

  it('refuses a body that names no run, or names one that is not a single path segment', () => {
    for (const runId of [undefined, null, '', 42, {}, '../escape', 'a/b', 'has space', '.hidden', 'x'.repeat(129)]) {
      expect({ runId, decision: decideLaunch(idle, runId) })
        .toEqual({ runId, decision: { admit: false, refusal: 'invalid' } });
    }
  });

  it('admits the run ids the dispatcher actually mints', () => {
    expect(RUN_ID_PATTERN.test(`run_${crypto.randomUUID()}`)).toBe(true);
    expect(RUN_ID_PATTERN.test('run_drained')).toBe(true);
  });

  it('answers each refusal with the status its caller acts on', () => {
    expect(LAUNCH_REFUSAL_STATUS).toEqual({ invalid: 400, duplicate: 409, draining: 503, spawn: 500 });
  });
});

describe('what a child leaving means', () => {
  it('drops the run and keeps serving while nothing has asked this supervisor to stop', () => {
    expect(decideChildExit(holding('run_1', 'run_2'), 'run_1')).toEqual({ running: ['run_2'], exit: false });
    expect(decideChildExit(holding('run_1'), 'run_1')).toEqual({ running: [], exit: false });
  });

  it('leaves with the last run a draining supervisor holds, and not before', () => {
    expect(decideChildExit(draining('run_1', 'run_2'), 'run_1')).toEqual({ running: ['run_2'], exit: false });
    expect(decideChildExit(draining('run_2'), 'run_2')).toEqual({ running: [], exit: true });
  });

  it('is unmoved by a run it is not running', () => {
    expect(decideChildExit(draining('run_1'), 'run_9')).toEqual({ running: ['run_1'], exit: false });
  });
});

describe('what a stop signal means', () => {
  it('drains, naming the children to stop, while runs are in flight', () => {
    expect(decideSignal(holding('run_1', 'run_2'))).toEqual({ action: 'drain', stop: ['run_1', 'run_2'] });
  });

  it('leaves at once when it holds nothing', () => {
    expect(decideSignal(idle)).toEqual({ action: 'exit' });
  });

  it('leaves at once on a second signal, however many runs are still in flight', () => {
    expect(decideSignal(draining('run_1', 'run_2'))).toEqual({ action: 'exit' });
    expect(decideSignal(draining())).toEqual({ action: 'exit' });
  });
});

describe('what a launch has to present', () => {
  it('accepts the token under the scheme HTTP defines, in any case', () => {
    expect(bearerMatches('Bearer tok', 'tok')).toBe(true);
    expect(bearerMatches('bearer tok', 'tok')).toBe(true);
    expect(bearerMatches('  Bearer   tok  ', 'tok')).toBe(true);
  });

  it('refuses a missing header, another scheme, and a token that is merely close', () => {
    for (const header of [null, undefined, '', 'tok', 'Basic tok', 'Bearer', 'Bearer ', 'Bearer to', 'Bearer tokk', 'Bearer TOK']) {
      expect({ header, ok: bearerMatches(header, 'tok') }).toEqual({ header, ok: false });
    }
  });

  it('refuses everything when this supervisor holds no token of its own', () => {
    expect(bearerMatches('Bearer ', '')).toBe(false);
    expect(bearerMatches('Bearer tok', '')).toBe(false);
  });
});
