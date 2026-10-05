import { describe, expect, it, spyOn } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from '../support/fenced-fs.mjs';
import fs from 'node:fs';
import { discardRunDir, writeRunDir } from '@myco/runner/mcp-config.js';
import { beginRunProcess, recoverAbandonedRunDirectories, RUN_DIRECTORY_MANIFEST } from '@myco/runner/run-directory.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';
import { runWorker } from '@myco/runner/loop.js';
import { profileWorkerServer } from '../helpers/profile-worker-server.js';

const CONNECTION = { serverUrl: 'https://deployment.example', projectId: 'project-test', runToken: 'synthetic-run-credential' };
const root = () => removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-recovery-')));

async function worker(runs: string, target: string, processGroup = false, serverUrl = CONNECTION.serverUrl): Promise<{ child: ChildProcess; scratchDir: string }> {
  const script = join(runs, '..', `worker-${crypto.randomUUID()}.ts`);
  writeFileSync(script, `import { writeRunDir } from ${JSON.stringify(resolve('packages/myco/src/runner/mcp-config.ts'))};
import fs from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { beginRunProcess } from ${JSON.stringify(resolve('packages/myco/src/runner/run-directory.ts'))};
const run = writeRunDir(${JSON.stringify(runs)}, 'run_test', ${JSON.stringify({ ...CONNECTION, serverUrl })});
fs.mkdirSync(join(run.scratchDir, 'codex'), { mode: 0o700 });
fs.writeFileSync(join(run.scratchDir, 'codex', 'auth.json'), 'synthetic-provider-credential');
fs.symlinkSync(${JSON.stringify(target)}, join(run.scratchDir, 'login-link'));
if (${processGroup}) {
  const launch = beginRunProcess(run.scratchDir);
  const harness = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', stdio: 'ignore', env: process.env });
  launch.started(harness.pid);
}
console.log(run.scratchDir);
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, ['--no-env-file', script], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const [data] = await once(child.stdout!, 'data');
  return { child, scratchDir: String(data).trim() };
}

async function kill(child: ChildProcess): Promise<void> {
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
}

describe('run directory ownership and dead-worker recovery', () => {
  it('reclaims a SIGKILLed worker while preserving another active worker and credential symlink targets', async () => {
    const base = root();
    const runs = join(base, 'runs');
    mkdirSync(runs);
    const login = join(base, 'login.json');
    writeFileSync(login, 'synthetic-login-target');
    const abandoned = await worker(runs, login);
    const active = await worker(runs, login, false, 'https://other-deployment.example');
    try {
      await kill(abandoned.child);
      const recovered = recoverAbandonedRunDirectories(runs);
      expect(recovered.recovered).toBe(1);
      expect(existsSync(abandoned.scratchDir)).toBe(false);
      expect(readFileSync(join(active.scratchDir, 'codex', 'auth.json'), 'utf8')).toBe('synthetic-provider-credential');
      expect(readFileSync(login, 'utf8')).toBe('synthetic-login-target');
      expect(recoverAbandonedRunDirectories(runs).recovered).toBe(0);
    } finally {
      if (abandoned.child.signalCode === null) await kill(abandoned.child);
      await kill(active.child);
    }
    expect(recoverAbandonedRunDirectories(runs).recovered).toBe(1);
  });

  it('retains the manifest when cleanup is interrupted and retries idempotently', async () => {
    const base = root();
    const runs = join(base, 'runs');
    mkdirSync(runs);
    const login = join(base, 'login.json');
    writeFileSync(login, 'synthetic-login-target');
    const abandoned = await worker(runs, login);
    await kill(abandoned.child);
    const original = fs.rmSync;
    const failure = spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path).endsWith('/codex')) throw new Error('interrupted cleanup');
      return original(path, options);
    });
    try {
      expect(() => recoverAbandonedRunDirectories(runs)).toThrow('Run directory cleanup failed');
    } finally { failure.mockRestore(); }
    expect(existsSync(join(abandoned.scratchDir, RUN_DIRECTORY_MANIFEST))).toBe(true);
    expect(recoverAbandonedRunDirectories(runs).recovered).toBe(1);
    expect(recoverAbandonedRunDirectories(runs).recovered).toBe(0);
    expect(readFileSync(login, 'utf8')).toBe('synthetic-login-target');
  });

  it('preserves unowned, malformed, foreign-machine, and symlinked directories', async () => {
    const runs = root();
    const target = root();
    writeFileSync(join(target, 'auth.json'), 'synthetic-target');
    mkdirSync(join(runs, 'unowned'));
    mkdirSync(join(runs, 'malformed'));
    writeFileSync(join(runs, 'malformed', RUN_DIRECTORY_MANIFEST), '{');
    symlinkSync(target, join(runs, 'linked'));
    const foreign = await worker(runs, target);
    await kill(foreign.child);
    const manifest = JSON.parse(readFileSync(join(foreign.scratchDir, RUN_DIRECTORY_MANIFEST), 'utf8'));
    writeFileSync(join(foreign.scratchDir, RUN_DIRECTORY_MANIFEST), JSON.stringify({ ...manifest, machineId: 'other-machine' }));
    expect(recoverAbandonedRunDirectories(runs).recovered).toBe(0);
    expect(existsSync(join(runs, 'unowned'))).toBe(true);
    expect(readFileSync(join(target, 'auth.json'), 'utf8')).toBe('synthetic-target');
    expect(existsSync(join(foreign.scratchDir, 'mcp.json'))).toBe(true);
  });

  it('refuses disposal with an active harness group or an unfinished launch', async () => {
    const run = writeRunDir(root(), 'run_owned', CONNECTION);
    const launch = beginRunProcess(run.scratchDir)!;
    expect(() => discardRunDir(run.scratchDir)).toThrow();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', stdio: 'ignore', env: process.env });
    launch.started(child.pid!);
    try { expect(() => discardRunDir(run.scratchDir)).toThrow(); }
    finally { await kill(child); }
    discardRunDir(run.scratchDir);
    discardRunDir(run.scratchDir);
    expect(existsSync(run.scratchDir)).toBe(false);
  });

  it('preserves a dead worker directory until its registered harness group is gone', async () => {
    const base = root();
    const runs = join(base, 'runs');
    mkdirSync(runs);
    const login = join(base, 'login.json');
    writeFileSync(login, 'synthetic-login-target');
    const abandoned = await worker(runs, login, true);
    const manifest = JSON.parse(readFileSync(join(abandoned.scratchDir, RUN_DIRECTORY_MANIFEST), 'utf8'));
    const pid = manifest.processGroups[0] as number;
    try {
      await kill(abandoned.child);
      expect(recoverAbandonedRunDirectories(runs).recovered).toBe(0);
      expect(existsSync(join(abandoned.scratchDir, 'mcp.json'))).toBe(true);
    } finally {
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
      if (abandoned.child.signalCode === null) await kill(abandoned.child);
    }
    const deadline = Date.now() + 2_000;
    let recovered = 0;
    while (Date.now() < deadline && recovered === 0) {
      recovered = recoverAbandonedRunDirectories(runs).recovered;
      if (recovered === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(recovered).toBe(1);
    expect(readFileSync(login, 'utf8')).toBe('synthetic-login-target');
  });

  it('keeps attempt metadata private and excludes credentials from ownership records', () => {
    const run = writeRunDir(root(), 'run_manifest', CONNECTION, null, 'attempt-2');
    const path = join(run.scratchDir, RUN_DIRECTORY_MANIFEST);
    const text = readFileSync(path, 'utf8');
    expect(JSON.parse(text)).toMatchObject({ runId: 'run_manifest', attemptId: 'attempt-2', projectId: CONNECTION.projectId, pid: process.pid });
    expect(text).not.toContain(CONNECTION.runToken);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(run.scratchDir).mode & 0o777).toBe(0o700);
    }
    discardRunDir(run.scratchDir);
  });

  it('preserves dead-owner directories when process probes are uncertain', async () => {
    const base = root();
    const runs = join(base, 'runs');
    mkdirSync(runs);
    const login = join(base, 'login.json');
    writeFileSync(login, 'synthetic-login-target');
    const abandoned = await worker(runs, login);
    const pid = abandoned.child.pid!;
    await kill(abandoned.child);
    const original = process.kill;
    for (const code of ['EPERM', 'ENOSYS']) {
      const probe = spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (target === pid && signal === 0) throw Object.assign(new Error('uncertain owner'), { code });
        return original(target, signal);
      });
      try {
        expect(recoverAbandonedRunDirectories(runs).recovered).toBe(0);
        expect(existsSync(join(abandoned.scratchDir, 'codex', 'auth.json'))).toBe(true);
      } finally { probe.mockRestore(); }
    }
    expect(recoverAbandonedRunDirectories(runs).recovered).toBe(1);
  });

  it('preserves an interrupted process launch after its worker dies', async () => {
    const base = root();
    const runs = join(base, 'runs');
    mkdirSync(runs);
    const login = join(base, 'login.json');
    writeFileSync(login, 'synthetic-login-target');
    const abandoned = await worker(runs, login);
    const file = join(abandoned.scratchDir, RUN_DIRECTORY_MANIFEST);
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...manifest, pendingStarts: ['unfinished-launch'] }));
    await kill(abandoned.child);
    expect(recoverAbandonedRunDirectories(runs).recovered).toBe(0);
    expect(existsSync(join(abandoned.scratchDir, 'codex', 'auth.json'))).toBe(true);
  });

  it('reclaims an abandoned allocation through the restarted worker startup before its first claim', async () => {
    const base = root();
    const runs = join(base, 'runs');
    mkdirSync(runs);
    const login = join(base, 'login.json');
    writeFileSync(login, 'synthetic-login-target');
    const abandoned = await worker(runs, login);
    const active = await worker(runs, login);
    await kill(abandoned.child);
    const stop = new AbortController();
    let claimed = false;
    let abandonedPresentAtClaim = true;
    let activePresentAtClaim = false;
    const fetchImpl = profileWorkerServer((async () => {
      claimed = true;
      abandonedPresentAtClaim = existsSync(abandoned.scratchDir);
      activePresentAtClaim = existsSync(join(active.scratchDir, 'codex', 'auth.json'));
      stop.abort();
      return Response.json({ claimed: false, reason: 'no_work' });
    }) as unknown as typeof fetch);
    try {
      await runWorker({ serverUrl: CONNECTION.serverUrl, token: 'synthetic-member', lockDir: null, runRoot: runs,
        only: [], pollIdleMs: 1, log: () => {}, fetchImpl, signal: stop.signal,
      });
      expect(claimed).toBe(true);
      expect(abandonedPresentAtClaim).toBe(false);
      expect(activePresentAtClaim).toBe(true);
      expect(readFileSync(login, 'utf8')).toBe('synthetic-login-target');
    } finally { stop.abort(); await kill(active.child); }
  });

  it('does not follow a directory symlink even when its target has a valid dead-owner manifest', async () => {
    const base = root();
    const runs = join(base, 'runs');
    const outside = join(base, 'outside');
    mkdirSync(runs);
    mkdirSync(outside);
    const login = join(base, 'login.json');
    writeFileSync(login, 'synthetic-login-target');
    const abandoned = await worker(outside, login);
    await kill(abandoned.child);
    symlinkSync(abandoned.scratchDir, join(runs, basename(abandoned.scratchDir)));
    expect(recoverAbandonedRunDirectories(runs).recovered).toBe(0);
    expect(readFileSync(join(abandoned.scratchDir, 'codex', 'auth.json'), 'utf8')).toBe('synthetic-provider-credential');
    expect(readFileSync(login, 'utf8')).toBe('synthetic-login-target');
  });
});
