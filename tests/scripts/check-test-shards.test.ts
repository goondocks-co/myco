import { expect, it } from 'bun:test';
import { parse } from 'yaml';
import { assertJobHeadroom, auditJobHeadroom, auditViewProofJob } from '../../scripts/check-test-shards.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

it('requires the complete view proof matrix, its execution and measured headroom', () => {
  const workflow = () => parse(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
  const durations = JSON.parse(fs.readFileSync('scripts/test-durations.json', 'utf8'));
  const original = workflow();
  const proofs = original.jobs['view-proof'].strategy.matrix.file.map((file: string) => ({ label: file, estimatedMs: durations.files[file] }));
  expect(() => auditViewProofJob(original, durations, proofs)).not.toThrow();
  const missing = workflow(); missing.jobs['view-proof'].strategy.matrix.file.pop();
  expect(() => auditViewProofJob(missing, durations, proofs)).toThrow('every proof file');
  const optional = workflow(); optional.jobs.check.needs = optional.jobs.check.needs.filter((name: string) => name !== 'view-proof');
  expect(() => auditViewProofJob(optional, durations, proofs)).toThrow('must be required');
  const skipped = workflow(); skipped.jobs['view-proof'].if = 'false';
  expect(() => auditViewProofJob(skipped, durations, proofs)).toThrow('must always run');
  const inert = workflow(); inert.jobs['view-proof'].steps.find((step: {run?: string}) => step.run === 'npm test').if = 'false';
  expect(() => auditViewProofJob(inert, durations, proofs)).toThrow('unconditionally');
  const short = workflow(); short.jobs['view-proof']['timeout-minutes'] = 10;
  expect(() => auditViewProofJob(short, durations, proofs)).toThrow('50%');
});

it('audits every shard through the runner without writing a parity manifest outside its root', () => {
  const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-audit-reports-'));
  const sentinel = path.join(reports, 'parent-report');
  fs.writeFileSync(sentinel, 'preserve');
  try {
    const result = spawnSync('node', ['scripts/run-test-command.mjs', 'node', 'scripts/check-test-shards.mjs'], {
      env: { ...process.env, MYCO_TEST_STRICT_TEMP: '1', MYCO_RUNNER_REPORT_DIR: reports },
      encoding: 'utf8', timeout: 90_000,
    });
    expect({ status: result.status, stderr: result.stderr, error: result.error }).toEqual({ status: 0, stderr: '', error: undefined });
    for (const label of ['Full suite', 'CI test shards', 'CI parity shards', 'Required jobs']) {
      expect(result.stdout).toMatch(new RegExp(`${label}: [1-9]\\d* entries covered exactly once`));
    }
    expect(result.stdout).toContain('Job headroom: 2 jobs within limit');
    expect(result.stdout).toMatch(/Per-test headroom: [1-9]\d* recorded cases within limit/);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserve');
  } finally {
    fs.rmSync(reports, { recursive: true, force: true });
  }
}, 100_000);

it('refuses eroded work margin and cold-install headroom at their measured boundaries', () => {
  const policy = { cacheMissMs: 200_000, setupMs: 100_000 };
  expect(() => assertJobHeadroom('screens', 15, 300_000, policy)).not.toThrow();
  expect(() => assertJobHeadroom('screens', 15, 300_001, policy)).toThrow('cache-miss');
  expect(() => assertJobHeadroom('screens', 15, 450_000)).not.toThrow();
  expect(() => assertJobHeadroom('screens', 15, 450_001)).toThrow('50%');
  for (const duration of [0, -1, NaN, Infinity]) {
    expect(() => assertJobHeadroom('screens', 15, duration, policy)).toThrow('measured duration');
  }
  expect(() => assertJobHeadroom('screens', 0, 1, policy)).toThrow('timeout');
});

it('measures commands and multi-step work, refusing overruns and preserving child failures', () => {
  const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'job-headroom-'));
  const invoke = (...args: string[]) => spawnSync('node', ['scripts/check-test-shards.mjs', ...args], {
    env: { ...process.env, MYCO_RUNNER_REPORT_DIR: reports }, encoding: 'utf8',
  });
  try {
    const failed = invoke('--measure', 'ui-screens', '--', 'node', '-e', 'process.exit(7)');
    expect(failed.status).toBe(7);
    const success = invoke('--measure', 'ui-screens', '--', 'node', '-e', 'process.stdout.write("measured child")');
    expect(success.status).toBe(0);
    expect(success.stdout).toContain('measured child');
    expect(success.stdout).toContain('ui-screens: measured');
    expect(invoke('--finish', 'hook-startup').status).not.toBe(0);
    expect(invoke('--start', 'hook-startup').status).toBe(0);
    expect(invoke('--finish', 'hook-startup').status).toBe(0);
    expect(invoke('--start', 'hook-startup').status).toBe(0);
    const stamp = path.join(reports, 'ci-timings/hook-startup-start.json');
    fs.writeFileSync(stamp, JSON.stringify({ started: Date.now() - 1_000_000 }));
    const overrun = invoke('--finish', 'hook-startup');
    expect(overrun.status).not.toBe(0);
    expect(overrun.stderr).toContain('50%');
    expect(invoke('--measure', 'unknown', '--', 'node', '-e', '').status).not.toBe(0);
  } finally {
    fs.rmSync(reports, { recursive: true, force: true });
  }
});

