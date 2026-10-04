import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT_NAME = /^mt-(?:[A-Za-z0-9]{6}|sweep-\d+-\d+)$/;
const TEST_NAME = /^(?:myco-|mt-)/;
const TEMP_ENV_NAMES = ['TMPDIR', 'TEMP', 'TMP'];
const OWNERLESS_GRACE_MS = 60 * 60 * 1000;
const CLEANUP_RETRIES = 10;

function ownerPid(root) {
  try {
    const pid = Number(fs.readFileSync(path.join(root, '.owner'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return null;
    throw error;
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export function sweepStaleRunRoots(parent) {
  let swept = 0;
  for (const name of fs.readdirSync(parent)) {
    if (!ROOT_NAME.test(name)) continue;
    const root = path.join(parent, name);
    const pid = ownerPid(root);
    try {
      if (pid !== null ? alive(pid) : Date.now() - fs.statSync(root).mtimeMs <= OWNERLESS_GRACE_MS) continue;
      const claimed = path.join(parent, `mt-sweep-${process.pid}-${swept}`);
      fs.renameSync(root, claimed);
      fs.rmSync(claimed, { recursive: true, force: true, maxRetries: 3 });
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
  fs.writeFileSync(path.join(root, '.owner'), `${process.pid}\n`);
  process.env.MYCO_TEST_RUN_ROOT = root;
  for (const name of TEMP_ENV_NAMES) process.env[name] = root;
  let finished = false;
  return {
    root,
    finish() {
      if (finished) return [];
      try {
        const leaks = newTestTemps(before, startedAt, root);
        for (const dir of directories) {
          const left = leaks.filter((entry) => path.dirname(entry) === dir);
          console.log(`[run-bun-tests] temp entries left in ${dir}: ${left.length}${left.length ? ` (${left.join(', ')})` : ''}`);
        }
        if (leaks.length) console.error('[run-bun-tests] FAIL: test temp entries escaped the run root');
        return leaks;
      } finally {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
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
      if (run.finish().length > 0 && !process.exitCode) process.exitCode = 1;
    }
  } catch (error) {
    process.exitCode ||= 1;
    throw error;
  }
}
