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
  adoptDeployment,
  writeSignInSecrets,
  resolveDeploymentPaths,
  GENERATED_SECRETS,
  COMPOSE_PROJECT,
  DEFAULT_FLEET,
  DESTROY_STOP_TIMEOUT_SECONDS,
  DEFAULT_PORT,
  SERVICE_ABSENT,
  signInConfigured,
  backupDeployment,
  updateDeployment,
  recreateDeployment,
  repairBundle,
} from '@myco/server/deployment.js';
import { COMPOSE_TEMPLATE, HARNESS_STOP_GRACE_SECONDS } from '@myco/server/compose-template.js';
import type { CommandRunner, CommandResult } from '@myco/server/runner.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

let calls: { command: string; args: string[] }[] = [];
/** Compose answers the union of the bundle and the override when asked for its services. */
const SERVICES = 'server\nharness\n';
const runner = (result: Partial<CommandResult> = {}): CommandRunner => ({
  async run(command, args) {
    calls.push({ command, args: [...args] });
    if (args.includes('--services')) return { code: 0, stdout: SERVICES, stderr: '' };
    if (args.includes('--live-runs')) return { code: 0, stdout: '[]', stderr: '' };
    return { code: 0, stdout: '', stderr: '', ...result };
  },
});
/** The reads a verb performs to find out what it is acting on, as against the acts themselves. */
const acts = () => calls.filter((c) => !c.args.includes('--services') && !c.args.includes('ps') && !c.args.includes('--live-runs'));

function paths() {
  const home = mkdtempSync(join(tmpdir(), 'myco-deploy-'));
  roots.push(home);
  return resolveDeploymentPaths(home);
}

