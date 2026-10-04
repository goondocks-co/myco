import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemberSpool } from '@myco/member/spool.js';
import { readSessionState, sessionStatePath } from '@myco/member/session-state.js';
import { findGitBinary } from '@myco/utils/git.js';
import { __resetGitBinaryCacheForTest } from '@myco/utils/git.js';
import { sessionEndGitFacts } from '@myco/member/git-facts.js';
import { canStartRequest, resolveHookBudget } from '@myco/member/budget.js';
import { REPO_ROOT } from '../helpers/import-closure.ts';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

describe.skipIf(process.platform === 'win32')('SessionEnd Git enrichment budget', () => {
  for (const nearDeadline of [false, true]) {
    it(nearDeadline ? 'skips optional Git near the hook deadline so inline delivery can still start' : 'bounds synchronous Git discovery by the same optional deadline', async () => {
      const root = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-git-fallback-')));
      const fake = path.join(root, 'slow-git.js');
      const called = path.join(root, 'git-called');
      fs.writeFileSync(fake, `require('node:fs').writeFileSync(${JSON.stringify(called)}, 'called');\nsetTimeout(() => process.exit(0), 4000);\n`);
      fs.writeFileSync(path.join(root, 'git'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
      const oldPath = process.env.PATH;
      const oldGitDir = process.env.GIT_DIR;
      process.env.PATH = `${root}${path.delimiter}${oldPath}`;
      process.env.GIT_DIR = path.join(root, 'steered.git');
      __resetGitBinaryCacheForTest();
      try {
        const started = Date.now();
        const budget = resolveHookBudget('claude-code', 'session-end', { startedAt: started });
        if (nearDeadline) budget.deadline = started + budget.connectTimeoutMs + 100;
        const facts = await sessionEndGitFacts(root, budget);
        expect(Date.now() - started).toBeLessThan(850);
        expect(facts).toEqual({ headSha: undefined, dirty: undefined });
        expect(fs.existsSync(called)).toBe(!nearDeadline);
        if (nearDeadline) expect(canStartRequest(budget)).toBe(true);
      } finally {
        if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
        if (oldGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldGitDir;
        __resetGitBinaryCacheForTest();
      }
    });
  }

  it('commits mandatory end capture and the transcript receipt before slow Git, leaving time for inline delivery', () => {
    const root = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-end-budget-')));
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    const mycoHome = path.join(home, '.myco');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(repo); fs.mkdirSync(home); fs.mkdirSync(bin);
    const realGit = findGitBinary();
    const git = (...args: string[]) => execFileSync(realGit, args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
    git('add', 'tracked.txt');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'fixture');
    const spool = new MemberSpool('proj_budget', { mycoHome });
    const transcript = path.join(root, 'end.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'save before exit' } }) + '\n');
    const observation = path.join(root, 'git-observation.jsonl');
    const fakeGit = path.join(root, 'slow-git.js');
    fs.writeFileSync(fakeGit, [
      "const fs = require('node:fs');",
      `const spoolDir = ${JSON.stringify(spool.dir)};`,
      `const stateFile = ${JSON.stringify(sessionStatePath(spool.dir, 'sess-budget'))};`,
      `const observation = ${JSON.stringify(observation)};`,
      "const journal = fs.existsSync(spoolDir) ? fs.readdirSync(spoolDir).filter(f => f.endsWith('.jsonl')).map(f => fs.readFileSync(require('node:path').join(spoolDir, f), 'utf8')).join('') : '';",
      "fs.appendFileSync(observation, JSON.stringify({ pid: process.pid, committed: journal.includes('session.end'), receipt: fs.existsSync(stateFile) }) + '\\n');",
      'setTimeout(() => process.exit(0), 4000);',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nexec "${process.execPath}" "${fakeGit}" "$@"\n`, { mode: 0o755 });
    const fetchLog = path.join(root, 'fetch.log');
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tests/member/helpers/hook-process.ts'), 'session-end', '--symbiont', 'claude-code', '--credential', 'env'], {
      cwd: repo,
      env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), MYCO_HOME: mycoHome,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`, MYCO_SERVER_URL: 'https://member-test.invalid', MYCO_MEMBER_TOKEN: 'fixture-token', MYCO_PROJECT: 'proj_budget',
        MYCO_TEST_REFUSE_FETCH: '1', MYCO_TEST_FETCH_LOG: fetchLog },
      input: JSON.stringify({ session_id: 'sess-budget', hook_event_name: 'SessionEnd', transcript_path: transcript, cwd: repo }),
      encoding: 'utf-8', timeout: 2500, killSignal: 'SIGKILL',
    });
    const observations = fs.existsSync(observation) ? fs.readFileSync(observation, 'utf-8').trim().split('\n').map(line => JSON.parse(line) as { pid: number; committed: boolean; receipt: boolean }) : [];
    for (const child of observations) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already ended */ } }
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every(item => item.committed && item.receipt)).toBe(true);
    expect(result.status).toBe(0);
    expect(spool.readRecords('sess-budget').some(record => record?.kind === 'session.end')).toBe(true);
    const state = readSessionState(spool.dir, 'sess-budget');
    expect(state.transcript?.parsedSize).toBe(fs.statSync(transcript).size);
    expect(state.endedAt).toBeDefined();
    expect(fs.existsSync(fetchLog)).toBe(true);
  }, 10_000);
});
