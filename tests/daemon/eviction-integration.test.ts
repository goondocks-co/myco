/**
 * End-to-end integration test for daemon eviction.
 *
 * Spawns a fake subprocess that mimics a myco daemon by (a) holding the
 * canonical port for a vault and (b) running with its cwd set inside
 * the vault's project root. Verifies `evictDaemonsForVault` finds and
 * kills it even when `daemon.json` has no record of its PID — the
 * orphan failure mode Chris hit where the prior eviction logic fell
 * back to a fallback port forever.
 *
 * Identity now flows through cwd introspection (`/proc/<pid>/cwd` on
 * Linux, `lsof -d cwd` on Darwin) rather than argv matching, because
 * daemons no longer receive an explicit `--vault` flag.
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
 * shell quoting of embedded JS.
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

// Only Linux + Darwin can introspect process cwd. Skip the integration
// layer on unsupported platforms where identity falls back to daemon.json.
const supportsCwdIntrospection =
  process.platform === 'linux' || process.platform === 'darwin';

describe.skipIf(!supportsCwdIntrospection)(
  'evictDaemonsForVault — orphan on canonical port',
  () => {
    let tmpRoot: string;
    let projectRoot: string;
    let vaultDir: string;
    let scriptPath: string;
    let orphan: ChildProcess | null = null;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-evict-int-'));
      projectRoot = path.join(tmpRoot, 'project');
      vaultDir = path.join(projectRoot, '.myco');
      fs.mkdirSync(vaultDir, { recursive: true });
      scriptPath = path.join(tmpRoot, 'orphan.js');
      fs.writeFileSync(scriptPath, ORPHAN_PROGRAM);
    });

    afterEach(() => {
      if (orphan && orphan.pid) {
        try { process.kill(orphan.pid, 'SIGKILL'); } catch { /* already dead */ }
      }
      orphan = null;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('evicts a port squatter whose cwd resolves to this vault', async () => {
      const canonicalPort = derivePort(vaultDir);

      // Spawn the orphan with cwd = projectRoot. Its cwd walks up to the
      // enclosing `.myco/`, which is `vaultDir` — that's how eviction
      // identifies it as ours.
      orphan = spawn(process.execPath, [scriptPath, String(canonicalPort)], {
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: false,
        cwd: projectRoot,
      });

      const orphanPid = orphan.pid!;
      expect(orphanPid).toBeGreaterThan(0);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('orphan did not become ready')), 3000);
        orphan!.stdout!.on('data', (chunk: Buffer) => {
          if (chunk.toString('utf-8').includes('READY')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      // daemon.json is ABSENT — the orphan was never registered. The prior
      // eviction logic missed this case; cwd-based identity catches it.
      expect(fs.existsSync(path.join(vaultDir, 'daemon.json'))).toBe(false);

      const evicted = await evictDaemonsForVault(vaultDir, {
        graceMs: 1500,
        pollMs: 50,
      });

      expect(evicted).toHaveLength(1);
      expect(evicted[0]?.pid).toBe(orphanPid);
      expect(evicted[0]?.source).toBe(`port:${canonicalPort}`);

      let alive = true;
      try { process.kill(orphanPid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    }, 10_000);

    it('ignores port squatters whose cwd is not inside this vault', async () => {
      const canonicalPort = derivePort(vaultDir);

      // Spawn with cwd = tmpRoot (no `.myco/` above it). findVaultFromCwd
      // returns null → not our daemon → left alone.
      orphan = spawn(process.execPath, [scriptPath, String(canonicalPort)], {
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: false,
        cwd: tmpRoot,
      });

      const orphanPid = orphan.pid!;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('orphan did not become ready')), 3000);
        orphan!.stdout!.on('data', (chunk: Buffer) => {
          if (chunk.toString('utf-8').includes('READY')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      const evicted = await evictDaemonsForVault(vaultDir, { graceMs: 500, pollMs: 50 });

      expect(evicted).toEqual([]);
      let alive = false;
      try { process.kill(orphanPid, 0); alive = true; } catch { /* dead */ }
      expect(alive).toBe(true);
    }, 10_000);
  },
);
