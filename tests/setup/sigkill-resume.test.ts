import { afterEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { run } from '@myco/cli/setup.js';
import { legacyMigrationState } from '@myco/member/legacy-migration.js';
import { legacyJourney, LEGACY_URLS } from './fixtures/legacy-journey.js';
import { legacyInterruption } from './fixtures/legacy-interruption.js';

let root: string;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});

it('resumes across SIGKILL at every observed cutover mutation boundary and preserves 1.4 data', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-sigkill-'));
  const flags = ['--join', LEGACY_URLS[0], '--cutover', '--no-runner', '--yes'];
  const started = performance.now();
  const timings = { reset: 0, stop: 0, resume: 0 };
  const initial = await legacyJourney(path.join(root, 'observed'), { multi: true, agents: ['claude-code', 'codex'] });
  try { expect(await run(flags, { ...initial.deps, stdout: () => {}, stderr: () => {} })).toBe(0); } finally { await initial.close(); }
  const boundaries = ['consent', ...new Set(initial.checkpoints)];
  expect(boundaries).toContain('destinations');
  expect(boundaries).toContain('handover');
  expect(boundaries).toContain('stopped-source:0');
  expect(boundaries).toContain('stopped-source:1');
  expect(boundaries).toContain('stopped-source:final');
  expect(boundaries).toContain('copy');
  expect(boundaries).toContain('action:3:0');
  expect(boundaries).toContain('action:3:1');
  expect(boundaries).toContain('vault:proj_legacy_a');
  expect(boundaries).toContain('transcripts:proj_legacy_b');
  const repo = fileURLToPath(new globalThis.URL('../../', import.meta.url));
  const args = ['test', '--preload', path.join(repo, 'tests/setup/sandbox-preload.ts'), '--tsconfig-override', path.join(repo, 'tsconfig.json'), path.join(repo, 'tests/setup/fixtures/legacy_journey_interruption_test.ts')];
  const childRoot = path.join(root, 'interrupted');
  const template = await legacyJourney(childRoot, { multi: true, agents: ['claude-code', 'codex'] });
  await template.close();
  const pristine = path.join(root, 'pristine');
  fs.cpSync(childRoot, pristine, { recursive: true });
  for (const growth of [false, true]) for (const boundary of boundaries) {
    const resetAt = performance.now();
    fs.rmSync(childRoot, { recursive: true, force: true });
    fs.cpSync(pristine, childRoot, { recursive: true });
    timings.reset += performance.now() - resetAt;
    const stopAt = performance.now();
    const env = sandboxChildEnv(childRoot, { MYCO_SETUP_FIXTURE_ROOT: childRoot, ...(growth ? { MYCO_SETUP_GROW: '1' } : {}) });
    const child = spawn(process.execPath, args, { env: { ...env, MYCO_SETUP_STOP_AFTER: boundary }, cwd: childRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const capture = (chunk: Buffer) => { output += chunk.toString(); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(path.join(childRoot, 'reached')) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
      expect({ boundary, reached: fs.existsSync(path.join(childRoot, 'reached')), output }).toMatchObject({ reached: true });
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; }
    timings.stop += performance.now() - stopAt;
    const resumeAt = performance.now();
    const resumed = await legacyInterruption(childRoot, { growth });
    const fixture = resumed.legacy;
    try {
      expect(fs.readFileSync(fixture.vault)).toEqual(fs.readFileSync(path.join(childRoot, 'vault-before')));
      expect({ boundary, code: await run(['--yes'], { ...resumed.deps, stdout: () => {}, stderr: () => {} }) }).toMatchObject({ code: 0 });
      expect(legacyMigrationState(fixture.mycoHome).state).toBe('moved');
      expect(fs.readFileSync(fixture.vault)).toEqual(fs.readFileSync(path.join(childRoot, 'vault-before')));
      expect(fs.readFileSync(path.join(fixture.mycoHome, 'unmanaged.txt'), 'utf8')).toBe('Keep this user file byte for byte.\n');
      if (growth) expect(fs.existsSync(path.join(childRoot, 'grew'))).toBe(true);
      if (boundary === 'vault:proj_legacy_b' || boundary.startsWith('settings:')) expect(resumed.calls.filter(call => call.route === '/events' || call.route === '/spores/save')).toEqual([]);
    } finally { await resumed.close(); }
    timings.resume += performance.now() - resumeAt;
  }
  console.log(`[setup-sigkill] ${boundaries.length * 2} cases; reset ${Math.round(timings.reset)}ms; stop ${Math.round(timings.stop)}ms; resume ${Math.round(timings.resume)}ms; total ${Math.round(performance.now() - started)}ms`);
}, 180_000);

