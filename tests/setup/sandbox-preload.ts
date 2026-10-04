// TEST-ONLY safety net. Loaded via bunfig [test] preload for EVERY bun test run
// (root bunfig.toml: node phases + raw `bun test`/`--watch`; bunfig.dom.toml:
// jsdom phase). Two chokepoints make a test touching live config improbable and,
// if something slips, loud:
//   1. Redirect os.homedir()/userInfo()/HOME to a throwaway per-process sandbox,
//      so home-derived paths resolve INSIDE the sandbox (current + future subsystems).
//   2. Fence fs mutations under real Myco and manifest-declared agent homes.
import './sandbox-environment.js';
import { afterAll } from 'bun:test';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { nativeLockRoots } from './native-lock-fence.js';
import { installFilesystemFence } from './filesystem-fence.js';
import fs from 'node:fs';
import path from 'node:path';
import { configureSqliteLibrary } from '../../packages/myco-server/src/platform/bun/sqlite-library.js';
import { removeRegisteredTestPaths } from '../support/remove-when-tests-end.js';

configureSqliteLibrary();

// The per-user lock root tests use (tests/helpers/per-user-lock-namespace.ts).
// The runner hands every test process one; a run outside the runner gets one
// made here and removed with the sandbox home. Under --isolate Bun resets
// process.env between files, so each file's preload makes and removes its own.
const LOCKS_ROOT_ENV = 'MYCO_TEST_PER_USER_LOCKS_ROOT';
const OWN_LOCKS_ROOT = process.env[LOCKS_ROOT_ENV]
  ? null
  : fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-locks-'));
if (OWN_LOCKS_ROOT !== null) process.env[LOCKS_ROOT_ENV] = OWN_LOCKS_ROOT;

const realHome = process.env.MYCO_TEST_REAL_HOME
  ?? execFileSync('node', ['-e', 'process.stdout.write(require("node:os").userInfo().homedir)'], { encoding: 'utf8' });
delete process.env.MYCO_TEST_REAL_HOME;
installFilesystemFence(realHome, nativeLockRoots());

// Cleanup retains the filesystem guard.
const origRmSync = fs.rmSync.bind(fs);

// Remove registered fixtures and process-owned locks. Bun's test runner runs a preload's
// `afterAll` after every file's own hooks (once per file under --isolate, where this
// preload also runs once per file) and does not emit process 'exit'; the 'exit'
// listener covers any other host.
function removeSandboxHome(): void {
  removeRegisteredTestPaths(origRmSync);
  if (OWN_LOCKS_ROOT !== null) {
    try { origRmSync(OWN_LOCKS_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
afterAll(removeSandboxHome);
process.on('exit', removeSandboxHome);

// `cloudflare:workers` is a workerd builtin; the containers package imports it
// at module load, and the Worker index re-exports the harness container class.
// Bun resolves the builtin to inert stand-ins so the graph loads; anything
// exercising real Durable Object behavior runs under workerd, never here.
Bun.plugin({
  name: 'cloudflare-workers-builtin',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      exports: { DurableObject: class {}, WorkerEntrypoint: class {} },
      loader: 'object',
    }));
  },
});
