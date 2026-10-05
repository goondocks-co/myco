import { afterAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { useTestProcessIdentityReader } from '../../scripts/test-process-tree.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-command-gate-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('non-Bun test command temp boundary', () => {
  for (const mode of [
    { name: 'local', ci: '', strict: '', status: 0, label: 'WARN' },
    { name: 'CI', ci: 'true', strict: '', status: 1, label: 'FAIL' },
    { name: 'explicit strict', ci: '', strict: '1', status: 1, label: 'FAIL' },
  ]) {
    it(`a concurrent foreign temp entry ${mode.status ? 'fails' : 'only warns in'} ${mode.name} mode`, async () => {
      const parent = fs.mkdtempSync(path.join(scratch, 'concurrent-'));
      const ready = path.join(parent, 'ready');
      const release = path.join(parent, 'release');
      const foreign = path.join(parent, 'myco-foreign');
      const script = `
        const fs = require('node:fs');
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 20);
      `;
      const wrapper = spawn('node', ['scripts/run-test-command.mjs', 'node', '-e', script], {
        env: { ...process.env, CI: mode.ci, MYCO_TEST_STRICT_TEMP: mode.strict, TMPDIR: parent, TEMP: parent, TMP: parent },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      wrapper.stderr!.on('data', (chunk) => { stderr += chunk; });
      const exited = new Promise((resolve, reject) => { wrapper.on('error', reject); wrapper.on('close', resolve); });
      try {
        const deadline = Date.now() + 20_000;
        while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
        expect(fs.existsSync(ready)).toBe(true);
        const sibling = spawnSync('node', ['-e', `require('node:fs').writeFileSync(${JSON.stringify(foreign)}, 'foreign')`]);
        expect(sibling.status).toBe(0);
        fs.writeFileSync(release, 'release');
        expect({ status: await exited, stderr }).toEqual({ status: mode.status, stderr: expect.stringContaining(`${mode.label}: new test temp entries outside`) });
        expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign');
        expect(fs.readdirSync(parent).sort()).toEqual(['myco-foreign', 'ready', 'release']);
      } finally {
        if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
        await exited;
      }
    }, 45_000);
  }

  it.skipIf(process.platform !== 'win32')('registers test children natively and catches removal of the native reader', async () => {
    const saved = process.env.MYCO_TEST_PWSH_EXECUTABLE;
    process.env.MYCO_TEST_PWSH_EXECUTABLE = path.join(scratch, 'missing-pwsh.exe');
    let child;
    try {
      child = Bun.spawn([process.execPath, '-e', 'setTimeout(()=>{},60000)'], { stdout: 'ignore', stderr: 'ignore' });
      const record = JSON.parse(fs.readFileSync(path.join(process.env.MYCO_TEST_RUN_ROOT!, '.test-processes', `${child.pid}.json`), 'utf8')) as { identity: string };
      expect(record.identity).toMatch(/^\d+$/);
      const restore = useTestProcessIdentityReader();
      try { expect(() => Bun.spawn([process.execPath, '-e', 'setTimeout(()=>{},60000)'], { stdout: 'ignore', stderr: 'ignore' })).toThrow(); }
      finally { restore(); }
    } finally {
      if (child) { child.kill(9); await child.exited; }
      if (saved === undefined) delete process.env.MYCO_TEST_PWSH_EXECUTABLE;
      else process.env.MYCO_TEST_PWSH_EXECUTABLE = saved;
    }
  });
  it.skipIf(process.platform !== 'win32')('waits for a Windows file lock and rejects the shorter cleanup budget mutation', async () => {
    for (const mutation of [false, true]) {
      const parent = fs.mkdtempSync(path.join(scratch, 'locked-root-'));
      const ready = path.join(parent, 'ready.json');
      const held = path.join(parent, 'held');
      const script = `
        const fs = require('node:fs'), path = require('node:path');
        const file = path.join(process.env.TMPDIR, 'locked.tmp');
        fs.writeFileSync(file, 'lock probe');
        fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify(file));
        const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(held)})) clearInterval(timer); }, 20);
      `;
      const args = ['scripts/run-test-command.mjs', 'node', '-e', script];
      const wrapper = spawn('node', args, { env: { ...process.env, MYCO_TEST_CLEANUP_RETRIES: mutation ? '10' : '30', TMPDIR: parent, TEMP: parent, TMP: parent }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      wrapper.stderr!.on('data', (chunk) => { stderr += chunk; });
      const exited = new Promise((resolve, reject) => { wrapper.on('error', reject); wrapper.on('close', resolve); });
      let holder;
      try {
        const deadline = Date.now() + 20_000;
        while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
        const file = JSON.parse(fs.readFileSync(ready, 'utf8')) as string;
        const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
        holder = spawn(process.env.MYCO_TEST_PWSH_EXECUTABLE!, ['-NoProfile', '-NonInteractive', '-Command', `
          $ErrorActionPreference = 'Stop';
          $handle = [IO.File]::Open(${quote(file)}, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None);
          try { [IO.File]::WriteAllText(${quote(held)}, 'held'); Start-Sleep -Milliseconds 7000 } finally { $handle.Dispose() }
        `], { stdio: 'ignore' });
        const released = new Promise((resolve, reject) => { holder!.on('error', reject); holder!.on('close', resolve); });
        expect({ status: await exited, stderr }).toEqual({ status: mutation ? 1 : 0, stderr: mutation ? expect.stringMatching(/EBUSY|EPERM|EACCES/) : '' });
        expect(await released).toBe(0);
        expect(fs.existsSync(path.dirname(file))).toBe(mutation);
      } finally {
        if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
        if (holder?.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
      }
    }
  }, 60_000);
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
        env: { ...process.env, MYCO_TEST_STRICT_TEMP: '1', TMPDIR: parent, TEMP: parent, TMP: parent }, encoding: 'utf8',
      });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: escape ? 1 : 0, stderr: escape ? expect.stringContaining('FAIL: new test temp entries outside') : '' });
      const probe = JSON.parse(result.stdout.match(/^TEMP_PROBE (.+)$/m)![1]!) as { root: string; home: string; codex: string; claude: string };
      expect(path.dirname(probe.root)).toBe(parent);
      expect(path.dirname(probe.home)).toBe(probe.root);
      expect(probe.codex).toBe(path.join(probe.home, '.codex'));
      expect(probe.claude).toBe(path.join(probe.home, '.claude'));
      expect(fs.readdirSync(parent)).toEqual(escape ? ['myco-command-escaped'] : []);
    });
  }

  it.skipIf(process.platform === 'win32')('removes the root even when process-tree termination fails', () => {
    const parent = fs.mkdtempSync(path.join(scratch, 'kill-fault-'));
    const preload = path.join(scratch, 'kill-fault.mjs');
    fs.writeFileSync(preload, `
      const original = process.kill;
      process.kill = (pid, signal) => {
        if (pid < 0 && signal === 'SIGKILL') throw Object.assign(new Error('fixture signal refused'), { code: 'EPERM' });
        return original(pid, signal);
      };
    `);
    const result = spawnSync('node', ['--import', pathToFileURL(preload).href, 'scripts/run-test-command.mjs', 'node', '-e', '0'], {
      env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent }, encoding: 'utf8',
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 1, stderr: expect.stringContaining('fixture signal refused') });
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('surfaces a Windows tree-kill refusal while still removing the root', () => {
    const parent = fs.mkdtempSync(path.join(scratch, 'windows-kill-fault-'));
    const preload = path.join(scratch, 'windows-kill-fault.mjs');
    fs.writeFileSync(preload, `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.kill = () => true;
      cp.spawnSync = (command, args) => args.at(-1).includes('.Kill(') ? { status: 5, stdout: '', stderr: 'fixture kill refused' } : { status: 0, stdout: '123456', stderr: '' };
      syncBuiltinESMExports();
    `);
    const result = spawnSync('node', ['--import', pathToFileURL(preload).href, 'scripts/run-test-command.mjs', 'node', '-e', '0'], {
      env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent }, encoding: 'utf8',
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 1, stderr: expect.stringContaining('fixture kill refused') });
    expect(fs.readdirSync(parent)).toEqual([]);
  });

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

  it('stops a registered Windows descendant after its parent exits and refuses a reused PID', () => {
    const root = fs.mkdtempSync(path.join(scratch, 'windows-registry-'));
    const preload = path.join(root, 'simulate.mjs');
    const module = new URL('../../scripts/test-process-tree.mjs', import.meta.url).href;
    fs.writeFileSync(preload, `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      Object.defineProperty(process, 'platform', { value: 'win32' });
      let changed = false;
      const killed = [];
      process.env.MYCO_TEST_PWSH_EXECUTABLE = 'fixture-pwsh';
      cp.spawnSync = (command, args) => {
        if (command !== 'fixture-pwsh') return { status: 5, stdout: '', stderr: 'wrong PowerShell executable' };
        if (!args.at(-1).includes('.Kill(')) {
          const pid = Number(args.at(-1).match(/GetProcessById\\((\\d+)\\)/)[1]);
          return { status: 0, stdout: pid === 101 && changed ? '' : pid === 103 && changed ? '999' : '123', stderr: '' };
        }
        const pid = Number(args.at(-1).match(/GetProcessById\\((\\d+)\\)/)[1]);
        if (pid === 102 || !args.at(-1).includes("-eq '123'")) killed.push(pid);
        return { status: 0, stdout: '', stderr: '' };
      };
      syncBuiltinESMExports();
      const { registerTestProcess, stopTestProcessGroup } = await import(${JSON.stringify(module)});
      for (const pid of [101, 102, 103]) registerTestProcess({ pid, kill() { throw new Error('unexpected registration failure'); } }, ${JSON.stringify(root)});
      changed = true;
      stopTestProcessGroup(101, 'SIGKILL', ${JSON.stringify(root)});
      console.log(JSON.stringify(killed));
    `);
    const result = spawnSync('node', [preload], { encoding: 'utf8' });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual([102]);
  });

  for (const fault of ['missing', 'refused']) {
    it(`stops a fresh Windows child when registration is ${fault}`, () => {
      const root = fs.mkdtempSync(path.join(scratch, 'registration-fault-'));
      const file = path.join(root, 'probe.mjs');
      const module = new URL('../../scripts/test-process-tree.mjs', import.meta.url).href;
      fs.writeFileSync(file, `
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        Object.defineProperty(process, 'platform', { value: 'win32' });
        process.kill = () => true;
        cp.spawnSync = () => ({ status: ${fault === 'missing' ? 0 : 5}, stdout: '', stderr: 'refused' });
        syncBuiltinESMExports();
        const { registerTestProcess } = await import(${JSON.stringify(module)});
        const killed = [];
        try { registerTestProcess({ pid: 101, kill(signal) { killed.push(signal); } }, ${JSON.stringify(root)}); }
        catch (error) { console.log(JSON.stringify({ killed, error: error.message })); }
      `);
      const result = spawnSync('node', [file], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ killed: ['SIGKILL'], error: expect.any(String) });
    });
  }

  it.skipIf(process.platform !== 'win32')('ends a registered native Windows child after the command exits', async () => {
    const parent = fs.mkdtempSync(path.join(scratch, 'native-windows-'));
    const ready = path.join(parent, 'child.pid');
    const module = new URL('../../scripts/test-process-tree.mjs', import.meta.url).href;
    const script = `
      const cp = require('node:child_process');
      const fs = require('node:fs');
      const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      import(${JSON.stringify(module)}).then(({ registerTestProcess }) => {
        registerTestProcess(child);
        fs.writeFileSync(${JSON.stringify(ready)}, String(child.pid));
        child.unref();
      });
    `;
    const wrapper = spawn('node', ['scripts/run-test-command.mjs', 'node', '-e', script], {
      env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    wrapper.stderr!.on('data', (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => { wrapper.on('error', reject); wrapper.on('close', resolve); });
    const pid = Number(fs.readFileSync(ready, 'utf8'));
    try {
      expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
      expect(() => process.kill(pid, 0)).toThrow();
      expect(fs.readdirSync(parent)).toEqual(['child.pid']);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }, 30_000);
});
