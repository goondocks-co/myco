import { expect, it, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker } from '@myco/runner/loop.js';
import { writeRunDir, discardRunDir } from '@myco/runner/mcp-config.js';
import { beginRunProcess } from '@myco/runner/run-directory.js';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { FEATURES_HEADER } from '@goondocks/myco-shared/member-protocol';
import { EXECUTION_PROFILE_FEATURE } from '@goondocks/myco-shared/execution-profile';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

it('an attached idle worker retries disposal after its recorded harness owner exits', async () => {
  const root = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-discard-retry-')));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const runs = join(root, 'runs');
  for (const path of [home, bin, runs]) mkdirSync(path);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const before = { ...process.env };
  Object.assign(process.env, { HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), MYCO_HOME: join(home, '.myco'), PATH: `${bin}:/usr/bin:/bin` });
  resetMachineIdCache();
  const stopping = new AbortController();
  const pid = process.pid + 1_000_002;
  let alive = true;
  const originalKill = process.kill;
  const probe = spyOn(process, 'kill').mockImplementation((target, signal) => {
    if (target !== (process.platform === 'win32' ? pid : -pid) || signal !== 0) return originalKill(target, signal);
    if (alive) return true;
    throw Object.assign(new Error('absent synthetic owner'), { code: 'ESRCH' });
  });
  try {
    const { scratchDir } = writeRunDir(runs, 'run_waiting', { serverUrl: 'https://fixture.invalid', projectId: 'proj_1', runToken: 'synthetic-run-token' });
    beginRunProcess(scratchDir)!.started(pid);
    expect(() => discardRunDir(scratchDir)).toThrow('still has a harness owner');
    let claims = 0;
    const present: boolean[] = [];
    await runWorker({ serverUrl: 'https://fixture.invalid', token: 'fixture', runRoot: runs, lockDir: null, only: ['claude-code'], pollIdleMs: 1, signal: stopping.signal, log: () => {},
      fetchImpl: (async (input) => {
        if (new URL(String(input)).pathname === '/worker/claim') {
          present.push(existsSync(scratchDir));
          if (++claims === 1) alive = false;
          else stopping.abort();
        }
        return Response.json({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 1 }, { headers: { [FEATURES_HEADER]: EXECUTION_PROFILE_FEATURE } });
      }) as typeof fetch,
    });
    expect(claims).toBe(2);
    expect(present).toEqual([true, false]);
  } finally {
    stopping.abort(); probe.mockRestore(); resetMachineIdCache();
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});
