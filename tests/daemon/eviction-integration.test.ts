/**
 * End-to-end integration test for daemon eviction.
 *
 * Spawns a fake subprocess that mimics a myco daemon by (a) holding the
 * canonical port for a vault and (b) carrying `myco daemon --vault <vault>`
 * in its argv. Verifies `evictDaemonsForVault` finds and kills it even
 * when `daemon.json` has no record of its PID.
 *
 * This is the scenario Chris hit today: an orphan daemon on :21039
 * caused subsequent startups to silently fall back to :21040.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evictDaemonsForVault } from '@myco/daemon/eviction.js';
import { derivePort } from '@myco/daemon/port.js';

/**
 * Child program: binds the supplied port, reports ready, idles forever.
 * Written to a temp file at test-setup time so we don't have to fight
 * shell quoting of embedded JS when rewriting argv[0] below.
 */
const ORPHAN_PROGRAM = `
const net = require('node:net');
const server = net.createServer();
const port = Number(process.argv[2]);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write('READY\\n');
});
setInterval(() => {}, 1000);
`;

describe('evictDaemonsForVault — orphan on canonical port', () => {
  let tmpVault: string;
  let scriptPath: string;
  let orphan: ChildProcess | null = null;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-evict-int-'));
    scriptPath = path.join(tmpVault, 'orphan.js');
    fs.writeFileSync(scriptPath, ORPHAN_PROGRAM);
  });

  afterEach(() => {
    if (orphan && orphan.pid) {
      try { process.kill(orphan.pid, 'SIGKILL'); } catch { /* already dead */ }
    }
    orphan = null;
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  it('evicts a port squatter whose argv claims to be a myco daemon for this vault', async () => {
    const canonicalPort = derivePort(tmpVault);

    // Spawn our orphan with argv[0] rewritten to look like the myco daemon
    // invocation. We can't actually change process name, but `ps -o args=`
    // returns the invocation string as given — which starts with the
    // command path. Node's `spawn` with the first argv being the program
    // means the argv we care about is the subsequent list. The trick:
    // pass a shell command that exec's node with a custom argv[0].
    const invocation = `myco-fake-daemon daemon --vault ${tmpVault}`;
    // bash supports `exec -a <name>` which rewrites argv[0]. `sh` may not.
    orphan = spawn('/bin/bash', [
      '-c',
      `exec -a ${JSON.stringify(invocation)} ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} ${canonicalPort}`,
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: false,
    });

    const orphanPid = orphan.pid!;
    expect(orphanPid).toBeGreaterThan(0);

    // Wait for the orphan to report READY on stdout.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('orphan did not become ready')), 3000);
      orphan!.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf-8').includes('READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    // Sanity: orphan is alive.
    let alive = true;
    try { process.kill(orphanPid, 0); } catch { alive = false; }
    expect(alive).toBe(true);

    // daemon.json is ABSENT — the orphan was never registered. This is
    // exactly the pathological case the prior eviction logic missed.
    expect(fs.existsSync(path.join(tmpVault, 'daemon.json'))).toBe(false);

    // Evict.
    const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const evicted = await evictDaemonsForVault(tmpVault, {
      graceMs: 1500,
      pollMs: 50,
      logger: {
        info: (_k, msg, meta) => logs.push({ msg, meta }),
        warn: (_k, msg, meta) => logs.push({ msg, meta }),
      },
    });

    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.pid).toBe(orphanPid);
    expect(evicted[0]?.source).toBe(`port:${canonicalPort}`);

    // Orphan must be dead.
    try { process.kill(orphanPid, 0); alive = true; } catch { alive = false; }
    expect(alive).toBe(false);
  }, 10_000);

  it('ignores port squatters that are not myco daemons', async () => {
    const canonicalPort = derivePort(tmpVault);

    // Spawn a plain node process — no `myco` in argv.
    orphan = spawn(process.execPath, [scriptPath, String(canonicalPort)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: false,
    });

    const orphanPid = orphan.pid!;

    // Wait for READY.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('orphan did not become ready')), 3000);
      orphan!.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf-8').includes('READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const evicted = await evictDaemonsForVault(tmpVault, { graceMs: 500, pollMs: 50 });

    // Non-myco process must NOT be evicted.
    expect(evicted).toEqual([]);
    let alive = false;
    try { process.kill(orphanPid, 0); alive = true; } catch { /* dead */ }
    expect(alive).toBe(true);
  }, 10_000);
});
