import { afterAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-command-gate-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('non-Bun test command temp boundary', () => {
  for (const escape of [false, true]) {
    it(`contains command fixtures and ${escape ? 'fails escaped entries' : 'removes its root'}`, () => {
      const parent = fs.mkdtempSync(path.join(scratch, 'parent-'));
      const dead = spawnSync('node', ['-e', '0']);
      const stale = path.join(parent, 'mt-stale0');
      fs.mkdirSync(stale);
      fs.writeFileSync(path.join(stale, '.owner'), `${dead.pid}\n`);
      const script = `
        const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
        const root = os.tmpdir();
        fs.mkdtempSync(path.join(root, 'myco-screen-fixture-'));
        if (${escape}) fs.writeFileSync(path.join(path.dirname(root), 'myco-command-escaped'), 'retain');
        console.log('TEMP_PROBE ' + JSON.stringify({ root, home: os.homedir(), codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR }));
      `;
      const result = spawnSync('node', ['scripts/run-test-command.mjs', 'node', '-e', script], {
        env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent }, encoding: 'utf8',
      });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: escape ? 1 : 0, stderr: escape ? expect.stringContaining('FAIL: test temp entries escaped') : '' });
      const probe = JSON.parse(result.stdout.match(/^TEMP_PROBE (.+)$/m)![1]!) as { root: string; home: string; codex: string; claude: string };
      expect(path.dirname(probe.root)).toBe(parent);
      expect(path.dirname(probe.home)).toBe(probe.root);
      expect(probe.codex).toBe(path.join(probe.home, '.codex'));
      expect(probe.claude).toBe(path.join(probe.home, '.claude'));
      expect(fs.readdirSync(parent)).toEqual(escape ? ['myco-command-escaped'] : []);
    });
  }

  it.skipIf(process.platform === 'win32')('stops command descendants before removing their temp root on termination', async () => {
    const parent = fs.mkdtempSync(path.join(scratch, 'signal-'));
    const ready = path.join(scratch, 'descendants.json');
    const script = `
      const cp = require('node:child_process');
      const child = cp.spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', () => require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify([process.pid, child.pid])));
      setInterval(()=>{},1000);
    `;
    const wrapper = spawn('node', ['scripts/run-test-command.mjs', 'node', '-e', script], {
      env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent }, stdio: 'ignore',
    });
    const exited = new Promise((resolve) => wrapper.on('exit', resolve));
    let pids: number[] = [];
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      const deadline = Date.now() + 20_000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
      pids = JSON.parse(fs.readFileSync(ready, 'utf8')) as number[];
      expect(pids.every(alive)).toBe(true);
      wrapper.kill('SIGTERM');
      await exited;
      while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(20);
      expect(pids.filter(alive)).toEqual([]);
      expect(fs.readdirSync(parent)).toEqual([]);
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 30_000);
});
