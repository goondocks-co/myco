import { expect, it } from 'bun:test';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const enabled = process.env.MYCO_RUNNER_TEMP_BOUNDARY_FIXTURE === '1';
// A module-load fixture must resolve the root before any test hook runs.
const cachedTemp = os.tmpdir();
const moduleFixture = enabled ? fs.mkdtempSync(path.join(cachedTemp, 'myco-module-load-')) : null;
const childScript = 'process.stdout.write(require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "myco-child-")))';

it.skipIf(!enabled)('contains module-load fixtures and subprocesses with replacement environments', async () => {
  const root = process.env.MYCO_TEST_RUN_ROOT!;
  const contained = (candidate: string) => expect(path.relative(root, candidate)).not.toMatch(/^\.\.(?:[/\\]|$)/);
  contained(moduleFixture!);
  const env = { BOUNDARY_VALUE: 'preserved', TMPDIR: process.env.MYCO_TEST_RUN_PARENT_TMPDIR!, TEMP: process.env.MYCO_TEST_RUN_PARENT_TMPDIR!, TMP: process.env.MYCO_TEST_RUN_PARENT_TMPDIR! };
  const home = JSON.stringify(process.env.HOME);
  const script = `if(process.env.BOUNDARY_VALUE!=="preserved"||process.env.HOME!==${home}||!process.env.CODEX_HOME||!process.env.CLAUDE_CONFIG_DIR||!process.env.MYCO_HOME)process.exit(42);` + childScript;
  for (const binary of [Bun.which('node')!, Bun.which('bun')!]) {
    const child = spawnSync(binary, ['-e', script], { env, encoding: 'utf8' });
    expect({ status: child.status, error: child.stderr }).toEqual({ status: 0, error: '' });
    contained(child.stdout);
    contained(execFileSync(binary, ['-e', script], { env, encoding: 'utf8' }));
    const asyncPath = await new Promise<string>((resolve, reject) => execFile(binary, ['-e', script], { env }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    contained(asyncPath);
  }
  const bun = Bun.which('bun')!;
  for (const optionsForm of [false, true]) {
    const child = optionsForm ? Bun.spawnSync({ cmd: [bun, '-e', script], env }) : Bun.spawnSync([bun, '-e', script], { env });
    expect(child.exitCode).toBe(0);
    contained(child.stdout.toString());
    const asyncChild = optionsForm ? Bun.spawn({ cmd: [bun, '-e', script], env, stdout: 'pipe' }) : Bun.spawn([bun, '-e', script], { env, stdout: 'pipe' });
    const output = await new Response(asyncChild.stdout).text();
    expect(await asyncChild.exited).toBe(0);
    contained(output);
  }
  const native = process.platform === 'darwin';
  const source = path.join(cachedTemp, native ? 'stub.c' : 'stub.cjs');
  const binary = path.join(cachedTemp, process.platform === 'win32' ? 'stub.exe' : 'stub');
  fs.writeFileSync(source, native ? `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(void) {
  if (!getenv("BOUNDARY_VALUE") || strcmp(getenv("BOUNDARY_VALUE"), "preserved")) return 42;
  char dir[4096];
  snprintf(dir, sizeof(dir), "%s/myco-child-XXXXXX", getenv("TMPDIR") ? getenv("TMPDIR") : P_tmpdir);
  if (!mkdtemp(dir)) return 1;
  printf("%s", dir);
  return 0;
}` : script);
  const built = native
    ? spawnSync('cc', [source, '-o', binary], { encoding: 'utf8' })
    : spawnSync(bun, ['build', source, '--compile', '--outfile', binary], { encoding: 'utf8' });
  expect({ status: built.status, error: built.stderr }).toEqual({ status: 0, error: expect.any(String) });
  contained(execFileSync(binary, [], { env, encoding: 'utf8' }));
});

it.skipIf(!enabled || process.env.MYCO_RUNNER_ESCAPE_FIXTURE !== '1')('deliberately escapes into the nested runner parent', () => {
  // The guard supplies a private simulated system temp directory.
  const parent = process.env.MYCO_TEST_RUN_PARENT_TMPDIR!;
  const child = spawnSync('node', ['-e', `
    const fs = require('node:fs'), path = require('node:path');
    fs.writeFileSync(path.join(${JSON.stringify(parent)}, 'myco-escaped-${process.pid}'), 'escaped');
    fs.mkdirSync(path.join(${JSON.stringify(parent)}, 'mt-escaped-${process.pid}'));
  `], { encoding: 'utf8' });
  expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
});
