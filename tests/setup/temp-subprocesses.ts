import { TEST_TEMP_ROOT } from './temp-root.js';
import path from 'node:path';
import { registerTestProcess } from '../../scripts/test-process-tree.mjs';

const TEMP_ENV_NAMES = ['TMPDIR', 'TEMP', 'TMP'];
const HOME_ENV_NAMES = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];

function tempEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const name of HOME_ENV_NAMES) result[name] ??= process.env[name];
  // An explicit HOME controls its own Myco configuration precedence.
  if (!Object.hasOwn(env, 'HOME') && !Object.hasOwn(env, 'MYCO_HOME')) result.MYCO_HOME = process.env.MYCO_HOME;
  for (const name of TEMP_ENV_NAMES) {
    const candidate = result[name];
    const relative = candidate ? path.relative(TEST_TEMP_ROOT, path.resolve(candidate)) : '..';
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) result[name] = TEST_TEMP_ROOT;
  }
  return result;
}

type Operation = (...args: unknown[]) => unknown;
function withTempOptions(operation: Operation, optionsIndex: (args: unknown[]) => number, tracksChild = false): Operation {
  return function (this: unknown, ...args: unknown[]) {
    const index = optionsIndex(args);
    const options = args[index];
    const object = options !== null && typeof options === 'object' ? options as { env?: NodeJS.ProcessEnv } : {};
    const isolated = { ...object, env: tempEnvironment(object.env) };
    if (typeof options === 'function') args.splice(index, 0, isolated);
    else args[index] = isolated;
    const child = operation.apply(this, args);
    if (tracksChild) registerTestProcess(child as { pid?: number; kill(signal: NodeJS.Signals): unknown });
    return child;
  };
}

// Patch the builtin before tests import it; named imports resolve these exports too.
const childProcess = require('node:child_process') as Record<string, Operation>;
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
  const index = name === 'exec' || name === 'execSync' ? () => 1 : (args: unknown[]) => Array.isArray(args[1]) ? 2 : 1;
  childProcess[name] = withTempOptions(childProcess[name]!, index, name === 'spawn' || name === 'fork');
}
const bunProcess = Bun as unknown as Record<string, Operation>;
for (const name of ['spawn', 'spawnSync']) {
  bunProcess[name] = withTempOptions(bunProcess[name]!, (args) => Array.isArray(args[0]) ? 1 : 0, name === 'spawn');
}
