/**
 * Three implementations of one rule, held to the same answers.
 *
 * A native plugin resolves the home in order to FIND the binary, and the CLI
 * shim resolves it before any binary exists to ask, so the rule genuinely
 * exists three times: `src/paths/home.ts` (the binary), the shared plugin
 * snippet, and `bin/runtime-redirect.cjs` (the shim, which resolves it by
 * exporting `MYCO_HOME` for the child it execs). Two of them disagreeing puts
 * a project's CLI in one home and its in-process plugin in another, or a
 * plugin's transcripts under one home while the hooks it spawns read another —
 * visible only as a session that never arrives.
 *
 * All three are driven over ONE fixture tree here and must answer identically,
 * and answer the documented precedence: an explicit `MYCO_HOME`, then a trusted
 * project `.myco/runtime.home` walking up, then the machine pin, then `~/.myco`.
 *
 * The snippet is compiled into a driver script with the imports its contract
 * declares, and run in a child process: `homedir()` is fixed at process launch,
 * so a sandboxed `~` is only reachable by launching with one. The shim is
 * driven the way a user meets it — as a process, over its `runtime.command`
 * pin — so what is compared is the environment it hands its child.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname ?? __dirname, '..', '..');
const SNIPPET = path.join(REPO_ROOT, 'packages/myco/src/symbionts/templates/_shared/plugin-helpers.ts.snippet');
const HOME_MODULE = path.join(REPO_ROOT, 'packages/myco/src/paths/home.ts');
const REDIRECT_MODULE = path.join(REPO_ROOT, 'packages/myco/bin/runtime-redirect.cjs');
const POSIX = process.platform !== 'win32';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writePin(dir: string, home: string, mode = 0o644): string {
  fs.mkdirSync(path.join(dir, '.myco'), { recursive: true });
  const pin = path.join(dir, '.myco', 'runtime.home');
  fs.writeFileSync(pin, `${home}\n`);
  fs.chmodSync(pin, mode);
  return pin;
}

/**
 * A runnable module holding BOTH implementations: the snippet exactly as the
 * installer injects it, and the binary's resolver imported from source.
 */
function driverScript(): string {
  const snippet = fs.readFileSync(SNIPPET, 'utf-8').replace('{{mycoCredentialSource}}', 'registry');
  return `import { readFileSync, appendFileSync, mkdirSync, statSync, lstatSync, accessSync, openSync, closeSync, writeSync, unlinkSync, constants as fsConstants } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveMycoHome as binaryHome } from ${JSON.stringify(HOME_MODULE)};

${snippet}

const answers = process.argv.slice(2).map((dir) => ({
  dir,
  plugin: resolveMycoHome(dir),
  binary: binaryHome({ cwd: dir }),
}));
process.stdout.write(JSON.stringify(answers));
`;
}

interface Answer { dir: string; plugin: string; binary: string }

/**
 * The home the shim hands the binary it execs from `dir`.
 *
 * Driven through `maybeRedirect` — the shim's own decision — with the pin
 * pointing at a script that prints the `MYCO_HOME` it was exec'd with. Nothing
 * here restates the rule: what is read back is what a user's binary would see.
 *
 * The shim reads a home pin only beside a WINNING `runtime.command`, so the
 * fixture gets one; a project without a command pin is outside its contract and
 * is compared between the other two implementations only.
 */
function shimHomeFor(dir: string, env: { HOME: string; MYCO_HOME?: string }): string {
  const driver = path.join(tmpdir('myco-shim-driver-'), 'driver.cjs');
  fs.writeFileSync(driver, `
const redirect = require(${JSON.stringify(REDIRECT_MODULE)});
redirect.maybeRedirect('/nonexistent/self-binary', process.env, process.cwd());
process.stdout.write('NO-REDIRECT');
`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: env.HOME };
  if (env.MYCO_HOME === undefined) delete childEnv.MYCO_HOME;
  else childEnv.MYCO_HOME = env.MYCO_HOME;
  return execFileSync(process.execPath, [driver], { cwd: dir, env: childEnv, encoding: 'utf-8' });
}

/**
 * Give `dir` a `runtime.command` pin the shim will exec: a script that prints
 * the home it was handed, so the shim's answer can be read off its child.
 */
function writeCommandPin(dir: string): void {
  fs.mkdirSync(path.join(dir, '.myco'), { recursive: true });
  const target = path.join(tmpdir('myco-shim-target-'), 'echo-home.sh');
  fs.writeFileSync(target, '#!/bin/sh\nprintf "%s" "${MYCO_HOME}"\n', { mode: 0o755 });
  const pin = path.join(dir, '.myco', 'runtime.command');
  fs.writeFileSync(pin, `${target}\n`);
  fs.chmodSync(pin, 0o644);
}

