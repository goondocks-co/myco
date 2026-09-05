/**
 * Deployment lifecycle, asserted by the argv it produces and the bundle it
 * writes.
 *
 * A container per assertion would make the suite depend on a Docker daemon and
 * a published image. The {@link CommandRunner} port keeps the orchestration
 * under test and the container out of it, so what is verified here is the part
 * that can be wrong in a way an operator cannot see: the wrong project name,
 * an unscoped `down`, a secret written world-readable.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDeployment,
  deploymentStatus,
  destroyDeployment,
  materializeBundle,
  resolveDeploymentPaths,
  GENERATED_SECRETS,
  COMPOSE_PROJECT,
  DEFAULT_FLEET,
  DESTROY_STOP_TIMEOUT_SECONDS,
} from '@myco/server/deployment.js';
import { HARNESS_STOP_GRACE_SECONDS } from '@myco/server/compose-template.js';
import type { CommandRunner, CommandResult } from '@myco/server/runner.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

let calls: { command: string; args: string[] }[] = [];
const runner = (result: Partial<CommandResult> = {}): CommandRunner => ({
  async run(command, args) {
    calls.push({ command, args: [...args] });
    return { code: 0, stdout: '', stderr: '', ...result };
  },
});

function paths() {
  const home = mkdtempSync(join(tmpdir(), 'myco-deploy-'));
  roots.push(home);
  return resolveDeploymentPaths(home);
}

beforeEach(() => { calls = []; });

describe('bundle materialization', () => {
  it('writes an ordinary Compose bundle an operator can run directly', () => {
    const p = paths();
    materializeBundle(p, { MYCO_PORT: '8787' });

    expect(existsSync(p.composeFile)).toBe(true);
    expect(readFileSync(p.composeFile, 'utf8')).toContain('services:');
    expect(readFileSync(p.envFile, 'utf8')).toBe('MYCO_PORT=8787\n');
  });

  it('writes generated secrets 0600 inside a 0700 directory', () => {
    const p = paths();
    materializeBundle(p);

    expect(statSync(p.secretsDir).mode & 0o777).toBe(0o700);
    for (const name of Object.keys(GENERATED_SECRETS)) {
      const file = join(p.secretsDir, name);
      expect(statSync(file).mode & 0o777, `${name} mode`).toBe(0o600);
      expect(readFileSync(file, 'utf8').length).toBeGreaterThan(0);
    }
  });

  it('creates supplied-secret files empty so a bind mount never fails on a missing path', () => {
    const p = paths();
    materializeBundle(p);
    expect(readFileSync(join(p.secretsDir, 'github_client_secret'), 'utf8')).toBe('');
  });

  it('generates the launch token both services mount, 0600 like every other generated secret', () => {
    const p = paths();
    materializeBundle(p);
    const file = join(p.secretsDir, 'harness_token');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8').length).toBeGreaterThan(0);

    // Regenerating it on a second create would leave the two services holding
    // different tokens until both are recreated.
    const before = readFileSync(file, 'utf8');
    materializeBundle(p);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('GATE: re-materializing keeps existing secrets rather than rotating them', () => {
    const p = paths();
    materializeBundle(p);
    const before = readFileSync(join(p.secretsDir, 'session_secret'), 'utf8');

    materializeBundle(p);

    // A create that silently rotates the session secret signs every member out.
    expect(readFileSync(join(p.secretsDir, 'session_secret'), 'utf8')).toBe(before);
  });
});

describe('create', () => {
  it('scopes compose to this stack and waits for health', async () => {
    const p = paths();
    await createDeployment({ paths: p, runner: runner(), port: 9001 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('docker');
    expect(calls[0]!.args).toEqual([
      'compose', '--file', p.composeFile, '--project-name', COMPOSE_PROJECT,
      'up', '--detach', '--wait',
    ]);
  });

  it('carries the port into the env file the bundle reads', async () => {
    const p = paths();
    await createDeployment({ paths: p, runner: runner(), port: 9002 });
    expect(readFileSync(p.envFile, 'utf8')).toContain('MYCO_PORT=9002');
  });

  it('writes a fleet the bundle reads, defaulting when the operator names none', async () => {
    const p = paths();
    await createDeployment({ paths: p, runner: runner() });
    expect(readFileSync(p.envFile, 'utf8')).toContain(`MYCO_FLEET=${DEFAULT_FLEET}`);

    const named = paths();
    await createDeployment({ paths: named, runner: runner(), fleet: 2 });
    expect(readFileSync(named.envFile, 'utf8')).toContain('MYCO_FLEET=2');
  });

  it('refuses a fleet that is not a count of runtimes, before it starts anything', async () => {
    for (const fleet of [0, -1, 2.5]) {
      const p = paths();
      await expect(createDeployment({ paths: p, runner: runner(), fleet })).rejects.toThrow(/whole number of runtimes/);
      expect(calls).toHaveLength(0);
    }
  });

  it('writes an origin only when one is given; the bundle falls back to the loopback publish', async () => {
    const p = paths();
    await createDeployment({ paths: p, runner: runner(), origin: 'https://myco.example.com' });
    expect(readFileSync(p.envFile, 'utf8')).toContain('MYCO_ORIGIN=https://myco.example.com');

    const bare = paths();
    await createDeployment({ paths: bare, runner: runner() });
    expect(readFileSync(bare.envFile, 'utf8')).not.toContain('MYCO_ORIGIN');
  });
});

describe('status', () => {
  it('reports not-provisioned without running anything', async () => {
    const status = await deploymentStatus({ paths: paths(), runner: runner() });
    expect(status.provisioned).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('parses running services from compose ps', async () => {
    const p = paths();
    materializeBundle(p);
    const status = await deploymentStatus({
      paths: p,
      runner: runner({ stdout: '{"Service":"server","State":"running"}\n' }),
    });
    expect(status.running).toBe(true);
    expect(status.services).toEqual(['server']);
  });

  it('survives a line compose ps did not format as JSON', async () => {
    const p = paths();
    materializeBundle(p);
    const status = await deploymentStatus({
      paths: p,
      runner: runner({ stdout: 'warning: something\n{"Service":"server"}\n' }),
    });
    expect(status.services).toEqual(['server']);
  });
});

describe('destroy', () => {
  it('keeps the volume by default — data preservation is the contract', async () => {
    const p = paths();
    materializeBundle(p);
    await destroyDeployment({ paths: p, runner: runner() });

    expect(calls[0]!.args).toEqual([
      'compose', '--file', p.composeFile, '--project-name', COMPOSE_PROJECT,
      'down', '--remove-orphans', '--timeout', String(DESTROY_STOP_TIMEOUT_SECONDS),
    ]);
    expect(calls[0]!.args).not.toContain('--volumes');
  });

  it('names its own stop window rather than waiting out the harness grace', async () => {
    const p = paths();
    materializeBundle(p);
    await destroyDeployment({ paths: p, runner: runner() });

    // Without a window of its own the stack takes the harness's stop grace, and
    // an operator's destroy blocks for the length of a task budget.
    expect(DESTROY_STOP_TIMEOUT_SECONDS).toBeLessThan(HARNESS_STOP_GRACE_SECONDS);
    expect(calls[0]!.args).not.toContain('--live-runs');
  });

  it('removes the volume only when asked', async () => {
    const p = paths();
    materializeBundle(p);
    await destroyDeployment({ paths: p, runner: runner(), removeData: true });
    expect(calls[0]!.args).toContain('--volumes');
  });

  it('is a no-op on a stack that was never provisioned', async () => {
    await destroyDeployment({ paths: paths(), runner: runner() });
    expect(calls).toHaveLength(0);
  });
});
