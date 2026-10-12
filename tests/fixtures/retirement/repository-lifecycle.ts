/** Production member commands over a fixture Deployment and isolated repository. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { runJoin, runProvision, runLeave } from '@myco/cli/member.js';
import { run as doctor } from '@myco/cli/member-doctor.js';
import { run as update } from '@myco/cli/update.js';
import { logoutDeployment } from '@myco/symbionts/logout-runtime.js';
import { configureSqliteLibrary } from '../../../packages/myco-server/src/platform/bun/sqlite-library.js';
Bun.plugin({ name: 'fixture-cloudflare', setup(build) { build.module('cloudflare:workers', () => ({ exports: { DurableObject: class {}, WorkerEntrypoint: class {} }, loader: 'object' })); } });
configureSqliteLibrary();
const { memberRig } = await import('../../member/helpers/server.js');
import { recordingPlatform } from '../../member/helpers/service-platform.js';

const root = process.cwd();
const mycoHome = process.env.MYCO_HOME!;
const home = process.env.HOME!;
const packageRoot = process.env.MYCO_FIXTURE_PACKAGE_ROOT!;
const rig = await memberRig();
writeDeploymentMembership({ serverUrl: 'https://server.example', token: rig.token, machineId: 'machine_1', joinedAt: Date.now(), updatedAt: Date.now(), expiresAt: rig.expiresAt }, { mycoHome });
recordDefaultDeployment('https://server.example', { mycoHome });
const platform = recordingPlatform();
const worker = { mycoHome, home, platform: 'darwin' as const, runner: platform.runner, ownDeploymentUrls: async () => [], harnessDirs: () => [] };
const output: string[] = [];
const deps = { mycoHome, cwd: root, packageRoot, fetch: rig.fetch, worker, stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line) };
const clean = (step: string) => {
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '', step);
  console.log(`clean: ${step}`);
};
const joinRoot = process.env.MYCO_FIXTURE_JOIN_ROOT ?? root;
assert(await runJoin(['https://server.example', '--project', 'proj_1', '--token-stdin', '--root', joinRoot, '--no-worker'], { ...deps, stdin: () => rig.token }));
clean('join');
assert(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('/' + path.relative(root, path.join(joinRoot, '.myco/runtime.home')).split(path.sep).join('/')));
if (joinRoot === root) {
assert(runProvision(['codex'], deps));
assert(runProvision(['claude-code'], deps));
assert(runProvision(['cursor'], deps));
clean('provision');
assert(runProvision(['--refresh'], deps));
clean('refresh');
await update([], { home: mycoHome, currentVersion: '2.0.0-alpha.2', resolveRefs: async () => null,
  refreshMember: async () => { assert(runProvision(['--refresh'], deps)); } });
clean('update');
await doctor([], 'registry', deps);
if (process.env.MYCO_FIXTURE_HOME_DOCTOR === '1') {
  for (const dotfiles of [false, true]) {
    if (dotfiles) execFileSync('git', ['init', '-q'], { cwd: home });
    const homeOutput: string[] = [];
    await doctor([], 'registry', { ...deps, cwd: home, stdout: line => homeOutput.push(line), stderr: line => homeOutput.push(line) });
    assert(!homeOutput.some(line => line.includes('Repository entries')), homeOutput.join('\n'));
    console.log('quiet: home doctor ' + (dotfiles ? 'dotfiles' : 'non-repository'));
  }
} else {
  assert(output.some(line => line.includes('mcpServers.myco')));
  assert(output.some(line => line.includes('mcp_servers.myco')));
}
clean('doctor');
assert(runLeave([], deps));
await new Promise<void>(resolve => setImmediate(resolve));
clean('leave');
await logoutDeployment('https://server.example', { mode: 'local-only' }, { ...deps, home });
clean('logout');
}
assert.equal(platform.commands.length, 0);
rig.env.sqlite.close();
