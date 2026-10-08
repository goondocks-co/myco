import liveFs from 'node:fs';
const fs = { ...liveFs, promises: { ...liveFs.promises } };
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandboxPath } from './test-tool-path.mjs';
import { sandboxChildEnv, assertTestPath } from './test-environment.mjs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

const nativeSpawnSync = globalThis.Bun ? Bun.spawnSync.bind(Bun) : cp.spawnSync.bind(cp);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const MANAGERS = new Set(['launchctl', 'systemctl']);
const GUARD_ENV = 'MYCO_TEST_SERVICE_GUARD_DIR';
const GUARD_STATUS = 97;
const EXECUTION_BOUNDARY_PROBE = '/usr/bin/true';
const guardedCommands = new WeakSet();
const toolDirectories = new Map();
const journals = new Set();

function inside(root, candidate) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function executable(command, env, cwd) {
  const candidates = /[/\\]/.test(command)
    ? [path.resolve(cwd, command)]
    : (env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); }
    catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  return null;
}

function refuse(dir, name) {
  fs.appendFileSync(path.join(dir, 'denials'), `${name}\n`);
  throw new Error(`TEST SAFETY: real service-manager execution refused (${name})`);
}

export function assertServiceCommand(cmd, env, cwd = process.cwd()) {
  const dir = env[GUARD_ENV];
  if (!dir || !cmd.length) return;
  const check = command => {
    const target = executable(command, env, cwd);
    const name = path.basename(target ?? command);
    if (!MANAGERS.has(name)) return;
    if (target && !inside(dir, target) && inside(env.MYCO_TEST_RUN_ROOT, target)) return;
    refuse(dir, name);
  };
  check(cmd[0]);
  if (['sudo', 'env'].includes(path.basename(cmd[0]))) {
    for (const arg of cmd.slice(1)) if (MANAGERS.has(path.basename(arg))) check(arg);
  }
  const shell = ['sh', 'bash', 'zsh', 'dash'].includes(path.basename(cmd[0]));
  if (shell) {
    const index = cmd.findIndex(arg => /^-[a-z]*c/.test(arg));
    let script = index < 0 ? null : cmd[index + 1];
    if (index < 0) {
      const file = cmd.slice(1).find(arg => !arg.startsWith('-'));
      if (file) {
        try { script = fs.readFileSync(path.resolve(cwd, file), 'utf8'); }
        catch (error) { if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error; }
      }
    }
    if (script) for (const match of script.matchAll(/(?:^|[;\n|&(){}])\s*(?:(?:if|then|while|do|exec|sudo|command|env)\s+)*['"]?((?:\/[^\s'";|&]+\/)?(?:launchctl|systemctl))(?=[\s'";|&]|$)/g)) check(match[1]);
  }

}

export function serviceGuardEnvironment(root, incoming = process.env) {
  if (process.env.MYCO_TEST_RUN_ROOT) {
    let owned = false;
    try { owned = inside(process.env.MYCO_TEST_RUN_ROOT, root); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    if (!owned) throw new Error('TEST SAFETY: service guard root is outside the test temp root');
  }
  const dir = path.join(root, '.service-exec-guard');
  fs.mkdirSync(dir, { recursive: true });
  journals.add(dir);
  if (!fs.existsSync(path.join(dir, 'denials'))) fs.writeFileSync(path.join(dir, 'denials'), '');
  for (const name of MANAGERS) {
    const shim = path.join(dir, name);
    if (!fs.existsSync(shim)) fs.writeFileSync(shim,
      `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${path.join(dir, 'denials').replaceAll("'", "'\\''")}'\nprintf '%s\\n' 'TEST SAFETY: real service-manager execution refused (${name})' >&2\nexit ${GUARD_STATUS}\n`, { mode: 0o755 });
  }
  let tooling = toolDirectories.get(dir);
  if (!tooling || !fs.existsSync(tooling)) {
    tooling = sandboxPath(path.join(dir, 'tools'), incoming.PATH ?? process.env.PATH);
    toolDirectories.set(dir, tooling);
  }
  const options = incoming.NODE_OPTIONS ?? '';
  const preload = pathToImport();
  return { [GUARD_ENV]: dir,
    MYCO_TEST_SERVICE_TOOL_DIR: tooling,
    NODE_OPTIONS: options.includes(preload) ? options : `${options} --import=${preload}`.trim() };
}

function pathToImport() { return new URL('./test-service-exec.mjs', import.meta.url).href; }

export function guardedServicePath(env) {
  const dir = env[GUARD_ENV];
  if (!dir) return env.PATH;
  const incoming = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const owned = incoming.filter(candidate => {
    try { return inside(env.MYCO_TEST_RUN_ROOT, candidate) && candidate !== dir; }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
  });
  return [...new Set([...owned, dir, ...incoming])].join(path.delimiter);
}

export function assertNoServiceExecutions(dir) {
  const file = path.join(dir, 'denials');
  if (journals.has(dir) && !fs.existsSync(file)) throw new Error('TEST SAFETY: service-execution journal was removed');
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) {
    throw new Error('TEST SAFETY: a test attempted real service-manager execution; use its runner seam');
  }
}

