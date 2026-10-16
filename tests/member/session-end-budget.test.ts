import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemberSpool } from '@myco/member/spool.js';
import { readSessionState, sessionStatePath } from '@myco/member/session-state.js';
import { findGitBinary } from '@myco/utils/git.js';
import { GIT_ENRICHMENT_CAP_MS } from '@myco/member/git-facts.js';
import type { GitBudgetObservation } from './helpers/git-budget-probe.js';
import { REPO_ROOT } from '../helpers/import-closure.ts';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const OBSERVATION_BOUND_MS = 30_000;
const EXPECTED_GIT_ALLOWANCE_MS = 500;
const BUDGET_PROCESS = path.join(REPO_ROOT, 'tests/member/helpers/git-budget-process.ts');
const observations = (log: string): GitBudgetObservation[] => fs.existsSync(log)
  ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

describe.skipIf(process.platform === 'win32')('SessionEnd Git enrichment budget', () => {
  for (const nearDeadline of [false, true]) {
    it(nearDeadline ? 'skips optional Git near the hook deadline so inline delivery can still start' : 'bounds synchronous Git discovery by the same optional deadline', async () => {
      const root = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-git-fallback-')));
      const log = path.join(root, 'git.jsonl');
      const resultFile = path.join(root, 'result.json');
      const result = spawnSync(process.execPath, [BUDGET_PROCESS, 'facts', root, resultFile, String(nearDeadline)], {
        cwd: root, env: { ...process.env, MYCO_TEST_GIT_BUDGET_PROBE: log },
        encoding: 'utf8', timeout: OBSERVATION_BOUND_MS,
      });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      const recorded = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      expect(GIT_ENRICHMENT_CAP_MS).toBe(EXPECTED_GIT_ALLOWANCE_MS);
      expect(recorded.facts).toEqual({});
      expect(recorded.canDeliver).toBe(true);
      expect(recorded.elapsed).toBe(nearDeadline ? 0 : GIT_ENRICHMENT_CAP_MS);
      const calls = observations(log);
      expect(calls).toHaveLength(nearDeadline ? 0 : 1);
      if (!nearDeadline) expect(calls[0]).toMatchObject({ phase: 'start', timeout: GIT_ENRICHMENT_CAP_MS, signal: 'SIGKILL' });
    }, OBSERVATION_BOUND_MS * 2);
  }

  it('commits mandatory end capture and the transcript receipt before slow Git, leaving time for inline delivery', () => {
    const root = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-end-budget-')));
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    const mycoHome = path.join(home, '.myco');
    fs.mkdirSync(repo); fs.mkdirSync(home);
    const realGit = findGitBinary();
    const git = (...args: string[]) => execFileSync(realGit, args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
    git('add', 'tracked.txt');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'fixture');
    const spool = new MemberSpool({ projectId: 'proj_budget', serverUrl: 'https://member-test.invalid' }, { mycoHome });
    const transcript = path.join(root, 'end.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'save before exit' } }) + '\n');
    const observation = path.join(root, 'git-observation.jsonl');
    const fetchLog = path.join(root, 'fetch.log');
    const result = spawnSync(process.execPath, [BUDGET_PROCESS, 'session-end', '--symbiont', 'claude-code', '--credential', 'env'], {
      cwd: repo,
      env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), MYCO_HOME: mycoHome,
        MYCO_TEST_GIT_BUDGET_PROBE: observation, MYCO_TEST_GIT_SPOOL_DIR: spool.dir,
        MYCO_TEST_GIT_STATE_FILE: sessionStatePath(spool.dir, 'sess-budget'),
        MYCO_SERVER_URL: 'https://member-test.invalid', MYCO_MEMBER_TOKEN: 'fixture-token', MYCO_PROJECT: 'proj_budget',
        MYCO_TEST_REFUSE_FETCH: '1', MYCO_TEST_FETCH_LOG: fetchLog },
      input: JSON.stringify({ session_id: 'sess-budget', hook_event_name: 'SessionEnd', transcript_path: transcript, cwd: repo }),
      encoding: 'utf-8', timeout: OBSERVATION_BOUND_MS, killSignal: 'SIGKILL',
    });
    expect({ status: result.status, signal: result.signal }).toEqual({ status: 0, signal: null });
    const calls = observations(observation).filter(item => item.args[0] === 'diff');
    expect(calls.filter(item => item.phase === 'start').map(item => item.args.join(' ')).sort())
      .toEqual(['diff --cached --quiet --', 'diff --quiet --']);
    expect(calls.map(item => item.phase)).toEqual(['start', 'deadline', 'start', 'deadline', 'kill', 'kill']);
    expect(calls.filter(item => item.phase === 'deadline').map(item => item.timeout)).toEqual([GIT_ENRICHMENT_CAP_MS, GIT_ENRICHMENT_CAP_MS]);
    expect(calls.filter(item => item.phase === 'kill').map(item => item.signal)).toEqual(['SIGKILL', 'SIGKILL']);
    expect(calls.every(item => item.committed && item.receipt)).toBe(true);
    expect(spool.readRecords('sess-budget').some(record => record?.kind === 'session.end')).toBe(true);
    const state = readSessionState(spool.dir, 'sess-budget');
    expect(state.transcript?.parsedSize).toBe(fs.statSync(transcript).size);
    expect(state.endedAt).toBeDefined();
    expect(fs.existsSync(fetchLog)).toBe(true);
  }, OBSERVATION_BOUND_MS * 2);
});
