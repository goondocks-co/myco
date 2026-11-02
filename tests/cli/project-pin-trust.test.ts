import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { MEMBER_COMMANDS, runJoin } from '@myco/cli/member.js';
import { mintMemberToken } from '@myco-server-worker/auth/tokens.js';

const repository = path.resolve('.');
let root: string;
let home: string;
let project: string;
let projectHome: string;
let machineHome: string;
let driver: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-pin-trust-'));
  home = path.join(root, 'user');
  project = path.join(root, 'repo');
  projectHome = path.join(root, 'project-home');
  machineHome = path.join(root, 'machine-home');
  for (const dir of [home, project, projectHome, machineHome]) fs.mkdirSync(dir, { recursive: true });
  env = sandboxChildEnv(root, { HOME: home });
  execFileSync('git', ['init', '-q', project], { env });
  driver = path.join(root, 'dispatch.ts');
  fs.writeFileSync(driver, `import { runLaunchPreamble } from ${JSON.stringify(path.join(repository, 'packages/myco/src/cli/launch-preamble.ts'))};
import { resolveMycoHome } from ${JSON.stringify(path.join(repository, 'packages/myco/src/paths/home.ts'))};
delete process.env.MYCO_HOME;
runLaunchPreamble('hook', ['session-start', '--symbiont', 'copilot']);
console.log(JSON.stringify({ program: 'default', home: resolveMycoHome({ cwd: process.cwd() }) }));`);
  pin(project, 'runtime.home', projectHome);
  pin(home, 'runtime.home', machineHome);
  for (const [name, folder] of [['project', project], ['machine', null]] as const) {
    const binary = path.join(root, `${name}-myco`);
    fs.writeFileSync(binary, `#!${process.execPath}\nimport { resolveMycoHome } from ${JSON.stringify(path.join(repository, 'packages/myco/src/paths/home.ts'))};\nconsole.log(JSON.stringify({program:${JSON.stringify(name)},home:resolveMycoHome({cwd:process.cwd()})}));`, { mode: 0o755 });
    if (folder) pin(folder, 'runtime.command', binary);
    else fs.writeFileSync(path.join(machineHome, 'runtime.command'), binary);
  }
});
afterEach(() => { fs.rmSync(root, { force: true, recursive: true }); process.exitCode = 0; });

function pin(folder: string, name: string, value: string): string {
  const file = path.join(folder, '.myco', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value + '\n', { mode: 0o600 });
  return file;
}
function dispatch(cwd = project) {
  const result = spawnSync(process.execPath, [driver], { cwd, env, encoding: 'utf8' });
  expect(result.status).toBe(0);
  return { answer: JSON.parse(result.stdout), warnings: result.stderr.trim().split('\n').filter(Boolean) };
}
async function approve(folder = project) {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try { await MEMBER_COMMANDS['trust-pins'].run(['--root', folder], { stdout: () => {} }); }
  finally { process.env.HOME = saved; }
}

it('ignores unapproved checkout pins through hook dispatch and continues with the machine or default home', () => {
  const machine = dispatch();
  expect(machine.answer).toEqual({ program: 'machine', home: machineHome });
  expect(machine.warnings.length).toBeLessThanOrEqual(1);
  fs.rmSync(path.join(machineHome, 'runtime.command'));
  fs.rmSync(path.join(home, '.myco/runtime.home'));
  const fallback = dispatch();
  expect(fallback.answer).toEqual({ program: 'default', home: path.join(home, '.myco') });
  expect(fallback.warnings.length).toBeLessThanOrEqual(1);
});

it('uses approved pins in hook dispatch and registered worktrees, and refuses independent clones', async () => {
  await approve();
  expect(dispatch().answer).toEqual({ program: 'project', home: projectHome });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: project, env });
  const worktree = path.join(root, 'worktree');
  execFileSync('git', ['worktree', 'add', '--detach', worktree], { cwd: project, env, stdio: 'pipe' });
  for (const name of ['runtime.home', 'runtime.command']) pin(worktree, name, fs.readFileSync(path.join(project, '.myco', name), 'utf8').trim());
  const worktreeBinary = path.join(root, 'worktree-myco');
  fs.copyFileSync(path.join(root, 'project-myco'), worktreeBinary);
  pin(worktree, 'runtime.command', worktreeBinary);
  const worktreeHome = path.join(root, 'worktree-home');
  pin(worktree, 'runtime.home', worktreeHome);
  expect(dispatch(worktree).answer).toEqual({ program: 'project', home: worktreeHome });
  const clone = path.join(root, 'clone');
  execFileSync('git', ['clone', '-q', project, clone], { env });
  for (const name of ['runtime.home', 'runtime.command']) pin(clone, name, fs.readFileSync(path.join(project, '.myco', name), 'utf8').trim());
  expect(dispatch(clone).answer).toEqual({ program: 'machine', home: machineHome });
});

it('records approval when member join writes a home pin, without approving a separate command pin', async () => {
  fs.rmSync(path.join(project, '.myco/runtime.home'));
  const token = mintMemberToken();
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const joined = await runJoin(['https://pin-test.invalid', '--project', 'proj_test', '--token-env', 'TEST_TOKEN', '--root', project], {
      mycoHome: projectHome, env: { ...env, MYCO_HOME: projectHome, TEST_TOKEN: token }, stdout: () => {}, stderr: () => {},
      fetch: async () => new Response(JSON.stringify({ ok: true, status: 'ok' }), { status: 200 }),
    });
    expect(joined?.projectId).toBe('proj_test');
  } finally { process.env.HOME = saved; }
  fs.rmSync(path.join(machineHome, 'runtime.command'));
  expect(dispatch().answer).toEqual({ program: 'default', home: projectHome });
  expect(fs.readdirSync(path.join(home, '.myco/project-pin-trust'))).toHaveLength(1);
});
