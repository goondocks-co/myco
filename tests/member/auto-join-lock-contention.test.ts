import { expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bindSandboxChildHome, sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { autoJoinHold, LEFT_ALONE } from '@myco/member/auto-join-hook.js';
import { isLeft, leftForConnection, markLeft, rootKeyFor } from '@myco/member/auto-join.js';
import { acquireRegistryLock, writeDeploymentMembership } from '@myco/member/registry.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { cacheMachineSettings } from '@myco/member/machine-settings.js';

const SERVER = 'https://work.example';
const HOLD_MS = 3200;
const HOOK_BOUND_MS = 200;

it('rechecks an ordinary reconnect under the acquired lock before clearing its opt-out', () => {
  const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-auto-join-recheck-'));
  const rootKey = 'a'.repeat(32);
  markLeft(rootKey, mycoHome, 1);
  const acquire = LifecycleLock.acquire;
  const racingLogout = spyOn(LifecycleLock, 'acquire').mockImplementation((file, opts) => {
    const lease = acquire(file, opts);
    if (lease.acquired) markLeft(rootKey, mycoHome, 2, { explicitJoinOnly: true, locked: true });
    return lease;
  });
  try {
    try {
      expect(leftForConnection(rootKey, mycoHome, 'proj_fixture')).toBe(true);
      expect(isLeft(rootKey, mycoHome)).toBe(true);
    } finally {
      racingLogout.mockRestore();
    }
    const released = acquireRegistryLock(mycoHome);
    expect(released.acquired).toBe(true);
    if (released.acquired) released.lock.release();
  } finally {
    fs.rmSync(mycoHome, { recursive: true, force: true });
  }
});

for (const state of ['unconnected', 'left', 'reconnecting', 'logout'] as const) {
  it(`auto-join does not wait for a busy registry when ${state}`, async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-auto-join-contention-'));
    const home = path.join(scratch, 'home');
    const mycoHome = path.join(home, '.myco');
    const root = path.join(home, 'Repos', 'homelab');
    fs.mkdirSync(root, { recursive: true });
    const restore = bindSandboxChildHome(scratch, { HOME: home, MYCO_HOME: mycoHome });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      writeDeploymentMembership({ serverUrl: SERVER, token: 'fixture-token', machineId: 'fixture-machine', joinedAt: 1, updatedAt: 1 }, { mycoHome });
      recordDefaultDeployment(SERVER, { mycoHome });
      const rootKey = rootKeyFor(root, mycoHome);
      if (state !== 'unconnected') markLeft(rootKey, mycoHome, 1, state === 'logout' ? { explicitJoinOnly: true } : {});
      cacheMachineSettings(SERVER, { leaves: {
        'capture.auto_join_roots': [path.dirname(root)],
        'capture.connect_roots': state === 'reconnecting' || state === 'logout' ? { [rootKey]: 'proj_fixture' } : {},
      } }, mycoHome);
      const ready = path.join(scratch, 'ready');
      const script = path.join(scratch, 'holder.ts');
      const registry = path.resolve(import.meta.dir, '../../packages/myco/src/member/registry.ts');
      fs.writeFileSync(script, `import fs from 'node:fs';
import { acquireRegistryLock } from ${JSON.stringify(registry)};
const lease = acquireRegistryLock(${JSON.stringify(mycoHome)});
if (!lease.acquired) throw new Error('fixture lock unavailable');
try { fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); await Bun.sleep(${HOLD_MS}); }
finally { lease.lock.release(); }
`);
      child = Bun.spawn([process.execPath, '--no-env-file', '--tsconfig-override', path.resolve(import.meta.dir, '../../tsconfig.json'), script], {
        cwd: scratch, env: sandboxChildEnv(scratch, { HOME: home, MYCO_HOME: mycoHome }), stdout: 'pipe', stderr: 'pipe',
      });
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(ready) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
      expect(fs.existsSync(ready)).toBe(true);
      const later: Array<() => void> = [];
      const started = performance.now();
      const answer = autoJoinHold({ root, hookName: 'user-prompt-submit', agent: 'claude-code', sessionId: 'fixture-session', mycoHome,
        now: Date.now(), env: { ...process.env, MYCO_TEMPORARY_FOLDERS: path.join(scratch, 'other-temp') }, later: (step) => later.push(step) });
      expect(performance.now() - started).toBeLessThan(HOOK_BOUND_MS);
      expect(child.exitCode).toBeNull();
      if (state === 'unconnected') {
        expect(answer).not.toBeNull();
        expect(answer).not.toBe(LEFT_ALONE);
      } else {
        expect(answer).toBe(LEFT_ALONE);
        expect(later).toHaveLength(0);
        expect(isLeft(rootKey, mycoHome)).toBe(true);
      }
      expect(await child.exited).toBe(0);
      if (state === 'reconnecting') {
        expect(autoJoinHold({ root, hookName: 'user-prompt-submit', agent: 'claude-code', sessionId: 'next-session', mycoHome,
          now: Date.now(), env: { ...process.env, MYCO_TEMPORARY_FOLDERS: path.join(scratch, 'other-temp') }, later: () => {} })).not.toBe(LEFT_ALONE);
        expect(isLeft(rootKey, mycoHome)).toBe(false);
      }
    } finally {
      if (child !== undefined) {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      }
      restore();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 10000);
}
