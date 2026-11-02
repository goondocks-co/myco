import { writeTrustedProjectPin } from '../../packages/myco/scripts/project-pin-trust.mjs';
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
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
  expect(machine.warnings).toHaveLength(1);
  fs.rmSync(path.join(machineHome, 'runtime.command'));
  fs.rmSync(path.join(home, '.myco/runtime.home'));
  const fallback = dispatch();
  expect(fallback.answer).toEqual({ program: 'default', home: path.join(home, '.myco') });
  expect(fallback.warnings).toHaveLength(1);
});

it('uses approved pins in hook dispatch and registered worktrees, and refuses independent clones', async () => {
  await approve();
  expect(dispatch().answer).toEqual({ program: 'project', home: projectHome });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: project, env });
  const worktree = path.join(root, 'worktree');
  execFileSync('git', ['worktree', 'add', '--detach', worktree], { cwd: project, env, stdio: 'pipe' });
  for (const name of ['runtime.home', 'runtime.command']) pin(worktree, name, fs.readFileSync(path.join(project, '.myco', name), 'utf8').trim());
  expect(dispatch(worktree).answer).toEqual({ program: 'project', home: projectHome });
  await approve(worktree);
  expect(dispatch().answer).toEqual({ program: 'project', home: projectHome });
  const worktreeBinary = path.join(root, 'worktree-myco');
  fs.copyFileSync(path.join(root, 'project-myco'), worktreeBinary);
  pin(worktree, 'runtime.command', worktreeBinary);
  const worktreeHome = path.join(root, 'worktree-home');
  pin(worktree, 'runtime.home', worktreeHome);
  expect(dispatch(worktree).answer).toEqual({ program: 'machine', home: machineHome });
  await approve(worktree);
  expect(dispatch(worktree).answer).toEqual({ program: 'project', home: worktreeHome });
  const forged = path.join(root, 'forged');
  fs.mkdirSync(forged);
  fs.copyFileSync(path.join(worktree, '.git'), path.join(forged, '.git'));
  for (const name of ['runtime.home', 'runtime.command']) pin(forged, name, fs.readFileSync(path.join(project, '.myco', name), 'utf8').trim());
  expect(dispatch(forged).answer).toEqual({ program: 'machine', home: machineHome });
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

it('requires approval again for changed pin values and a new repository at the same path', async () => {
  await approve();
  const changedBinary = path.join(root, 'changed-myco');
  fs.copyFileSync(path.join(root, 'project-myco'), changedBinary);
  pin(project, 'runtime.command', changedBinary);
  pin(project, 'runtime.home', path.join(root, 'changed-home'));
  expect(dispatch().answer).toEqual({ program: 'machine', home: machineHome });
  pin(project, 'runtime.command', path.join(root, 'project-myco'));
  pin(project, 'runtime.home', projectHome);
  fs.rmSync(path.join(project, '.git'), { recursive: true });
  execFileSync('git', ['init', '-q', project], { env });
  expect(dispatch().answer).toEqual({ program: 'machine', home: machineHome });
});

it.each(['separate-git-dir', 'submodule', 'home-repository'])('approves pins with a %s layout', async layout => {
  if (layout === 'separate-git-dir') {
    execFileSync('git', ['init', '-q', '--separate-git-dir', path.join(root, 'git-data'), project], { env });
  } else if (layout === 'submodule') {
    execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { env });
    const parent = path.join(root, 'parent');
    execFileSync('git', ['init', '-q', parent], { env });
    execFileSync('git', ['-C', parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', project, 'module'], { env });
    project = path.join(parent, 'module');
    pin(project, 'runtime.home', projectHome);
    pin(project, 'runtime.command', path.join(root, 'project-myco'));
  } else {
    execFileSync('git', ['init', '-q', home], { env });
  }
  await approve();
  if (layout === 'home-repository') {
    expect(fs.existsSync(path.join(home, '.git/myco-project-pin-trust'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.myco/project-pin-trust'))).toBe(false);
  }
  expect(dispatch().answer).toEqual({ program: 'project', home: projectHome });
});

it('approves an existing same-home pin on re-join even when the machine pin names another home', async () => {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const joined = await runJoin(['https://pin-test.invalid', '--project', 'proj_test', '--token-env', 'TEST_TOKEN', '--root', project], {
      mycoHome: projectHome, env: { ...env, MYCO_HOME: projectHome, TEST_TOKEN: mintMemberToken() }, stdout: () => {}, stderr: () => {},
      fetch: async () => new Response(JSON.stringify({ ok: true, status: 'ok' }), { status: 200 }),
    });
    expect(joined?.projectId).toBe('proj_test');
    expect(process.exitCode ?? 0).toBe(0);
  } finally { process.env.HOME = saved; }
  fs.rmSync(path.join(machineHome, 'runtime.command'));
  expect(dispatch().answer).toEqual({ program: 'default', home: projectHome });
});

it('approves the nearest project pins from a subfolder and reports when none exist', async () => {
  const folder = path.join(project, 'nested');
  fs.mkdirSync(folder);
  await approve(folder);
  expect(dispatch(folder).answer).toEqual({ program: 'project', home: projectHome });
  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);
  await expect(approve(empty)).rejects.toThrow(/no project runtime pins/i);
});

it('keeps standalone guard dispatch behind approval', async () => {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(root, 'machine-myco'), path.join(bin, 'myco'));
  const guard = path.join(project, '.myco/myco-run.cjs');
  fs.copyFileSync(path.join(repository, 'packages/myco/src/symbionts/templates/myco-run.cjs'), guard);
  const entry = path.join(root, 'guard.cjs');
  fs.writeFileSync(entry, `delete process.env.MYCO_HOME; require(${JSON.stringify(guard)});`);
  const invoke = () => {
    const result = spawnSync(process.execPath, [entry], { cwd: root, env: { ...env, PATH: bin + path.delimiter + env.PATH }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  };
  expect(invoke()).toEqual({ program: 'machine', home: machineHome });
  await approve();
  expect(invoke()).toEqual({ program: 'project', home: projectHome });
});


it('restores a pin when its approval cannot be published', () => {
  const pinPath = path.join(project, '.myco/runtime.home');
  const previous = fs.readFileSync(pinPath, 'utf8');
  const previousMode = fs.statSync(pinPath).mode & 0o777;
  const originalRename = fs.renameSync;
  const rename = spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (String(destination).endsWith('.json')) throw Object.assign(new Error('approval publication failed'), { code: 'EIO' });
    return originalRename(source, destination);
  });
  try {
    expect(() => writeTrustedProjectPin(pinPath, '/another-home', { homeDir: home, replace: true })).toThrow('approval publication failed');
    expect(fs.readFileSync(pinPath, 'utf8')).toBe(previous);
    expect(fs.statSync(pinPath).mode & 0o777).toBe(previousMode);
  } finally { rename.mockRestore(); }
});

it('leaves an existing approval unchanged when the same user approves it again', async () => {
  await approve();
  const directory = path.join(home, '.myco/project-pin-trust');
  const files = fs.readdirSync(directory).map(name => path.join(directory, name));
  for (const file of files) fs.utimesSync(file, 1, 1);
  const before = files.map(file => fs.statSync(file).mtimeMs);
  await approve();
  expect(files.map(file => fs.statSync(file).mtimeMs)).toEqual(before);
  expect(dispatch().answer).toEqual({ program: 'project', home: projectHome });
});