function aptFixture() {
  const action = parse(fs.readFileSync('.github/actions/apt-cache/action.yml', 'utf8'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-cache-contract-'));
  const archives = path.join(scratch, 'apt-archives/recipe');
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(archives, { recursive: true });
  fs.mkdirSync(bin);
  const calls = path.join(scratch, 'calls');
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\nif [ "$1" = tee ]; then cat >/dev/null; fi\n');
  fs.chmodSync(path.join(bin, 'sudo'), 0o755);
  const hit = action.runs.steps.find((step: { if?: string }) => step.if === "steps.archives.outputs.cache-hit == 'true'");
  const miss = action.runs.steps.find((step: { if?: string }) => step.if === "steps.archives.outputs.cache-hit != 'true'");
  const run = (script: string, install = 'exit 19') => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ARCHIVES: archives, CALLS: calls, RUNNER_TEMP: scratch, INSTALL: install }, encoding: 'utf8',
  });
  return { action, scratch, archives, calls, hit, miss, run, dispose: () => fs.rmSync(scratch, { recursive: true, force: true }) };
}

it('installs cached apt archives offline and keeps the miss recipe separate', () => {
  const fixture = aptFixture();
  const { action, archives, calls, hit, run } = fixture;
  try {
    expect(run(hit.run).status).not.toBe(0);
    fs.writeFileSync(path.join(archives, 'complete'), '');
    fs.writeFileSync(path.join(archives, 'dependency.deb'), 'fake deb');
    expect(run(hit.run).status).toBe(0);
    const offlineCalls = fs.readFileSync(calls, 'utf8');
    expect(offlineCalls).toContain(`apt-get -o Dir::Cache::archives=${archives} install --yes --no-download`);
    expect(offlineCalls).toContain('dependency.deb');
    expect(offlineCalls).not.toContain('update');
    const cache = action.runs.steps.find((step: { uses?: string }) => step.uses === 'actions/cache@v6');
    expect(cache.with.key).toContain('steps.image.outputs.key');
    expect(cache.with.key).toContain('steps.image.outputs.install');
    expect(cache.with.key).toContain('inputs.recipe');
    expect(cache.with['restore-keys']).toBeUndefined();
  } finally { fixture.dispose(); }
});

it('publishes the apt completion marker only after a successful miss', () => {
  const fixture = aptFixture();
  const { archives, miss, run } = fixture;
  try {
    expect(run(miss.run).status).toBe(19);
    expect(fs.existsSync(path.join(archives, 'complete'))).toBe(false);
    expect(run(miss.run, 'printf installed > "$ARCHIVES/installed"').status).toBe(0);
    expect(fs.readFileSync(path.join(archives, 'installed'), 'utf8')).toBe('installed');
    expect(fs.existsSync(path.join(archives, 'complete'))).toBe(true);
  } finally { fixture.dispose(); }
});

