import { TEST_TEMP_ROOT } from './temp-root.js';
import './windows-process-identity.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHILD_HOME_NAMES, assertSandboxChildEnv, assertTestPath } from '../../scripts/test-environment.mjs';
import { registerTestProcess } from '../../scripts/test-process-tree.mjs';

const TEMP_ENV_NAMES = ['TMPDIR', 'TEMP', 'TMP'];
function tempEnvironment(env: NodeJS.ProcessEnv = process.env, cwd: string | URL = process.cwd()): NodeJS.ProcessEnv {
  const result = { ...env };
  const home = result.HOME ?? process.env.HOME;
  result.HOME = home;
  const defaults: NodeJS.ProcessEnv = home ? {
    USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_CONFIG_HOME: path.join(home, '.config'), MYCO_HOME: path.join(home, '.myco'),
    MYCO_LAUNCH_AGENTS_DIR: path.join(home, 'service-units'), MYCO_TEAM_HOME: path.join(home, '.myco-team'),
  } : {};
  for (const name of CHILD_HOME_NAMES.filter(name => name !== 'HOME')) {
    const inherited = result[name] === process.env[name];
    if (result[name] === undefined || (!result.MYCO_TEST_CHILD_ROOT && home !== process.env.MYCO_TEST_RUN_HOME && inherited)) result[name] = defaults[name];
  }
  const root = result.MYCO_TEST_CHILD_ROOT ?? TEST_TEMP_ROOT;
  assertSandboxChildEnv(TEST_TEMP_ROOT, { ...result, HOME: root });
  assertSandboxChildEnv(root, result);
  for (const name of TEMP_ENV_NAMES) {
    result[name] ??= root;
    assertTestPath(root, result[name], name);
  }
  if (result.MYCO_BIN_DIR !== undefined) {
    assertTestPath(root, path.resolve(typeof cwd === 'string' ? cwd : fileURLToPath(cwd), result.MYCO_BIN_DIR), 'MYCO_BIN_DIR');
  }
  return result;
}

type Operation = (...args: unknown[]) => unknown;
function withTempOptions(operation: Operation, optionsIndex: (args: unknown[]) => number, tracksChild = false): Operation {
  return function (this: unknown, ...args: unknown[]) {
    const index = optionsIndex(args);
    const options = args[index];
    const object = options !== null && typeof options === 'object' ? options as { env?: NodeJS.ProcessEnv; cwd?: string | URL } : {};
    const isolated = { ...object, env: tempEnvironment(object.env, object.cwd) };
    if (typeof options === 'function') args.splice(index, 0, isolated);
    else args[index] = isolated;
    const child = operation.apply(this, args);
    if (tracksChild) registerTestProcess(child as { pid?: number; kill(signal: NodeJS.Signals): unknown });
    return child;
  };
}

// Bun primitives also fence Node child-process imports that retain native exports.
const childProcess = require('node:child_process') as Record<string, Operation>;
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
  const index = name === 'exec' || name === 'execSync' ? () => 1 : (args: unknown[]) => Array.isArray(args[1]) ? 2 : 1;
  childProcess[name] = withTempOptions(childProcess[name]!, index, name === 'spawn' || name === 'fork');
}
const bunProcess = Bun as unknown as Record<string, Operation>;
for (const name of ['spawn', 'spawnSync']) {
  bunProcess[name] = withTempOptions(bunProcess[name]!, (args) => Array.isArray(args[0]) ? 1 : 0, name === 'spawn');
}