/** A directory of its own for a test that writes outside the bundle. */
function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), 'myco-scratch-'));
  roots.push(dir);
  return dir;
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

    expect(acts()).toHaveLength(1);
    expect(acts()[0]!.command).toBe('docker');
    expect(acts()[0]!.args).toEqual([
      'compose', '--file', p.composeFile, '--file', p.overrideFile, '--project-name', COMPOSE_PROJECT,
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

  it('GATE: a second create keeps what the bundle already carries rather than resetting it to the defaults', async () => {
    const p = paths();
    await createDeployment({ paths: p, runner: runner(), port: 9001, fleet: 2 });
    // Sign-in is installed after a create, by a verb of its own.
    writeSignInSecrets(p, { clientId: 'Iv1.x', clientSecret: 's3cr3t' });

    const again = await createDeployment({ paths: p, runner: runner() });

    const env = readFileSync(p.envFile, 'utf8');
    expect(env).toContain('GITHUB_CLIENT_ID=Iv1.x');
    expect(env).toContain('MYCO_FLEET=2');
    expect(env).toContain('MYCO_PORT=9001');
    expect(again.port).toBe(9001);
  });

  it('GATE: adopt leaves the env file byte-identical, writing only the bundle', async () => {
    const p = paths();
    await createDeployment({ paths: p, runner: runner(), port: 9003, fleet: 3, origin: 'https://myco.example.com' });
    writeSignInSecrets(p, { clientId: 'Iv1.y', clientSecret: 's' });
    const before = readFileSync(p.envFile, 'utf8');

    await adoptDeployment({ paths: p, runner: runner() });

    // Adopting is about regaining the ability to operate a stack, and a stack
    // whose port and client id were dropped is a stack that no longer starts.
    expect(readFileSync(p.envFile, 'utf8')).toBe(before);
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

  it('refuses an origin that is not an address, before it starts anything', async () => {
    // The value is handed out as the address members and the scheduled work
    // reach the Deployment at; a scheme-less one reaches nobody.
    for (const origin of ['myco.example.com', 'ws://myco.example.com', '/myco']) {
      const p = paths();
      await expect(createDeployment({ paths: p, runner: runner(), origin })).rejects.toThrow(/http:\/\/ or https:\/\//);
      expect(calls).toHaveLength(0);
    }
  });
});

describe('status', () => {
  it('reports not-provisioned without running anything', async () => {
    const status = await deploymentStatus({ paths: paths(), runner: runner() });
    expect(status.provisioned).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('parses running services from compose ps, over every service the bundle declares', async () => {
    const p = paths();
    materializeBundle(p);
    const status = await deploymentStatus({
      paths: p,
      runner: runner({ stdout: '{"Service":"server","State":"running"}\n{"Service":"harness","State":"running"}\n' }),
    });
    expect(status.running).toBe(true);
    expect(status.services.sort()).toEqual(['harness', 'server']);
    expect(status.states).toEqual([{ service: 'server', state: 'running' }, { service: 'harness', state: 'running' }]);
    // A container that exited is listed only with --all, and a stack whose
    // harness exited serves and runs nothing.
    expect(calls.find((c) => c.args.includes('ps'))!.args).toContain('--all');
  });

  it('GATE: a stack whose harness exited is not running, and names it', async () => {
    const p = paths();
    materializeBundle(p);
    const status = await deploymentStatus({
      paths: p,
      runner: runner({ stdout: '{"Service":"server","State":"running"}\n{"Service":"harness","State":"exited"}\n' }),
    });
    expect(status.running).toBe(false);
    expect(status.services).toEqual(['server']);
    expect(status.states).toEqual([{ service: 'server', state: 'running' }, { service: 'harness', state: 'exited' }]);
  });

  it('names a declared service no container answers for at all', async () => {
    const p = paths();
    materializeBundle(p);
    const status = await deploymentStatus({ paths: p, runner: runner({ stdout: '{"Service":"server","State":"running"}\n' }) });
    expect(status.running).toBe(false);
    expect(status.states.find((s) => s.service === 'harness')).toEqual({ service: 'harness', state: SERVICE_ABSENT });
  });

  it('survives a line compose ps did not format as JSON', async () => {
    const p = paths();
    materializeBundle(p);
    const status = await deploymentStatus({
      paths: p,
      runner: runner({ stdout: 'warning: something\n{"Service":"server","State":"running"}\n{"Service":"harness","State":"running"}\n' }),
    });
    expect(status.services.sort()).toEqual(['harness', 'server']);
  });

  it('reads the single JSON array Compose printed before v2.21 as well as the object-per-line it prints now', async () => {
    const p = paths();
    materializeBundle(p);
    // A reader that knows one shape reports an empty stack on the other, which
    // reads as a Deployment that is not running.
    const asArray = await deploymentStatus({
      paths: p,
      runner: runner({ stdout: '[{"Service":"server","State":"running"},{"Service":"harness","State":"running"}]\n' }),
    });
    expect({ running: asArray.running, services: asArray.services.sort() }).toEqual({ running: true, services: ['harness', 'server'] });

    const asLines = await deploymentStatus({
      paths: p,
      runner: runner({ stdout: '{"Service":"server","State":"running"}\n{"Service":"harness","State":"exited"}\n' }),
    });
    expect({ running: asLines.running, states: asLines.states }).toEqual({
      running: false,
      states: [{ service: 'server', state: 'running' }, { service: 'harness', state: 'exited' }],
    });
  });

  it('GATE: says it could not read the bundle rather than calling it running', async () => {
    const p = paths();
    materializeBundle(p);
    // A bundle Compose refuses is not something to report as running off
    // whatever containers happen to be up.
    const refusing: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        if (args.includes('--services')) return { code: 1, stdout: '', stderr: 'validating compose.override.yaml: services.server Additional property extra_host is not allowed' };
        return { code: 0, stdout: '{"Service":"server","State":"running"}\n', stderr: '' };
      },
    };
    const status = await deploymentStatus({ paths: p, runner: refusing });
    expect({ running: status.running, states: status.states }).toEqual({ running: false, states: [] });
    expect(status.servicesError).toContain('Additional property extra_host is not allowed');
    expect(status.services).toEqual(['server']);
  });
});

describe("the operator's own layer over the bundle", () => {
  it('writes an override file once and never rewrites it', () => {
    const p = paths();
    materializeBundle(p);
    expect(readFileSync(p.overrideFile, 'utf8')).toContain('services:');

    writeFileSync(p.overrideFile, 'services:\n  server:\n    extra_hosts:\n      - "auth.internal:10.0.0.5"\n');
    const mine = readFileSync(p.overrideFile, 'utf8');
    // Every update rewrites compose.yaml from the template; an operator's own
    // layer has to survive that, and this is the only file that does.
    materializeBundle(p);
    materializeBundle(p, { MYCO_PORT: '9001' });
    expect(readFileSync(p.overrideFile, 'utf8')).toBe(mine);
  });

  it('names both files on every command, which is what turns Compose discovery off and this file on', async () => {
    const p = paths();
    await createDeployment({ paths: p, runner: runner() });
    await destroyDeployment({ paths: p, runner: runner() });
    for (const call of calls) {
      expect({ argv: call.args.join(' '), both: call.args.filter((a) => a === '--file').length }).toEqual({ argv: call.args.join(' '), both: 2 });
      expect(call.args).toContain(p.overrideFile);
    }
  });
});

describe('sign-in on a stock bundle', () => {
  it('reports it unconfigured while either half is missing, and configured once both are there', () => {
    const p = paths();
    materializeBundle(p);
    // A bundle without both halves answers every owner route anonymously,
    // dispatch included.
    expect(signInConfigured(p)).toBe(false);

    writeSignInSecrets(p, { clientId: 'Iv1.x', clientSecret: '' });
    expect(signInConfigured(p)).toBe(false);

    writeSignInSecrets(p, { clientId: '', clientSecret: 's3cr3t' });
    expect(signInConfigured(p)).toBe(false);

    writeSignInSecrets(p, { clientId: 'Iv1.x', clientSecret: 's3cr3t' });
    expect(signInConfigured(p)).toBe(true);
  });
});

describe('the defaults the bundle and the process already carry', () => {
  it('GATE: holds the create defaults equal to what the template falls back to', () => {
    // Two spellings of one number: the operator's flag default and the shell
    // default the running container reads.
    expect(COMPOSE_TEMPLATE).toContain(`MYCO_FLEET: \${MYCO_FLEET:-${DEFAULT_FLEET}}`);
    expect(COMPOSE_TEMPLATE).toContain(`MYCO_PORT: \${MYCO_PORT:-${DEFAULT_PORT}}`);
    expect(COMPOSE_TEMPLATE).toContain(`127.0.0.1:\${MYCO_PORT:-${DEFAULT_PORT}}:\${MYCO_PORT:-${DEFAULT_PORT}}`);
  });

  it('refuses a port the bundle names that is not a port, rather than publishing on NaN', async () => {
    const p = paths();
    materializeBundle(p, { MYCO_PORT: 'eight-thousand' });
    await expect(createDeployment({ paths: p, runner: runner() })).rejects.toThrow(/MYCO_PORT=eight-thousand/);
    expect(calls).toHaveLength(0);
  });
});

describe('destroy', () => {
  it('keeps the volume by default — data preservation is the contract', async () => {
    const p = paths();
    materializeBundle(p);
    await destroyDeployment({ paths: p, runner: runner() });

    expect(acts()[0]!.args).toEqual([
      'compose', '--file', p.composeFile, '--file', p.overrideFile, '--project-name', COMPOSE_PROJECT,
      'down', '--remove-orphans', '--timeout', String(DESTROY_STOP_TIMEOUT_SECONDS),
    ]);
    expect(acts()[0]!.args).not.toContain('--volumes');
  });

  it('names its own stop window rather than waiting out the harness grace', async () => {
    const p = paths();
    materializeBundle(p);
    await destroyDeployment({ paths: p, runner: runner() });

    // Without a window of its own the stack takes the harness's stop grace, and
    // an operator's destroy blocks for the length of a task budget.
    expect(DESTROY_STOP_TIMEOUT_SECONDS).toBeLessThan(HARNESS_STOP_GRACE_SECONDS);
    expect(acts()[0]!.args).not.toContain('--live-runs');
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

/**
 * A bundle written before the override file existed.
 *
 * Every verb names both files, and Compose refuses a `--file` naming a path
 * that is not there — so a Deployment provisioned by an earlier version has to
 * be repaired by whichever verb touches it first, not by `create` alone.
 */
describe('an older bundle is repaired by whatever verb reaches it', () => {
  /** A bundle as an earlier version left it: compose.yaml, secrets, .env, and no override. */
  const older = () => {
    const home = mkdtempSync(join(tmpdir(), 'myco-older-'));
    roots.push(home);
    const p = resolveDeploymentPaths(home);
    materializeBundle(p, { MYCO_PORT: '8787' });
    rmSync(p.overrideFile);
    return { home, paths: p };
  };

  it('GATE: resolving paths writes nothing; a read of the Cloudflare record must not touch the Compose bundle', () => {
    const { home, paths: p } = older();
    expect(existsSync(p.overrideFile)).toBe(false);
    resolveDeploymentPaths(home);
    resolveDeploymentPaths(home);
    expect(existsSync(p.overrideFile)).toBe(false);
  });

  it('a changing verb repairs the bundle before its first compose call, and names both files from then on', async () => {
    const { paths: p } = older();
    await recreateDeployment({ paths: p, runner: runner() });

    expect(existsSync(p.overrideFile)).toBe(true);
    for (const call of acts()) expect(call.args.filter((a) => a === '--file')).toHaveLength(2);
    expect(acts()[0]!.args).toContain(p.overrideFile);
  });

  it('GATE: a verb that only reads writes nothing into the bundle', async () => {
    for (const read of [
      (p: ReturnType<typeof paths>) => deploymentStatus({ paths: p, runner: runner() }),
      (p: ReturnType<typeof paths>) => backupDeployment({ paths: p, runner: runner(), destination: join(scratchDir(), 'backup') }),
    ]) {
      const { paths: p } = older();
      await read(p);
      // The argv names the override only while it is there, so a read needs no
      // repair and has no business writing into an operator's bundle.
      expect(existsSync(p.overrideFile)).toBe(false);
    }
  });

  it('leaves an override the operator already wrote exactly as it is', () => {
    const { paths: p } = older();
    writeFileSync(p.overrideFile, 'services:\n  server:\n    extra_hosts: ["a:1.2.3.4"]\n');
    const mine = readFileSync(p.overrideFile, 'utf8');
    repairBundle(p);
    expect(readFileSync(p.overrideFile, 'utf8')).toBe(mine);
  });

  it('carries status, backup, destroy and update through without a Compose file-not-found', async () => {
    for (const verb of [
      (p: ReturnType<typeof resolveDeploymentPaths>) => deploymentStatus({ paths: p, runner: runner() }),
      (p: ReturnType<typeof resolveDeploymentPaths>) => backupDeployment({ paths: p, runner: runner(), destination: join(scratchDir(), 'backup') }),
      (p: ReturnType<typeof resolveDeploymentPaths>) => destroyDeployment({ paths: p, runner: runner() }),
      (p: ReturnType<typeof resolveDeploymentPaths>) => updateDeployment({ paths: p, runner: runner(), report: () => undefined }),
    ]) {
      calls = [];
      const { paths: p } = older();
      await verb(p);
      for (const call of calls) {
        const named = call.args.filter((a) => a.endsWith('.yaml'));
        expect({ argv: call.args.join(' '), missing: named.filter((f) => !existsSync(f)) })
          .toEqual({ argv: call.args.join(' '), missing: [] });
      }
    }
  });
});

/**
 * `create` converges an existing Deployment as well as provisioning a new one,
 * so its `up` is a recreate like any other and takes the harness first.
 */
describe('create on a stack that is already running', () => {
  /** Answers `ps` with the services named as running, and everything else the way the shared runner does. */
  const withRunning = (...running: string[]): CommandRunner => ({
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (args.includes('--services')) return { code: 0, stdout: SERVICES, stderr: '' };
      if (args.includes('ps')) {
        return { code: 0, stdout: ['server', 'harness'].map((s) => JSON.stringify({ Service: s, State: running.includes(s) ? 'running' : 'exited' })).join('\n'), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const verbs = () => calls.filter((c) => !c.args.includes('--services') && !c.args.includes('ps')).map((c) => c.args.slice(7).join(' '));
  /** A Deployment this create converges rather than provisions. */
  const provisioned = () => { const p = paths(); materializeBundle(p); calls = []; return p; };

  it('GATE: stops the harness before it recreates the server', async () => {
    const p = provisioned();
    await createDeployment({ paths: p, runner: withRunning('server', 'harness'), report: () => undefined });
    expect(verbs()).toEqual([`stop --timeout ${HARNESS_STOP_GRACE_SECONDS} harness`, 'up --detach --wait']);
  });

  it('gives a harness whose server is down the short window rather than the whole grace', async () => {
    const p = provisioned();
    const lines: string[] = [];
    await createDeployment({ paths: p, runner: withRunning('harness'), report: (l) => lines.push(l) });
    // A harness with no server to post an ending to has nothing to spend the
    // grace on, and an operator waiting on `create` would spend it with it.
    expect(verbs()).toEqual([`stop --timeout ${DESTROY_STOP_TIMEOUT_SECONDS} harness`, 'up --detach --wait']);
    expect(lines).toContain('Stopping the harness; the server is not running, so the harness has nothing to post to.');
  });

  it('GATE: gives a harness that is not running the short window too, and says so', async () => {
    const p = provisioned();
    const lines: string[] = [];
    await createDeployment({ paths: p, runner: withRunning('server'), report: (l) => lines.push(l) });
    // The whole grace is worth spending only on a harness that is running.
    expect(verbs()).toEqual([`stop --timeout ${DESTROY_STOP_TIMEOUT_SECONDS} harness`, 'up --detach --wait']);
    expect(lines).toContain('Stopping the harness; the harness is not running.');
  });

  it('starts a stack that is not running without stopping anything', async () => {
    const p = provisioned();
    await createDeployment({ paths: p, runner: withRunning(), report: () => undefined });
    expect(verbs()).toEqual(['up --detach --wait']);
  });

  it('GATE: refuses when it cannot see what is running rather than reading that as an empty stack', async () => {
    const p = provisioned();
    const blind: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        if (args.includes('ps')) return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
        return { code: 0, stdout: args.includes('--services') ? SERVICES : '', stderr: '' };
      },
    };
    await expect(createDeployment({ paths: p, runner: blind, report: () => undefined })).rejects.toThrow(/Cannot connect to the Docker daemon/);
    expect(verbs()).toEqual([]);
  });
});

describe('create on a bundle Compose refuses', () => {
  it('GATE: refuses before it rewrites the file the running containers started from', async () => {
    const p = paths();
    materializeBundle(p);
    writeFileSync(p.composeFile, 'services:\n  server:\n    image: from-an-older-cli\n');
    const before = readFileSync(p.composeFile, 'utf8');
    calls = [];
    const refusing: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        if (args.includes('ps')) return { code: 0, stdout: '{"Service":"server","State":"running"}\n', stderr: '' };
        if (args.includes('--services')) return { code: 1, stdout: '', stderr: 'validating compose.override.yaml' };
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    await expect(createDeployment({ paths: p, runner: refusing, report: () => undefined })).rejects.toThrow(/could not be read/);
    expect(readFileSync(p.composeFile, 'utf8')).toBe(before);
  });
});