it('keys apt archives on the exact install command as well as the recipe', () => {
  const fixture = aptFixture();
  try {
    const image = fixture.action.runs.steps.find((step: { id?: string }) => step.id === 'image');
    expect(image.env.INSTALL).toBe('${{ inputs.install }}');
    const output = path.join(fixture.scratch, 'output');
    const key = (install: string) => {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', image.run], {
        env: { ...process.env, ImageOS: 'ubuntu24', ImageVersion: 'image1', INSTALL: install, GITHUB_OUTPUT: output }, encoding: 'utf8',
      });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      const lines = fs.readFileSync(output, 'utf8').trim().split('\n');
      return lines[lines.length - 1];
    };
    expect(key('apt-get install gcc')).not.toBe(key('apt-get install gcc g++'));
  } finally { fixture.dispose(); }
});

it('audits recorded job measurements against the actual workflow timeouts', () => {
  const workflow = parse(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
  const jobs = JSON.parse(fs.readFileSync('scripts/test-durations.json', 'utf8')).jobs;
  workflow.jobs['ui-screens']['timeout-minutes'] = 20;
  expect(() => auditJobHeadroom(workflow, jobs)).toThrow('50%');
  workflow.jobs['ui-screens']['timeout-minutes'] = 35;
  Reflect.deleteProperty(jobs['hook-startup'], 'measuredMs');
  expect(() => auditJobHeadroom(workflow, jobs)).toThrow('missing positive measured duration');
});

it('--measure rejects work above the live timeout share', () => {
  const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-overrun-'));
  try {
    const preload = path.join(reports, 'clock.mjs');
    fs.writeFileSync(preload, "import { performance } from 'node:perf_hooks'; let calls = 0; Object.defineProperty(performance, 'now', { value: () => calls++ ? 1100000 : 0 });");
    const result = spawnSync('node', ['--import', preload, 'scripts/check-test-shards.mjs', '--measure', 'ui-screens', '--', 'node', '-e', ''], {
      env: { ...process.env, MYCO_RUNNER_REPORT_DIR: reports }, encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('50%');
  } finally { fs.rmSync(reports, { recursive: true, force: true }); }
});

it.skipIf(!process.env.MYCO_APT_CACHE_TEST_IMAGE)('installs cached dependency upgrades with real Ubuntu apt and no network', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-offline-real-'));
  try {
    const action = parse(fs.readFileSync('.github/actions/apt-cache/action.yml', 'utf8'));
    const hit = action.runs.steps.find((step: { if?: string }) => step.if === "steps.archives.outputs.cache-hit == 'true'");
    fs.writeFileSync(path.join(fixture, 'hit.sh'), hit.run);
    fs.copyFileSync('tests/fixtures/runner/apt-cache-offline.sh', path.join(fixture, 'fixture.sh'));
    const homes = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'MYCO_HOME', 'TMPDIR'];
    const environment = homes.flatMap(name => {
      const directory = path.join(fixture, name.toLowerCase());
      fs.mkdirSync(directory);
      return ['--env', `${name}=${directory}`];
    });
    const result = spawnSync(process.env.MYCO_APT_CACHE_TEST_DOCKER ?? 'docker', ['run', '--rm', '--pull=never', '--network=none',
      '--volume', `${fixture}:${fixture}`, ...environment,
      process.env.MYCO_APT_CACHE_TEST_IMAGE!, 'bash', path.join(fixture, 'fixture.sh'), fixture], {
      encoding: 'utf8', timeout: 60_000,
    });
    expect({ status: result.status, error: result.error, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0, error: undefined });
    console.info(result.stdout);
    expect(result.stdout).toContain('Ubuntu 24.04');
    expect(result.stdout).toContain('Installed versions: 2.0 2.0');
    expect(result.stdout).not.toMatch(/^Get:/m);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}, 65_000);

it('requires the live per-test CI gate even after a failed test step', () => {
  const workflow = parse(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
  const jobs = JSON.parse(fs.readFileSync('scripts/test-durations.json', 'utf8')).jobs;
  expect(() => auditJobHeadroom(workflow, jobs)).not.toThrow();
  const command = 'node scripts/check-test-shards.mjs --test-reports target/test-reports';
  const step = workflow.jobs.tests.steps.find((value: { run?: string }) => value.run === command);
  step.if = "matrix.kind == 'node'";
  expect(() => auditJobHeadroom(workflow, jobs)).toThrow('missing always() live per-test');
  workflow.jobs.tests.steps = workflow.jobs.tests.steps.filter((value: { run?: string }) => value.run !== command);
  expect(() => auditJobHeadroom(workflow, jobs)).toThrow('missing always() live per-test');
});
