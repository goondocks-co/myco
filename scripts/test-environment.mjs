import fs from 'node:fs';
import path from 'node:path';
import { sandboxPath } from './test-tool-path.mjs';
export { sandboxPath, resolveTestTool } from './test-tool-path.mjs';
import { serviceGuardEnvironment, guardedServicePath } from './test-service-exec.mjs';

export function sandboxTestHome(root) {
  const home = fs.mkdtempSync(path.join(root, 'h-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CODEX_HOME = path.join(home, '.codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  process.env.MYCO_HOME = path.join(home, '.myco');
  process.env.MYCO_LAUNCH_AGENTS_DIR = path.join(home, 'service-units');
  process.env.MYCO_TEAM_HOME = path.join(home, '.myco-team');
  process.env.MYCO_TEST_RUN_HOME = home;
  delete process.env.MYCO_TEST_CHILD_ROOT;
  process.env.PATH = sandboxPath(home);
  Object.assign(process.env, serviceGuardEnvironment(root));
  process.env.PATH = guardedServicePath(process.env);
  return home;
}

export const CHILD_HOME_NAMES = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'MYCO_HOME', 'MYCO_LAUNCH_AGENTS_DIR', 'MYCO_TEAM_HOME'];

function canonical(candidate, links = 0) {
  if (links > 64) throw new Error('TEST SAFETY: child path has a symlink cycle');
  let current = path.resolve(candidate);
  const suffix = [];
  while (!fs.existsSync(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        return canonical(path.resolve(path.dirname(current), fs.readlinkSync(current), ...suffix), links + 1);
      }
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    suffix.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) throw new Error('TEST SAFETY: child home has no existing ancestor');
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...suffix);
}

export function assertTestPath(root, candidate, label) {
  const relative = candidate && path.isAbsolute(candidate) ? path.relative(canonical(root), canonical(candidate)) : '..';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`TEST SAFETY: spawned child ${label} is outside its test temp root`);
  }
}

export function assertSandboxChildEnv(root, env) {
  for (const name of CHILD_HOME_NAMES) assertTestPath(root, env[name], name);
}

export function sandboxChildEnv(root, overrides = {}, base = process.env) {
  if (process.env.MYCO_TEST_RUN_ROOT) assertTestPath(process.env.MYCO_TEST_RUN_ROOT, root, 'child fixture root');
  const home = overrides.HOME ?? root;
  const env = {
    ...base, TMPDIR: root, TEMP: root, TMP: root,
    HOME: home, USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_CONFIG_HOME: path.join(home, '.config'), MYCO_HOME: path.join(home, '.myco'),
    MYCO_LAUNCH_AGENTS_DIR: path.join(home, 'service-units'), MYCO_TEAM_HOME: path.join(home, '.myco-team'),
    ...overrides, MYCO_TEST_CHILD_ROOT: root,
  };
  env.MYCO_TEST_RUN_ROOT ??= process.env.MYCO_TEST_RUN_ROOT ?? root;
  Object.assign(env, serviceGuardEnvironment(env.MYCO_TEST_RUN_ROOT, env));
  env.PATH = guardedServicePath(env);
  assertSandboxChildEnv(root, env);
  return env;
}

export function bindSandboxChildHome(root, overrides = {}) {
  const env = sandboxChildEnv(root, overrides);
  const names = [...CHILD_HOME_NAMES, 'TMPDIR', 'TEMP', 'TMP', 'MYCO_TEST_CHILD_ROOT'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = env[name];
  return () => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  };
}