export function assertAllServiceExecutions() {
  for (const dir of journals) assertNoServiceExecutions(dir);
}

export function consumeServiceExecDenials(dir) {
  const file = path.join(dir, 'denials');
  if (!fs.existsSync(file)) { journals.delete(dir); return ''; }
  const entries = fs.readFileSync(file, 'utf8');
  if (entries) fs.truncateSync(file, 0);
  return entries;
}

// Fixture cleanup cannot erase an unacknowledged service-execution attempt.
function assertServiceCleanup(candidate) {
  let file = path.resolve(typeof candidate === 'string' ? candidate : Buffer.isBuffer(candidate) ? candidate.toString() : fileURLToPath(candidate));
  try { file = fs.realpathSync(file); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  const covered = [];
  for (const dir of journals) {
    const relative = path.relative(file, dir);
    if ((relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) || file === path.join(dir, 'denials')) {
      assertNoServiceExecutions(dir); covered.push(dir);
    }
  }
  return covered;
}
for (const name of ['rm', 'rmdir', 'unlink', 'rename']) {
  const sync = liveFs[`${name}Sync`];
  liveFs[`${name}Sync`] = function (candidate, ...args) {
    const covered = assertServiceCleanup(candidate);
    const result = sync.call(this, candidate, ...args);
    for (const dir of covered) journals.delete(dir);
    return result;
  };
  const callback = liveFs[name];
  liveFs[name] = function (candidate, ...args) {
    let covered;
    try { covered = assertServiceCleanup(candidate); }
    catch (error) {
      const handler = args.at(-1);
      if (typeof handler !== 'function') throw error;
      process.nextTick(handler, error);
      return;
    }
    const handler = args.at(-1);
    if (typeof handler === 'function') args[args.length - 1] = function (error, ...values) {
      if (!error) for (const dir of covered) journals.delete(dir);
      return handler(error, ...values);
    };
    return callback.call(this, candidate, ...args);
  };
  const promise = liveFs.promises[name];
  liveFs.promises[name] = async function (candidate, ...args) {
    const covered = assertServiceCleanup(candidate);
    const result = await promise.call(this, candidate, ...args);
    for (const dir of covered) journals.delete(dir);
    return result;
  };
}

function builtHelper(dir, name, source, libraries, env) {
  const binary = path.join(dir, name);
  if (!fs.existsSync(binary)) {
    const staging = `${binary}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const command = ['cc', path.join(HERE, source), '-O2', '-o', staging, ...libraries];
    const result = globalThis.Bun ? nativeSpawnSync(command, { env }) : nativeSpawnSync(command[0], command.slice(1), { env });
    if ((result.exitCode ?? result.status) !== 0) { fs.rmSync(staging, { force: true }); throw new Error('TEST SAFETY: could not build the service-exec sandbox'); }
    fs.renameSync(staging, binary);
  }
  return binary;
}

export function testExecHelper(name, source, libraries = []) {
  return builtHelper(process.env[GUARD_ENV], name, source, libraries, process.env);
}

function assertLaunchable(cmd, env, cwd) {
  const fail = (code = 'ENOENT') => {
    const error = new Error(`spawn ${cmd[0]} ${code}`);
    Object.assign(error, { code, errno: code === 'ENOENT' ? -2 : -13, syscall: `spawn ${cmd[0]}`, path: cmd[0], spawnargs: cmd.slice(1) });
    throw error;
  };
  const target = executable(cmd[0], env, cwd);
  if (!target) fail();
  if (!fs.statSync(target).isFile()) fail('EACCES');
  let fd;
  try { fd = fs.openSync(target, 'r'); }
  catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) return; throw error; }
  const prefix = Buffer.alloc(4096);
  let size;
  try { size = fs.readSync(fd, prefix, 0, prefix.length, 0); } finally { fs.closeSync(fd); }
  const line = prefix.subarray(0, size).toString('utf8').split('\n', 1)[0];
  if (!line.startsWith('#!')) return;
  const interpreter = line.slice(2).trim().split(/\s+/, 1)[0];
  if (!executable(interpreter, env, cwd)) fail();
}

export function sandboxServiceChild(cmd, env, cwd = process.cwd(), extraDenied = []) {
  extraDenied = [EXECUTION_BOUNDARY_PROBE, ...extraDenied, ...(env.MYCO_TEST_SERVICE_DENY_EXEC ? JSON.parse(env.MYCO_TEST_SERVICE_DENY_EXEC) : [])];
  assertServiceCommand(cmd, env, cwd);
  if (guardedCommands.has(cmd) || !['darwin', 'linux'].includes(process.platform)) return cmd;
  assertLaunchable(cmd, env, cwd);
  const guarded = command => { Object.freeze(command); guardedCommands.add(command); return command; };
  if (process.platform === 'darwin') {
    const targets = [...extraDenied, ...['launchctl', 'systemctl'].flatMap(name => ['/bin', '/sbin', '/usr/bin', '/usr/sbin'].map(dir => path.join(dir, name)))];
    const probe = builtHelper(env[GUARD_ENV], 'sandbox-check', 'test-sandbox-check.c', ['-lsandbox'], env);
    const result = globalThis.Bun ? nativeSpawnSync([probe, ...targets], { env }) : nativeSpawnSync(probe, targets, { env });
    if ((result.exitCode ?? result.status) === 0) return cmd;
    const profile = `(version 1)(allow default)(deny process-exec ${targets.map(target => `(literal ${JSON.stringify(target)})`).join(' ')})`;
    return guarded(['/usr/bin/sandbox-exec', '-p', profile, ...cmd]);
  }
  if (process.platform === 'linux') {
    const dir = env[GUARD_ENV];
    const binary = builtHelper(dir, 'exec-sandbox', 'test-exec-sandbox.c', [], env);
    const directories = [env.MYCO_TEST_RUN_ROOT, REPO, '/usr/lib/git-core', '/usr/lib/gcc'];
    const tools = [env.MYCO_TEST_SERVICE_TOOL_DIR, ...(env.PATH ?? '').split(path.delimiter)].filter(Boolean).flatMap(dir => {
      try {
        if (!inside(env.MYCO_TEST_RUN_ROOT, dir)) return [];
        return fs.readdirSync(dir).map(name => path.join(dir, name)).filter(candidate => fs.statSync(candidate).isFile());
      }
      catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return []; throw error; }
    });
    const loaders = ['/lib64/ld-linux-x86-64.so.2', '/lib/ld-linux-aarch64.so.1', '/lib/ld-linux-armhf.so.3', '/lib/ld-linux.so.2'];
    const paths = [...directories, ...tools, ...loaders, executable(cmd[0], env, cwd)].filter(Boolean).flatMap(candidate => {
      try {
        const target = fs.realpathSync(candidate);
        return MANAGERS.has(path.basename(target)) || extraDenied.includes(target) ? [] : [target];
      } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return []; throw error; }
    });
    return guarded([binary, ...[...new Set(paths)].flatMap(target => ['--allow', target]), '--', ...cmd]);
  }
  return cmd;
}

// Node descendants retain the execution boundary when they replace their environment.
if (!globalThis.Bun) {
  const originals = Object.fromEntries(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync'].map(name => [name, cp[name]]));
  for (const name of Object.keys(originals)) {
    cp[name] = function (...args) {
      if (!process.env[GUARD_ENV]) return originals[name].apply(this, args);
      const shell = name === 'exec' || name === 'execSync';
      const index = shell ? 1 : Array.isArray(args[1]) ? 2 : 1;
      const options = args[index];
      const object = options !== null && typeof options === 'object' ? options : {};
      const root = process.env.MYCO_TEST_CHILD_ROOT ?? process.env.MYCO_TEST_RUN_ROOT;
      const overrides = object.env ?? process.env;
      const env = sandboxChildEnv(root, { ...overrides, HOME: overrides.HOME ?? process.env.HOME, PATH: overrides.PATH ?? process.env.PATH }, {});
      for (const name of ['TMPDIR', 'TEMP', 'TMP']) assertTestPath(root, env[name], name);
      env[GUARD_ENV] = process.env[GUARD_ENV];
      env.MYCO_TEST_RUN_ROOT = process.env.MYCO_TEST_RUN_ROOT;
      env.PATH = guardedServicePath(env);
      env.NODE_OPTIONS = process.env.NODE_OPTIONS;
      const cwd = object.cwd ? fileURLToPathIfNeeded(object.cwd) : process.cwd();
      const forkArgs = [...(object.execArgv ?? process.execArgv)];
      if (name === 'fork' && object.execArgv === undefined && process._eval !== undefined) {
        const index = forkArgs.indexOf(process._eval);
        if (index > 0) forkArgs.splice(index - 1, 2);
      }
      const direct = name === 'fork' ? [object.execPath ?? process.execPath, ...forkArgs]
        : [args[0], ...(Array.isArray(args[1]) ? args[1] : [])];
      const useShell = shell || (name !== 'fork' && object.shell);
      const defaultShell = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh';
      const shellPath = typeof object.shell === 'string' ? object.shell : defaultShell;
      const script = shell ? args[0] : direct.join(' ');
      const cmd = useShell ? [shellPath, ...(process.platform === 'win32' ? ['/d', '/s', '/c'] : ['-c']), script] : direct;
      assertServiceCommand(direct, env, cwd);
      let guarded;
      try { guarded = sandboxServiceChild(cmd, env, cwd); }
      catch (error) {
        if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
        if (['spawnSync'].includes(name)) return { error, status: null, signal: null, pid: 0, stdout: null, stderr: null, output: null };
        if (name.endsWith('Sync')) throw error;
        const child = new cp.ChildProcess();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        const callback = typeof options === 'function' ? options : args[index + 1];
        process.nextTick(() => {
          if (typeof callback === 'function') callback(error, '', '');
          else child.emit('error', error);
          child.stdout.end(); child.stderr.end(); child.emit('close', -2, null);
        });
        return child;
      }
      const isolated = { ...object, env };
      if (process.platform === 'win32') {
        if (typeof options === 'function') args.splice(index, 0, isolated);
        else args[index] = isolated;
        return originals[name].apply(this, args);
      }
      delete isolated.shell;
      if (name === 'fork') {
        isolated.execPath = guarded[0];
        isolated.execArgv = guarded.slice(1);
        if (typeof options === 'function') args.splice(index, 0, isolated);
        else args[index] = isolated;
        return originals[name].apply(this, args);
      }
      const rest = typeof options === 'function' ? [options, ...args.slice(index + 1)] : args.slice(index + 1);
      const operation = shell ? name === 'exec' ? 'execFile' : 'execFileSync' : name;
      return originals[operation].call(this, guarded[0], guarded.slice(1), isolated, ...rest);
    };
  }
  syncBuiltinESMExports();
  process.on('exit', () => {
    const dir = process.env[GUARD_ENV];
    if (!dir) return;
    try { assertNoServiceExecutions(dir); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = GUARD_STATUS; }
  });
}

function fileURLToPathIfNeeded(value) { return typeof value === 'string' ? value : fileURLToPath(value); }
