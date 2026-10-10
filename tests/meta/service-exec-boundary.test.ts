import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTestProcessRssKiB, readTestProcessTable, readTestProcessGroupId } from '../../scripts/test-process-tree.mjs';
import { sandboxChildEnv, resolveTestTool } from '../../scripts/test-environment.mjs';
import { assertServiceCommand, sandboxServiceChild, assertNoServiceExecutions, assertAllServiceExecutions, consumeServiceExecDenials } from '../../scripts/test-service-exec.mjs';

const roots: string[] = [];
const fresh = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-service-exec-'));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) {
  consumeServiceExecDenials(path.join(root, '.service-exec-guard'));
  fs.rmSync(root, { recursive: true, force: true });
} });
const environment = (root: string) => sandboxChildEnv(root, { MYCO_TEST_RUN_ROOT: root });
const sqliteExecutable = resolveTestTool('sqlite3') ?? (fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : null);

describe('service-manager process containment', () => {
  for (const operation of ['restart', 'rollback', 'guardian']) for (const stub of [true, false]) {
    it(`runner update ${operation} ${stub ? 'uses its stub' : 'fails before real service execution'}`, () => {
      const root = fresh();
      const env: NodeJS.ProcessEnv = { ...environment(root), ...(stub ? { MYCO_RUNNER_SERVICE_STUB: '1' } : {}), ...(operation === 'rollback' ? { MYCO_RUNNER_UPDATE_ROLLBACK: '1' } : {}), ...(operation === 'guardian' ? { MYCO_RUNNER_UPDATE_GUARDIAN: '1' } : {}) };
      const child = spawnSync(process.execPath, ['test', './tests/fixtures/runner/runner_update_boundary_test.ts'], { env, cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
      if (stub) {
        expect({ status: child.status, denied: child.stderr.includes('TEST SAFETY') }).toEqual({ status: 0, denied: false });
        expect(() => assertNoServiceExecutions(env.MYCO_TEST_SERVICE_GUARD_DIR!)).not.toThrow();
      } else {
        expect(child.status).not.toBe(0);
        expect(child.stderr).toContain('TEST SAFETY');
        expect(() => assertNoServiceExecutions(env.MYCO_TEST_SERVICE_GUARD_DIR!)).toThrow('TEST SAFETY');
      }
    });
  }
  for (const stub of [true, false]) {
    it(`runner service installation ${stub ? 'uses its stub' : 'fails before real service execution without its stub'}`, () => {
      const root = fresh();
      const env: NodeJS.ProcessEnv = { ...environment(root), ...(stub ? { MYCO_RUNNER_SERVICE_STUB: '1' } : {}) };
      const child = spawnSync(process.execPath, ['test', './tests/fixtures/runner/runner_service_boundary_test.ts'], { env, cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
      if (stub) {
        expect({ status: child.status, stderr: child.stderr.includes('TEST SAFETY') }).toEqual({ status: 0, stderr: false });
        expect(() => assertNoServiceExecutions(env.MYCO_TEST_SERVICE_GUARD_DIR!)).not.toThrow();
      } else {
        expect(child.status).not.toBe(0);
        expect(child.stderr).toContain('TEST SAFETY');
        expect(() => assertNoServiceExecutions(env.MYCO_TEST_SERVICE_GUARD_DIR!)).toThrow('TEST SAFETY');
      }
    });
  }

  for (const operation of ['install', 'start', 'stop', 'uninstall']) for (const stub of [true, false]) {
    it(`native service ${operation} ${stub ? 'uses its stub' : 'refuses real service execution'}`, () => {
      const root = fresh();
      const env: NodeJS.ProcessEnv = { ...environment(root), MYCO_NATIVE_SERVICE_OPERATION: operation, ...(stub ? { MYCO_NATIVE_SERVICE_STUB: '1' } : {}) };
      const child = spawnSync(process.execPath, ['test', './tests/fixtures/install/native_service_boundary_test.ts'], {
        cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000,
      });
      if (stub) {
        expect({ status: child.status, denied: child.stderr.includes('TEST SAFETY') }).toEqual({ status: 0, denied: false });
        expect(() => assertNoServiceExecutions(env.MYCO_TEST_SERVICE_GUARD_DIR!)).not.toThrow();
      } else {
        expect(child.status).not.toBe(0);
        expect(child.stderr).toContain('TEST SAFETY');
        expect(() => assertNoServiceExecutions(env.MYCO_TEST_SERVICE_GUARD_DIR!)).toThrow('TEST SAFETY');
      }
    });
  }

  it.skipIf(!sqliteExecutable)('nested native SQLite probes remain admitted', () => {
    const root = fresh(), env = environment(root);
    const sqlite = sqliteExecutable!;
    const child = spawnSync(process.execPath, ['-e', `const result = Bun.spawnSync([${JSON.stringify(sqlite)}, ':memory:', 'select 1;']); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.exitCode);`], { env, encoding: 'utf8' });
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
    expect(child.stdout.trim()).toBe('1');
  });

  it('quoted SQL and comments mentioning service managers remain data', () => {
    const root = fresh(), env = environment(root);
    const data = `INSERT INTO spores SELECT '"managed LWCR" (launchctl print: managed LWCR); systemctl start example'`;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    for (const script of [`printf '%s' ${quote(data)}`, `printf '%s' "note (launchctl print); systemctl start"`, '# /bin/launchctl bootstrap\nprintf safe', 'cat <<EOF\nlaunchctl print\nEOF', "cat <<'EOF'\n$(/bin/launchctl print)\nEOF", '"/bin/launch\\ctl" version', 'command -v launchctl']) {
      expect(() => assertServiceCommand(['/bin/sh', '-c', script], env)).not.toThrow();
    }
    const child = spawnSync('/bin/sh', ['-c', `printf '%s' ${quote(data)}`], { env, encoding: 'utf8' });
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
    expect(child.stdout).toBe(data);
    expect(() => assertNoServiceExecutions(env.MYCO_TEST_SERVICE_GUARD_DIR!)).not.toThrow();
  });

  it('shell executable words and substitutions are refused before execution', () => {
    const root = fresh(), env = environment(root);
    for (const script of ["'/bin/launchctl' version", 'if :; then "systemctl" start example; fi', '( launchctl version )', 'printf "%s" "$(/bin/launchctl version)"', 'printf "%s" `systemctl status`', '! /bin/launchctl version', 'sudo -u user /bin/launchctl version', 'sudo --user root /bin/launchctl version', 'sudo --group staff /usr/bin/systemctl status', 'cat <<EOF\n$(/bin/launchctl version)\nEOF']) {
      expect(() => assertServiceCommand(['/bin/sh', '-c', script], env)).toThrow('TEST SAFETY');
      expect(consumeServiceExecDenials(env.MYCO_TEST_SERVICE_GUARD_DIR!)).toMatch(/launchctl|systemctl/);
    }
  });

  it.skipIf(process.platform !== 'linux')('the execution boundary preserves fixture renames and hard links', () => {
    const root = fresh();
    const script = `const fs = require('node:fs'), path = require('node:path');
const root = ${JSON.stringify(root)};
const first = path.join(root, 'first'), second = path.join(root, 'second');
fs.mkdirSync(first); fs.mkdirSync(second);
fs.writeFileSync(path.join(first, 'file'), 'owned');
fs.renameSync(path.join(first, 'file'), path.join(second, 'file'));
fs.linkSync(path.join(second, 'file'), path.join(first, 'link'));
fs.renameSync(second, path.join(root, 'renamed'));
process.stdout.write(fs.readFileSync(path.join(first, 'link'), 'utf8'));`;
    const child = spawnSync('node', ['-e', script], { env: environment(root), encoding: 'utf8' });
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
    expect(child.stdout).toBe('owned');
  });
  for (const command of ['launchctl', '/bin/launchctl', 'systemctl', '/usr/bin/systemctl']) {
    it(`fails a test phase that swallows ${command}`, () => {
      const root = fresh();
      const env: NodeJS.ProcessEnv = { ...environment(root), MYCO_SERVICE_EXEC_FIXTURE: command };
      const child = spawnSync(process.execPath, ['test', './tests/fixtures/runner/service_exec_boundary_test.ts'], { env, encoding: 'utf8' });
      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain('TEST SAFETY');
      expect(() => assertNoServiceExecutions(env.MYCO_TEST_SERVICE_GUARD_DIR!)).toThrow('TEST SAFETY');
    });
  }

  it.skipIf(process.platform === 'win32')('a shell descendant reaches a failing PATH shim even with an override PATH', () => {
    const root = fresh();
    const script = path.join(root, 'attempt.sh');
    fs.writeFileSync(script, '#!/bin/sh\nmanager=launchctl\n"$manager" version >/dev/null 2>&1 || true\n');
    const env: NodeJS.ProcessEnv = sandboxChildEnv(root, { MYCO_TEST_RUN_ROOT: root, PATH: '/usr/bin:/bin' });
    const child = spawnSync('/bin/sh', [script], { env, encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(() => assertNoServiceExecutions(env.MYCO_TEST_SERVICE_GUARD_DIR!)).toThrow('TEST SAFETY');
  });


  it.skipIf(process.platform === 'win32')('an absolute command in a shell script fails the phase even when swallowed', () => {
    const root = fresh();
    const script = path.join(root, 'attempt.sh');
    fs.writeFileSync(script, '#!/bin/sh\n/bin/launchctl version >/dev/null 2>&1 || true\n');
    const env: NodeJS.ProcessEnv = { ...environment(root), MYCO_SERVICE_EXEC_FIXTURE: '/bin/sh', MYCO_SERVICE_EXEC_SCRIPT: script };
    const child = spawnSync(process.execPath, ['test', './tests/fixtures/runner/service_exec_boundary_test.ts'], { env, encoding: 'utf8' });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('TEST SAFETY');
    expect(() => assertNoServiceExecutions(env.MYCO_TEST_SERVICE_GUARD_DIR!)).toThrow('TEST SAFETY');
  });

  it('fixture cleanup cannot erase a nested denial journal', () => {
    const root = fresh();
    const env: NodeJS.ProcessEnv = environment(root);
    fs.writeFileSync(path.join(env.MYCO_TEST_SERVICE_GUARD_DIR!, 'denials'), 'launchctl\n');
    expect(() => fs.rmSync(root, { recursive: true })).toThrow('TEST SAFETY');
    expect(fs.existsSync(root)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('native fixture cleanup cannot hide a denial journal', () => {
    const root = fresh();
    const env = environment(root);
    fs.writeFileSync(path.join(env.MYCO_TEST_SERVICE_GUARD_DIR!, 'denials'), 'launchctl\n');
    const child = spawnSync('/bin/rm', ['-rf', env.MYCO_TEST_SERVICE_GUARD_DIR!], { env });
    expect(child.status).toBe(0);
    expect(() => assertAllServiceExecutions()).toThrow('TEST SAFETY');
  });

  it.skipIf(process.platform === 'win32')('the resident-memory probe uses admitted unprivileged tooling', () => {
    expect(readTestProcessRssKiB(process.pid)).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')('the process table identifies the current process and group', () => {
    const row = readTestProcessTable().get(process.pid)!;
    expect(row.ppid).toBe(process.ppid);
    expect(row.pgid).toBe(readTestProcessGroupId(process.pid));
    expect(row.started.length).toBeGreaterThan(0);
  });

  it.skipIf(process.platform !== 'darwin')('a reaped owned process has no resident memory', async () => {
    const child = Bun.spawn(['/bin/sh', '-c', ':'], { env: process.env });
    await child.exited;
    expect(readTestProcessRssKiB(child.pid)).toBe(0);
  });

  it('does not create a guard under a foreign run root', () => {
    const root = fresh();
    expect(() => sandboxChildEnv(root, { MYCO_TEST_RUN_ROOT: '/outside-test-run' })).toThrow('TEST SAFETY');
  });

  it('does not trust an inherited tooling directory', () => {
    const root = fresh();
    const env: NodeJS.ProcessEnv = sandboxChildEnv(root, { MYCO_TEST_RUN_ROOT: root, MYCO_TEST_SERVICE_TOOL_DIR: '/usr/bin' });
    expect(env.MYCO_TEST_SERVICE_TOOL_DIR!.startsWith(root + path.sep)).toBe(true);
  });

  it('a Node descendant refuses an absolute command even when its error is caught', () => {
    const root = fresh();
    const env: NodeJS.ProcessEnv = environment(root);
    const child = spawnSync('node', ['-e', 'try { require("node:child_process").spawnSync("/bin/launchctl", ["version"]); } catch {}'], { env, encoding: 'utf8' });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('TEST SAFETY');
  });

  it('a Node descendant refuses a provision home outside its fixture', () => {
    const root = fresh();
    const env: NodeJS.ProcessEnv = environment(root);
    const script = `try { require('node:child_process').spawnSync(process.execPath, ['-e', 'process.exit(42)'], {env: {HOME: '/outside-test-run'}}); process.exit(1); } catch (error) { process.stdout.write(error.message); }`;
    const child = spawnSync('node', ['-e', script], { env, encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('TEST SAFETY');
  });

  it('a Node replacement environment keeps deliberate omissions', () => {
    const root = fresh();
    const env: NodeJS.ProcessEnv = { ...environment(root), MYCO_BOUNDARY_SENTINEL: 'parent-only' };
    const script = `process.stdout.write(require('node:child_process').execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.MYCO_BOUNDARY_SENTINEL ?? "omitted")'], {env: {HOME: process.env.HOME}, encoding: 'utf8'}));`;
    const child = spawnSync('node', ['-e', script], { env, encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('omitted');
  });



  it.skipIf(process.platform === 'win32')('Node shell modes retain the OS execution boundary', () => {
    const root = fresh();
    const env: NodeJS.ProcessEnv = { ...environment(root), MYCO_TEST_SERVICE_DENY_EXEC: JSON.stringify(['/usr/bin/true']) };
    const script = `const cp = require('node:child_process');
const results = [cp.spawnSync('/usr/bin/true', {shell:true}).status];
try { cp.execSync('/usr/bin/true'); results.push(0); } catch { results.push(1); }
try { cp.execFileSync('/usr/bin/true', {shell:true}); results.push(0); } catch { results.push(1); }
process.stdout.write(JSON.stringify([results[0], ...results.slice(1)]));`;
    const child = spawnSync('node', ['-e', script], { env, encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout).every((status: number) => status !== 0)).toBe(true);
  });

  it('a benign Node fork retains its IPC channel through the boundary', () => {
    const root = fresh();
    const env: NodeJS.ProcessEnv = environment(root);
    const childScript = path.join(root, 'fork.cjs');
    fs.writeFileSync(childScript, "process.send('isolated');\n");
    const script = `const child = require('node:child_process').fork(${JSON.stringify(childScript)});
child.once('message', value => process.stdout.write(value));
child.once('exit', code => { process.exitCode = code; });`;
    const child = spawnSync('node', ['-e', script], { env, encoding: 'utf8', timeout: 10000 });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('isolated');
  });

  it.skipIf(process.platform === 'win32')('a missing command is rejected before any unwrapped spawn', () => {
    const root = fresh();
    expect(() => sandboxServiceChild([path.join(root, 'not-created')], environment(root))).toThrow('ENOENT');
  });

  it.skipIf(process.platform === 'win32')('Node missing-command failures keep sync results and async error events', () => {
    const root = fresh();
    const script = `const cp = require('node:child_process');
const missing = ${JSON.stringify(path.join(root, 'not-created'))};
const codes = [cp.spawnSync(missing).error.code];
const child = cp.spawn(missing);
child.on('error', error => codes.push(error.code));
child.on('close', () => process.stdout.write(JSON.stringify(codes)));`;
    const child = spawnSync('node', ['-e', script], { env: environment(root), encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(['ENOENT', 'ENOENT']);
  });

  it.skipIf(process.platform === 'win32')('callers cannot mutate an admitted sandbox command', () => {
    const root = fresh();
    const cmd = sandboxServiceChild(['/bin/sh', '-c', ':'], environment(root));
    expect(Object.isFrozen(cmd)).toBe(true);
    expect(() => { cmd[0] = '/bin/sh'; }).toThrow();
  });

  it.skipIf(process.platform !== 'darwin')('a caller-supplied sandbox wrapper still receives the execution boundary', () => {
    const root = fresh();
    const env: NodeJS.ProcessEnv = environment(root);
    const harmless = '/usr/bin/true';
    const cmd = sandboxServiceChild(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', harmless], env, process.cwd(), [harmless]);
    const child = Bun.spawnSync(cmd, { env });
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr.toString()).toMatch(/not permitted|Permission denied/);
  });

  it.skipIf(process.platform === 'win32')('the OS execution boundary denies a symlinked harmless descendant', () => {
    const root = fresh();
    const alias = path.join(root, 'benign-alias');
    fs.symlinkSync('/usr/bin/true', alias);
    const child = Bun.spawnSync(['/bin/sh', '-c', '"$1"', '--', alias], { env: environment(root) });
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr.toString()).toMatch(/not permitted|Permission denied/);
  });

  it.skipIf(process.platform === 'win32')('the OS execution boundary denies a harmless absolute descendant', () => {
    const root = fresh();
    const env: NodeJS.ProcessEnv = environment(root);
    const harmless = '/usr/bin/true';
    const cmd = sandboxServiceChild(['/bin/sh', '-c', harmless], env, process.cwd(), [harmless]);
    const child = Bun.spawnSync(cmd, { env });
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr.toString()).toMatch(/not permitted|Permission denied/);
  });
});