/** Run both implementations over `dirs` in a child launched with the given `~` and environment. */
function resolveBoth(dirs: string[], env: { HOME: string; MYCO_HOME?: string }): Answer[] {
  const driver = path.join(tmpdir('myco-home-driver-'), 'driver.ts');
  fs.writeFileSync(driver, driverScript());
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: env.HOME };
  if (env.MYCO_HOME === undefined) delete childEnv.MYCO_HOME;
  else childEnv.MYCO_HOME = env.MYCO_HOME;
  const out = execFileSync(process.execPath, [driver, ...dirs], {
    cwd: dirs[0],
    env: childEnv,
    encoding: 'utf-8',
  });
  return JSON.parse(out) as Answer[];
}

/** Both in-process implementations answered `expected` for this directory. */
const expectAgreed = (answer: Answer, expected: string): void => {
  expect({ dir: answer.dir, plugin: answer.plugin, binary: answer.binary })
    .toEqual({ dir: answer.dir, plugin: expected, binary: expected });
};

/** The shim, driven as a process, hands its child the same home. */
const expectShimAgrees = (dir: string, env: { HOME: string; MYCO_HOME?: string }, expected: string): void => {
  if (!POSIX) return;
  expect({ dir, shim: shimHomeFor(dir, env) }).toEqual({ dir, shim: expected });
};

describe('plugin snippet and binary home resolution agree', () => {
  it('agree on the project pin, a nested directory under it, and no pin at all', () => {
    const fakeHome = tmpdir('myco-agree-homedir-');
    const pinnedHome = tmpdir('myco-agree-pinned-');
    const project = tmpdir('myco-agree-project-');
    writePin(project, pinnedHome);
    const nested = path.join(project, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    const bare = tmpdir('myco-agree-unpinned-');

    const [pinned, deep, unpinned] = resolveBoth([project, nested, bare], { HOME: fakeHome });
    expectAgreed(pinned, pinnedHome);
    expectAgreed(deep, pinnedHome);
    expectAgreed(unpinned, path.join(fakeHome, '.myco'));

    // The shim reads the home beside a winning command pin: give the project one.
    writeCommandPin(project);
    expectShimAgrees(project, { HOME: fakeHome }, pinnedHome);
  });

  it('agree that the machine pin applies only where no project pin does', () => {
    const fakeHome = tmpdir('myco-agree-homedir-');
    const machineHome = tmpdir('myco-agree-machine-');
    const projectHome = tmpdir('myco-agree-project-home-');
    writePin(fakeHome, machineHome);
    const pinnedProject = tmpdir('myco-agree-project-');
    writePin(pinnedProject, projectHome);
    const bare = tmpdir('myco-agree-unpinned-');

    const [project, unpinned] = resolveBoth([pinnedProject, bare], { HOME: fakeHome });
    expectAgreed(project, projectHome);
    expectAgreed(unpinned, machineHome);
  });

  it('agree that an explicit MYCO_HOME beats every pin', () => {
    const fakeHome = tmpdir('myco-agree-homedir-');
    const machineHome = tmpdir('myco-agree-machine-');
    const projectHome = tmpdir('myco-agree-project-home-');
    const envHome = tmpdir('myco-agree-env-');
    writePin(fakeHome, machineHome);
    const project = tmpdir('myco-agree-project-');
    writePin(project, projectHome);

    const [answer] = resolveBoth([project], { HOME: fakeHome, MYCO_HOME: envHome });
    expectAgreed(answer, envHome);
    writeCommandPin(project);
    expectShimAgrees(project, { HOME: fakeHome, MYCO_HOME: envHome }, envHome);
  });

  it('agree that a group-writable pin is refused, falling through to the next scope', () => {
    const fakeHome = tmpdir('myco-agree-homedir-');
    const machineHome = tmpdir('myco-agree-machine-');
    writePin(fakeHome, machineHome);
    const project = tmpdir('myco-agree-project-');
    writePin(project, tmpdir('myco-agree-untrusted-'), 0o664);

    const [answer] = resolveBoth([project], { HOME: fakeHome });
    expectAgreed(answer, machineHome);
    // The shim refuses the same pin; it exports nothing and the child resolves
    // its own home, which is the machine pin the other two just answered.
    writeCommandPin(project);
    expectShimAgrees(project, { HOME: fakeHome }, '');
  });

  it('agree that a pin value which is not an absolute path is refused', () => {
    const fakeHome = tmpdir('myco-agree-homedir-');
    const project = tmpdir('myco-agree-project-');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    const pin = path.join(project, '.myco', 'runtime.home');
    // The shape a repository could carry to every clone.
    fs.writeFileSync(pin, 'vendor/home\n');
    fs.chmodSync(pin, 0o644);

    const [answer] = resolveBoth([project], { HOME: fakeHome });
    expectAgreed(answer, path.join(fakeHome, '.myco'));
    writeCommandPin(project);
    expectShimAgrees(project, { HOME: fakeHome }, '');
  });
});
