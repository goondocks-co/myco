import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describeWindowsFileLock } from './windows-file-lock.mjs';

const ROOT_NAME = /^mt-(?:[A-Za-z0-9]{6}|sweep-\d+-\d+)$/;
const RETIRED_NAME = /^\.mt-cleanup-([1-9]\d*)-mt-(?:[A-Za-z0-9]{6}|sweep-\d+-\d+)$/;
const TEST_NAME = /^(?:myco-|mt-)/;
const TEMP_ENV_NAMES = ['TMPDIR', 'TEMP', 'TMP'];
const CLEANUP_RETRIES = Number(process.env.MYCO_TEST_CLEANUP_RETRIES ?? 30);
if (!Number.isSafeInteger(CLEANUP_RETRIES) || CLEANUP_RETRIES < 0) throw new Error('Invalid MYCO_TEST_CLEANUP_RETRIES');
const CLEANUP_RETRY_DELAY_MS = 100;
const cleanupWait = new Int32Array(new SharedArrayBuffer(4));

function ownerPid(root) {
  try {
    const pid = Number(fs.readFileSync(path.join(root, '.owner'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR'].includes(error.code)) return null;
    if (typeof error.code === 'string') {
      console.warn(`[run-bun-tests] cannot read temp-root owner ${root} (${error.code}): ${error.message}`);
      return null;
    }
    throw error;
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    console.warn(`[run-bun-tests] cannot judge temp-root owner PID ${pid} (${error.code ?? 'unknown'}): ${error.message}`);
    return null;
  }
}

// Retired roots leave the leak-scan namespace before their owner marker is removed.
function removeRunRoot(root) {
  const retired = path.join(path.dirname(root), `.mt-cleanup-${process.pid}-${path.basename(root)}`);
  const target = RETIRED_NAME.test(path.basename(root)) ? root : retired;
  if (target !== root) {
    for (let attempt = 0; ; attempt += 1) {
      try { fs.renameSync(root, target); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt >= CLEANUP_RETRIES) throw error;
        Atomics.wait(cleanupWait, 0, 0, (attempt + 1) * CLEANUP_RETRY_DELAY_MS);
      }
    }
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
}

export function sweepStaleRunRoots(parent) {
  let swept = 0;
  for (const name of fs.readdirSync(parent)) {
    const retired = RETIRED_NAME.exec(name);
    if (!ROOT_NAME.test(name) && !retired) continue;
    const root = path.join(parent, name);
    try {
      if (!fs.lstatSync(root).isDirectory()) continue;
      const pid = retired ? Number(retired[1]) : ownerPid(root);
      if (pid !== null && !Number.isSafeInteger(pid)) continue;
      if (pid === null || alive(pid) !== false) continue;
      removeRunRoot(root);
      swept += 1;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return swept;
}

// Inspect the inherited temp directory and OS defaults, including a child's
// default when its environment omits TMPDIR. No inspected entry is removed.
export function systemTempDirectories() {
  const dirs = [os.tmpdir()];
  if (process.platform !== 'win32') dirs.push('/tmp', '/var/tmp');
  if (process.platform === 'darwin') {
    dirs.push(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim());
  }
  return [...new Set(dirs.map((dir) => fs.realpathSync(dir)))];
}

export function snapshotTestTemps(directories) {
  return new Map(directories.map((dir) => [dir, new Set(fs.readdirSync(dir).filter((name) => TEST_NAME.test(name)))]));
}

export function newTestTemps(before, startedAt, root) {
  const leaks = [];
  for (const [dir, names] of before) {
    for (const name of fs.readdirSync(dir)) {
      if (!TEST_NAME.test(name) || names.has(name)) continue;
      const entry = path.join(dir, name);
      if (entry === root) continue;
      let stat;
      try { stat = fs.lstatSync(entry); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.birthtimeMs > 0 && stat.birthtimeMs < startedAt) continue;
      // A live sibling runner's root belongs to that runner's process tree.
      const pid = ROOT_NAME.test(name) ? ownerPid(entry) : null;
      if (pid !== null && pid !== process.pid && alive(pid)) continue;
      // A sibling may retire between the directory listing and the owner read.
      try { fs.lstatSync(entry); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      leaks.push(entry);
    }
  }
  return leaks;
}

export function createTestTempRun({ parent = os.tmpdir(), directories = systemTempDirectories() } = {}) {
  const swept = sweepStaleRunRoots(parent);
  if (swept > 0) console.log(`[run-bun-tests] removed ${swept} temp root(s) left by earlier runs`);
  const startedAt = Date.now();
  const before = snapshotTestTemps(directories);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'mt-')));
  const strict = process.env.MYCO_TEST_STRICT_TEMP === '1'
    || !['', '0', 'false'].includes((process.env.CI ?? '').toLowerCase());
  fs.writeFileSync(path.join(root, '.owner'), `${process.pid}\n`);
  process.env.MYCO_TEST_RUN_ROOT = root;
  process.env.MYCO_TEST_SYSTEM_TEMP_DIRS = JSON.stringify(directories);
  for (const name of TEMP_ENV_NAMES) process.env[name] = root;
  let finished = false;
  return {
    root,
    strict,
    finish() {
      if (finished) return [];
      try {
        const leaks = newTestTemps(before, startedAt, root);
        for (const dir of directories) {
          const left = leaks.filter((entry) => path.dirname(entry) === dir);
          console.log(`[run-bun-tests] temp entries left in ${dir}: ${left.length}${left.length ? ` (${left.join(', ')})` : ''}`);
        }
        if (leaks.length) console.error(`[run-bun-tests] ${strict ? 'FAIL' : 'WARN'}: new test temp entries outside the run root (creator unknown)`);
        return leaks;
      } finally {
        try {
          removeRunRoot(root);
        } catch (error) {
          if (process.platform === 'win32' && error.code === 'EBUSY') {
            try { console.error(`[run-bun-tests] locked file ${error.path}: ${describeWindowsFileLock(error.path)}`); }
            catch (inspectionError) { console.error(`[run-bun-tests] file-lock inspection failed: ${inspectionError}`); }
          }
          throw error;
        }
        finished = true;
      }
    },
  };
}

// Exit-listener exceptions need an explicit failing status in Node.
export function finishTestTempRun(run, beforeCleanup = () => {}) {
  try {
    try {
      beforeCleanup();
    } finally {
      if (run.finish().length > 0 && run.strict && !process.exitCode) process.exitCode = 1;
    }
  } catch (error) {
    process.exitCode ||= 1;
    throw error;
  }
}
