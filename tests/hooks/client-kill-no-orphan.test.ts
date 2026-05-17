import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonClient } from '@myco/hooks/client';
import { resolveServiceDaemonStatePath } from '@myco/grove/paths';
import { ensureProjectManifest } from '@myco/config/project-manifest';

/**
 * Cleanup ownership inversion: killDaemon must NOT unlink daemon.json when the
 * recorded pid is still alive. This protects against the orphan-zombie failure
 * mode where SIGTERM is sent, the target hangs in shutdown, and the state file
 * gets deleted regardless — leaving a live daemon with no discoverable handoff
 * file. Cleanup of daemon.json is owned exclusively by the successor process's
 * reconcileExistingDaemon path.
 */
describe('killDaemon cleanup ownership', () => {
  let vaultDir: string;
  let previousMycoHome: string | undefined;
  let statePath: string;
  let child: ChildProcess | null = null;

  beforeEach(() => {
    process.env.MYCO_NO_AUTO_SPAWN = '1';
    vaultDir = mkdtempSync(join(tmpdir(), 'myco-orphan-'));
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = join(vaultDir, 'home');
    ensureProjectManifest(vaultDir, { projectName: 'orphan-test' });
    statePath = resolveServiceDaemonStatePath();
    mkdirSync(dirname(statePath), { recursive: true });
  });

  afterEach(() => {
    if (child) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      child = null;
    }
    try { unlinkSync(statePath); } catch { /* gone */ }
    rmSync(vaultDir, { recursive: true, force: true });
    delete process.env.MYCO_NO_AUTO_SPAWN;
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
  });

  it('does not unlink state file when target ignores SIGTERM and stays alive', async () => {
    // Spawn a long-lived child that ignores SIGTERM — simulates a wedged daemon.
    // The child writes "ready" to stdout once the SIGTERM handler is attached,
    // so we can wait for it before sending SIGTERM (avoids a race where the
    // signal arrives before the handler is installed and the default action
    // kills the child).
    child = spawn('node', [
      '-e',
      "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)",
    ], { detached: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const childPid = child.pid!;
    expect(typeof childPid).toBe('number');

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not signal ready')), 2_000);
      child!.stdout!.once('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    writeFileSync(
      statePath,
      JSON.stringify({
        pid: childPid,
        port: 20915,
        started: new Date().toISOString(),
        version: '0.27.10',
        auth_token: 'test',
      }),
    );

    const client = new DaemonClient(vaultDir);
    (client as unknown as { killDaemon: (info: { pid: number }) => void }).killDaemon({ pid: childPid });

    // Give a moment for any async unlink to settle.
    await new Promise((r) => setTimeout(r, 100));

    // INVARIANT: process still alive ⇒ state file must still exist.
    expect(() => process.kill(childPid, 0)).not.toThrow();
    expect(existsSync(statePath)).toBe(true);
  });
});
