/**
 * The Cloudflare lifecycle, asserted by the argv it produces and the record it
 * writes. A fake runner scripts wrangler's answers; nothing here provisions
 * real infrastructure.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCloudflareDeployment,
  rollbackCloudflareDeployment,
  destroyCloudflareDeployment,
  updateCloudflareDeployment,
  DEPLOY_CONFIG_NAME,
  DEFAULT_RUN_TIMEOUT_SECONDS,
  ROLLOUT_START_WINDOW_SECONDS,
  ROLLOUT_WATCH_TIMEOUT_SECONDS,
  RUN_OVERRUN_MARGIN_MS,
} from '@myco/server/cloudflare-lifecycle.js';
import { CONTAINERS_ROLLOUT_NONE, LIVE_RUNS_RETRY_MS, readDeploymentRecord, writeDeploymentRecord, wranglerJson } from '@myco/server/cloudflare.js';
import type { DeploymentRecord } from '@myco/server/cloudflare.js';
import { containersTableHash, renderDeployConfig } from '@myco/server/deploy-config.js';
import { COMPOSE_TEMPLATE, HARNESS_STOP_GRACE_SECONDS } from '@myco/server/compose-template.js';
import { WRANGLER_TEMPLATE } from '@myco/server/wrangler-template.js';
import type { CommandRunner, CommandResult } from '@myco/server/runner.js';
import { DEFAULT_DISPATCH_TIMEOUT_SECONDS as SERVER_DEFAULT_DISPATCH_TIMEOUT_SECONDS, RUN_OVERRUN_MARGIN_MS as SERVER_RUN_OVERRUN_MARGIN_MS } from '@myco-server-worker/core/harness.js';
import { TASK_RUN_TIMEOUT_SECONDS } from '@myco-server-worker/core/task-catalogue.js';

const ACCOUNT = 'a'.repeat(32);
const DB_ID = '11111111-2222-4333-8444-555555555555';
const STORE = 'f'.repeat(32);

let calls: { args: string[]; input?: string }[] = [];

/** Answers each wrangler subcommand the way the real one does; the account's state accumulates across calls like the real one's. */
const buckets = new Set<string>();
const runner = (over: Record<string, Partial<CommandResult>> = {}): CommandRunner => ({
  async run(_command, args, options) {
    calls.push({ args: [...args], input: (options as { input?: string } | undefined)?.input });
    const flat = args.join(' ');
    if (flat.includes('r2 bucket create')) {
      const name = args[args.indexOf('create') + 1]!;
      if (buckets.has(name)) return { code: 1, stdout: '', stderr: `A bucket with the name ${name} already exists` };
      buckets.add(name);
      return { code: 0, stdout: `Created bucket ${name}`, stderr: '' };
    }
    const canned: Record<string, Partial<CommandResult>> = {
      'd1 list --json': { stdout: '[]' },
      'd1 create myco-server': { stdout: `database_id = "${DB_ID}"` },
      'd1 execute': { stdout: '[\n  {\n    "results": [],\n    "success": true\n  }\n]' },
      'secrets-store store list': { stdout: '', code: 0 },
      'secrets-store store create': { stdout: `Created store myco (${STORE})` },
      'containers build': { stdout: `#12 exporting manifest sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee done` },
      'deploy -c wrangler.deploy.toml': { stdout: 'Current Version ID: 16a2423e-af96-4310-b61b-4e2b5fd1310b\n' },
      ...over,
    };
    const match = Object.entries(canned).find(([k]) => flat.includes(k));
    return { code: 0, stdout: '', stderr: '', ...(match?.[1] ?? {}) };
  },
});
beforeEach(() => { calls = []; buckets.clear(); });

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), 'myco-cf-life-'));
  const dir = mkdtempSync(join(tmpdir(), 'myco-cf-cfg-'));
  return { home, dir, options: { accountId: ACCOUNT, configDir: dir, mycoHome: home } };
};

describe('create', () => {
  it('provisions, writes the record before deploying, renders the config, migrates before the deploy, and records the version', async () => {
    const { home, dir, options } = setup();
    const result = await createCloudflareDeployment({ ...options, runner: runner() });

    expect(result.createdResources).toEqual(['d1 myco-server', 'r2 myco-server-blobs', 'secrets store', 'store secret myco-secret-wrap-key', 'worker secret SESSION_SECRET']);
    const record = readDeploymentRecord(home)!;
    expect({ db: record.databaseId, store: record.storeId, version: record.versionId }).toEqual({ db: DB_ID, store: STORE, version: '16a2423e-af96-4310-b61b-4e2b5fd1310b' });

    const rendered = readFileSync(join(dir, DEPLOY_CONFIG_NAME), 'utf8');
    expect(rendered).toContain(`database_id = "${DB_ID}"`);
    expect(rendered).toContain(`store_id = "${STORE}"`);
    const pinnedUri = `registry.cloudflare.com/${ACCOUNT}/myco-server-harnesscontainer@sha256:${'e'.repeat(64)}`;
    expect(record.harnessImage).toBe(pinnedUri);
    expect(rendered).toContain(`image = "${pinnedUri}"`);
    expect(rendered).not.toContain('image = "./harness/Dockerfile"');
    // The settings the instances now carry, for the next deploy to compare against.
    expect(record.containersTable).toBe(containersTableHash(rendered));

    const flat = calls.map((c) => c.args.join(' '));
    const uiAt = flat.findIndex((a) => a.includes('run build:ui'));
    const bundleAt = flat.findIndex((a) => a.includes('run harness:bundle'));
    const pushAt = flat.findIndex((a) => a.includes('containers build'));
    const migrateAt = flat.findIndex((a) => a.includes('migrations apply'));
    const deployAt = flat.findIndex((a) => /(^|\s)deploy(\s|$)/.test(a) && a.includes(DEPLOY_CONFIG_NAME));
    const secretAt = flat.findIndex((a) => a.includes('secret put SESSION_SECRET'));
    expect({ migrateAt: migrateAt >= 0, deployAt: deployAt >= 0, order: migrateAt < deployAt, secretAfterDeploy: secretAt > deployAt, artifactsBeforeDeploy: uiAt >= 0 && bundleAt > uiAt && bundleAt < deployAt, pushBeforeDeploy: pushAt > bundleAt && pushAt < deployAt }).toEqual({ migrateAt: true, deployAt: true, order: true, secretAfterDeploy: true, artifactsBeforeDeploy: true, pushBeforeDeploy: true });
    expect(flat[migrateAt]).toContain(DEPLOY_CONFIG_NAME);
  });

  it('GATE: a deploy failure leaves the record on disk naming what exists', async () => {
    const { home, options } = setup();
    const failing = runner({ 'deploy -c wrangler.deploy.toml': { code: 1, stderr: 'build failed' } });
    await expect(createCloudflareDeployment({ ...options, runner: failing })).rejects.toThrow();
    const record = readDeploymentRecord(home)!;
    expect({ db: record.databaseId, store: record.storeId }).toEqual({ db: DB_ID, store: STORE });
  });

  it('GATE: a push failure leaves the record on disk naming what exists, with no image pinned', async () => {
    const { home, options } = setup();
    const failing = runner({ 'containers build': { code: 1, stderr: 'docker daemon unreachable' } });
    await expect(createCloudflareDeployment({ ...options, runner: failing })).rejects.toThrow();
    const record = readDeploymentRecord(home)!;
    expect({ db: record.databaseId, store: record.storeId, image: record.harnessImage }).toEqual({ db: DB_ID, store: STORE, image: undefined });
  });

  it('GATE: secrets travel on stdin, never argv', async () => {
    const { options } = setup();
    await createCloudflareDeployment({ ...options, runner: runner() });
    const secretCalls = calls.filter((c) => c.args.join(' ').includes('secrets-store secret create') || c.args.join(' ').includes('secret put'));
    expect(secretCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of secretCalls) {
      expect(typeof call.input).toBe('string');
      expect(call.args.join(' ')).not.toContain(call.input!);
    }
  });

  it('is idempotent: an existing record keeps its ids, and a re-run creates no second SESSION_SECRET', async () => {
    const { home, options } = setup();
    await createCloudflareDeployment({ ...options, runner: runner() });
    calls = [];
    const again = await createCloudflareDeployment({ ...options, runner: runner() });
    expect(again.createdResources).toEqual([]);
    expect(readDeploymentRecord(home)!.databaseId).toBe(DB_ID);
    expect(calls.some((c) => c.args.join(' ').includes('d1 create'))).toBe(false);
    expect(calls.some((c) => c.args.join(' ').includes('secret put SESSION_SECRET'))).toBe(false);
    expect(readDeploymentRecord(home)!.harnessImage).toContain('@sha256:');
  });
});

describe('update', () => {
  it('refuses without a record, and with one migrates then deploys through the rendered config', async () => {
    const { home, dir, options } = setup();
    await expect(updateCloudflareDeployment({ ...options, runner: runner() })).rejects.toThrow(/no Cloudflare deployment record/);
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: 'then', databaseId: DB_ID, storeId: STORE }, home);
    const updated = await updateCloudflareDeployment({ ...options, runner: runner() });
    expect(updated.versionId).toBe('16a2423e-af96-4310-b61b-4e2b5fd1310b');
    expect(existsSync(join(dir, DEPLOY_CONFIG_NAME))).toBe(true);
    expect(readDeploymentRecord(home)!.versionId).toBe('16a2423e-af96-4310-b61b-4e2b5fd1310b');
    expect(readDeploymentRecord(home)!.harnessImage).toContain('@sha256:');
  });
});

describe('destroy', () => {
  it('GATE: removes only the Worker and names everything it kept', async () => {
    const { home, options } = setup();
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: 'then', databaseId: DB_ID }, home);
    const destroyed = await destroyCloudflareDeployment({ ...options, runner: runner() });
    expect(destroyed.kept.join(' ')).toMatch(/d1 .* r2 .*secrets store.*record/);
    const flat = calls.map((c) => c.args.join(' '));
    expect(flat.some((a) => a.includes('delete --name myco-server'))).toBe(true);
    expect(flat.some((a) => a.includes('d1 delete') || a.includes('bucket delete'))).toBe(false);
    expect(readDeploymentRecord(home)).not.toBeNull();
  });
});

describe('rollback', () => {
  const VERSION = '99999999-8888-4777-8666-555555555555';

  it('rolls the Worker back to the named version through wrangler and re-stamps the record', async () => {
    const { home, options } = setup();
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: 'old-version', deployedAt: 'then', databaseId: DB_ID }, home);
    const rolled = await rollbackCloudflareDeployment({ ...options, runner: runner(), versionId: VERSION, message: 'smoke failed' });
    expect(rolled.versionId).toBe(VERSION);
    const flat = calls.map((c) => c.args.join(' '));
    expect(flat.some((a) => a.includes(`rollback ${VERSION} --name myco-server -y -m smoke failed`))).toBe(true);
    expect(readDeploymentRecord(home)!.versionId).toBe(VERSION);
  });

  it('defaults to the record version, and refuses when neither the flag nor the record names one', async () => {
    const { home, options } = setup();
    await expect(rollbackCloudflareDeployment({ ...options, runner: runner() })).rejects.toThrow(/no Cloudflare deployment record/);
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: 'then', databaseId: DB_ID }, home);
    await expect(rollbackCloudflareDeployment({ ...options, runner: runner() })).rejects.toThrow(/no version to roll back to/);
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: VERSION, deployedAt: 'then', databaseId: DB_ID }, home);
    const rolled = await rollbackCloudflareDeployment({ ...options, runner: runner() });
    expect(rolled.versionId).toBe(VERSION);
    expect(calls.some((c) => c.args.join(' ').includes('rollback ' + VERSION))).toBe(true);
  });
});

/**
 * What a deploy does around the container instances: it waits for the runs in
 * flight before it pushes, and watches the instances onto the new version
 * after it ships. Both read wrangler through the same fake runner; the clock is
 * driven rather than spent.
 */
describe('update: the runs in flight and the rollout', () => {
  const APP = 'a03d557a-1d5c-4f6d-abd9-9e9d7842bd8a';
  const PUSHED = `registry.cloudflare.com/${ACCOUNT}/myco-server-harnesscontainer@sha256:${'e'.repeat(64)}`;
  const RUNNING_IMAGE = `registry.cloudflare.com/${ACCOUNT}/myco-server-harnesscontainer@sha256:${'a'.repeat(64)}`;

  /** A `d1 execute --json` answer, as wrangler shapes one. */
  const liveRuns = (runs: { id: string; task: string; status?: string; started_at?: number | null; run_context?: string }[]): string =>
    JSON.stringify([{ results: runs.map((run) => ({ status: 'running', started_at: null, ...run })), success: true, meta: { rows_read: runs.length } }]);

  /** A `containers list --json` answer. */
  const applications = (version: number): string =>
    JSON.stringify([{ id: APP, name: 'myco-server-harnesscontainer', state: 'ready', instances: 7, version }]);

  /** A `containers info --json` answer, with the fields the watch reads. */
  const rolloutInfo = (version: number, instances: number, healthy: number, image: string | null = PUSHED): string =>
    JSON.stringify({
      id: APP,
      name: 'myco-server-harnesscontainer',
      version,
      instances,
      max_instances: 12,
      ...(image === null ? {} : { configuration: { image, vcpu: 0.5, memory_mib: 4096 } }),
      health: { errors: [], instances: { active: 0, assigned: 0, healthy, stopped: 0, failed: 0, scheduling: 0, starting: 0 } },
    });

  /** Answers a queue in order and repeats its last answer once the queue is spent. */
  const queue = <T>(answers: readonly T[]) => {
    let at = 0;
    return (): T => answers[Math.min(at++, answers.length - 1)]!;
  };

  /** A scripted answer: stdout alone, or a whole result for a command that failed. */
  const answered = (answer: string | Partial<CommandResult>): CommandResult =>
    typeof answer === 'string' ? { code: 0, stdout: answer, stderr: '' } : { code: 0, stdout: '', stderr: '', ...answer };

  const scripted = (script: { d1?: readonly (string | Partial<CommandResult>)[]; list?: readonly string[]; info?: readonly string[]; fail?: 'list' | 'info' }): CommandRunner => {
    const d1 = queue(script.d1 ?? [liveRuns([])]);
    const list = queue(script.list ?? [applications(31)]);
    const info = queue(script.info ?? [rolloutInfo(31, 7, 7, RUNNING_IMAGE), rolloutInfo(32, 7, 7)]);
    const base = runner();
    return {
      async run(command, args, options) {
        const flat = args.join(' ');
        if (flat.includes('d1 execute')) { calls.push({ args: [...args] }); return answered(d1()); }
        if (flat.includes('containers list')) {
          calls.push({ args: [...args] });
          return script.fail === 'list' ? { code: 1, stdout: '', stderr: 'the account is not authorized to list containers' } : { code: 0, stdout: list(), stderr: '' };
        }
        if (flat.includes('containers info')) {
          calls.push({ args: [...args] });
          return script.fail === 'info' ? { code: 1, stdout: '', stderr: 'no such application' } : { code: 0, stdout: info(), stderr: '' };
        }
        return base.run(command, args, options);
      },
    };
  };

  const NOW = Date.parse('2026-09-04T12:00:00Z');
  /** A clock a test drives: sleeping moves it rather than spending the time. */
  const clock = (start = NOW) => {
    let at = start;
    return { now: () => at, sleep: async (ms: number) => { at += ms; }, get at() { return at; } };
  };

  const seeded = (over: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
    accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs',
    versionId: 'old', deployedAt: 'then', databaseId: DB_ID, storeId: STORE, ...over,
  });

  const seed = (home: string, over: Partial<DeploymentRecord> = {}): void => {
    writeDeploymentRecord(seeded(over), home);
  };

  /** The container settings a deploy of the seeded record computes: what the record carries when nothing about the containers moved. */
  const settledContainers = (): string => containersTableHash(renderDeployConfig(seeded({ harnessImage: PUSHED })));

  const flatCalls = (): string[] => calls.map((c) => c.args.join(' '));

  it('names each running task, polls until none is left, and only then pushes', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    const drive = clock();
    const running = liveRuns([
      { id: 'run_a', task: 'supersession-sweep', started_at: NOW - 120_000, run_context: JSON.stringify({ timeoutSeconds: 300 }) },
      { id: 'run_b', task: 'digest-only', started_at: NOW - 60_000, run_context: JSON.stringify({ timeoutSeconds: 1800 }) },
    ]);
    await updateCloudflareDeployment({
      ...options, runner: scripted({ d1: [running, running, liveRuns([])] }), report: (l) => lines.push(l), clock: drive,
    });

    expect(lines).toContain('Waiting for a running task: supersession-sweep, started 2 min ago, budget 5 min');
    expect(lines).toContain('Waiting for a running task: digest-only, started 60 sec ago, budget 30 min');
    expect(lines).toContain('Nothing is running; the deploy proceeds.');
    // Two polls at fifteen seconds each, and the push waited for both.
    expect(drive.at).toBe(NOW + 30_000);
    const flat = flatCalls();
    const lastRead = flat.map((a, i) => (a.includes('d1 execute') ? i : -1)).filter((i) => i >= 0).at(-1)!;
    expect(lastRead).toBeLessThan(flat.findIndex((a) => a.includes('containers build')));
    expect(flat.filter((a) => a.includes('d1 execute')).length).toBe(3);
  });

  it('counts a dispatched run as in flight before its container has started', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    const drive = clock();
    // A pending row carries no start; its whole budget is still ahead of it, so
    // the bound is counted from now rather than from the epoch.
    const pending = liveRuns([{ id: 'run_p', task: 'digest-only', status: 'pending', started_at: null, run_context: JSON.stringify({ timeoutSeconds: 30 }) }]);
    await updateCloudflareDeployment({ ...options, runner: scripted({ d1: [pending] }), report: (l) => lines.push(l), clock: drive });

    expect(lines).toContain('Waiting for a queued task: digest-only, not started yet, budget 30 sec');
    expect(drive.at).toBe(NOW + 150_000);
    expect(lines.some((l) => l.includes('outlived its own budget') && l.includes('digest-only'))).toBe(true);
  });

  it('reads the running rows through the deploy config, remotely, as JSON, and counts pending as live', async () => {
    const { home, options } = setup();
    seed(home);
    await updateCloudflareDeployment({ ...options, runner: scripted({}), report: () => undefined, clock: clock() });
    const read = calls.map((c) => c.args).find((a) => a.join(' ').includes('d1 execute'))!;
    expect(read.slice(0, 6)).toEqual(['wrangler', 'd1', 'execute', 'myco-server', '--remote', '--json']);
    // The server counts both states as live (core/runs.ts, LIVE_RUNS_SQL); so does the deploy.
    expect(read).toContain("SELECT id, task, status, started_at, run_context FROM agent_runs WHERE status IN ('pending', 'running')");
    expect(read.join(' ')).toContain(`-c ${DEPLOY_CONFIG_NAME}`);
  });

  it('GATE: refuses to deploy when it cannot read what is running, and never pushes', async () => {
    const { home, options } = setup();
    seed(home);
    // An answer that carries no document is not an empty Deployment.
    const unreadable = 'npm notice run npx\nwrangler exited before it printed anything';
    await expect(updateCloudflareDeployment({
      ...options, runner: scripted({ d1: [unreadable] }), report: () => undefined, clock: clock(),
    })).rejects.toThrow(/could not be read; pass --no-drain/);
    expect(flatCalls().some((a) => a.includes('containers build'))).toBe(false);
  });

  it('asks again after a pause when the first answer comes back unreadable, and ships on the second', async () => {
    const { home, options } = setup();
    seed(home);
    const drive = clock();
    const unreadable = 'npm notice run npx\nwrangler exited before it printed anything';
    await updateCloudflareDeployment({
      ...options, runner: scripted({ d1: [unreadable, liveRuns([])] }), report: () => undefined, clock: drive,
    });
    expect(flatCalls().filter((a) => a.includes('d1 execute')).length).toBe(2);
    expect(drive.at).toBe(NOW + LIVE_RUNS_RETRY_MS);
    expect(flatCalls().some((a) => a.includes('containers build'))).toBe(true);
  });

  it('GATE: a second bad answer refuses the deploy, naming the error the command printed', async () => {
    const { home, options } = setup();
    seed(home);
    // The database API answers a passing internal error exactly like a real
    // one: a JSON document on stdout, a configuration warning on stderr.
    const apiError = {
      code: 1,
      stdout: JSON.stringify({
        error: {
          text: 'A request to the Cloudflare API (/accounts/a/d1/database/b/query) failed.',
          notes: [{ text: 'internal error; reference = 7f3c1d2e [code: 7500]' }],
          kind: 'error', name: 'APIError', code: 7400,
        },
      }),
      stderr: '\u001b[33m\u25b2 \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m Processing wrangler.deploy.toml configuration:\n\n    - Unexpected fields found\n',
    };
    const drive = clock();
    await expect(updateCloudflareDeployment({
      ...options, runner: scripted({ d1: [apiError] }), report: () => undefined, clock: drive,
    })).rejects.toThrow(/could not be read; pass --no-drain/);

    let raised = '';
    try {
      await updateCloudflareDeployment({ ...options, runner: scripted({ d1: [apiError] }), report: () => undefined, clock: clock() });
    } catch (err) { raised = (err as Error).message; }
    expect(raised).toContain('A request to the Cloudflare API');
    expect(raised).toContain('internal error; reference = 7f3c1d2e');
    expect(raised).not.toContain('Unexpected fields found');
    expect(drive.at).toBe(NOW + LIVE_RUNS_RETRY_MS);
    expect(flatCalls().some((a) => a.includes('containers build'))).toBe(false);
  });

  it('names only the runs whose own bound passed, and names a run dispatched mid-wait separately', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    const drive = clock();
    const overdue = { id: 'run_o', task: 'cortex-instructions', started_at: NOW - 200_000, run_context: JSON.stringify({ timeoutSeconds: 100 }) };
    const fresh = { id: 'run_f', task: 'titling', started_at: NOW, run_context: JSON.stringify({ timeoutSeconds: 300 }) };
    await updateCloudflareDeployment({
      ...options,
      runner: scripted({ d1: [liveRuns([overdue]), liveRuns([overdue, fresh]), liveRuns([overdue, fresh])] }),
      report: (l) => lines.push(l), clock: drive,
    });

    expect(lines).toContain('A task outlived its own budget (cortex-instructions); the deploy proceeds and the stale sweep owns the run.');
    expect(lines).toContain('titling started during the deploy; the platform drains what is running.');
    expect(drive.at).toBe(NOW + 30_000);
  });

  it('gives a run whose context names no budget the dispatcher default', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    const running = liveRuns([{ id: 'run_d', task: 'titling', started_at: NOW - 30_000 }]);
    await updateCloudflareDeployment({
      ...options, runner: scripted({ d1: [running, liveRuns([])] }), report: (l) => lines.push(l), clock: clock(),
    });
    expect(lines).toContain(`Waiting for a running task: titling, started 30 sec ago, budget ${DEFAULT_RUN_TIMEOUT_SECONDS / 60} min`);
  });

  it('--no-drain says what it is shipping over, reads once, and waits never', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    const drive = clock();
    await updateCloudflareDeployment({
      ...options, drain: false,
      runner: scripted({ d1: [liveRuns([{ id: 'run_e', task: 'digest-only', started_at: NOW - 60_000, run_context: JSON.stringify({ timeoutSeconds: 1800 }) }])] }),
      report: (l) => lines.push(l), clock: drive,
    });
    expect(lines).toContain('Shipping over a running task: digest-only, started 60 sec ago, budget 30 min');
    expect(lines).toContain('Not waiting for the runs in flight: the platform drains what is running.');
    expect(flatCalls().filter((a) => a.includes('d1 execute')).length).toBe(1);
    expect(drive.at).toBe(NOW);
  });

  it('--no-drain still ships when the runs cannot be read, saying so', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    await updateCloudflareDeployment({
      ...options, drain: false, runner: scripted({ d1: ['wrangler printed nothing readable'] }),
      report: (l) => lines.push(l), clock: clock(),
    });
    expect(lines.some((l) => l.startsWith('What is running could not be read'))).toBe(true);
    expect(flatCalls().some((a) => a.includes('containers build'))).toBe(true);
  });

  it('watches the instances onto the new version, reports progress, and records the rollout', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    const drive = clock();
    await updateCloudflareDeployment({
      ...options,
      runner: scripted({
        list: [applications(31)],
        info: [rolloutInfo(31, 7, 7, RUNNING_IMAGE), rolloutInfo(32, 7, 4), rolloutInfo(32, 7, 4), rolloutInfo(32, 7, 7)],
      }),
      report: (l) => lines.push(l), clock: drive,
    });

    expect(lines).toContain('Rolling out: 4 of 7 instances on the new version');
    // The line is printed when it changes, not once per poll.
    expect(lines.filter((l) => l.startsWith('Rolling out')).length).toBe(1);
    expect(lines.at(-1)).toBe('Rollout complete.');
    expect(readDeploymentRecord(home)!.lastRollout).toEqual({ version: 32, completedAt: new Date(NOW + 40_000).toISOString() });
    const info = calls.map((c) => c.args).filter((a) => a.join(' ').includes('containers info'));
    // Every containers read carries the deploy config, like every other wrangler call here.
    expect(info[0]).toEqual(['wrangler', 'containers', 'info', APP, '--json', '-c', DEPLOY_CONFIG_NAME]);
    const list = calls.map((c) => c.args).find((a) => a.join(' ').includes('containers list'))!;
    expect(list).toEqual(['wrangler', 'containers', 'list', '--json', '-c', DEPLOY_CONFIG_NAME]);
    // The version standing before the deploy is read before the deploy runs.
    const flat = flatCalls();
    expect(flat.findIndex((a) => a.includes('containers info'))).toBeLessThan(flat.findIndex((a) => /(^|\s)deploy(\s|$)/.test(a)));
  });

  it('GATE: a full instance count under the image already running is not the end of the rollout', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    const drive = clock();
    // The fleet standing untouched answers a full healthy count too; only the
    // application describing the pushed bytes tells the two apart.
    await updateCloudflareDeployment({
      ...options,
      runner: scripted({ info: [rolloutInfo(31, 7, 7, RUNNING_IMAGE), rolloutInfo(32, 7, 7, RUNNING_IMAGE), rolloutInfo(32, 7, 7, PUSHED)] }),
      report: (l) => lines.push(l), clock: drive,
    });
    expect(lines.at(-1)).toBe('Rollout complete.');
    expect(drive.at).toBe(NOW + 20_000);
    expect(readDeploymentRecord(home)!.lastRollout!.completedAt).toBe(new Date(NOW + 20_000).toISOString());
  });

  it('an answer naming no image is believed only once the fleet has been seen mid-replacement', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    const drive = clock();
    await updateCloudflareDeployment({
      ...options,
      runner: scripted({ info: [rolloutInfo(31, 7, 7, null), rolloutInfo(32, 7, 7, null), rolloutInfo(32, 7, 3, null), rolloutInfo(32, 7, 7, null)] }),
      report: (l) => lines.push(l), clock: drive,
    });
    expect(lines).toContain('Rolling out: 3 of 7 instances on the new version');
    expect(lines.at(-1)).toBe('Rollout complete.');
    expect(drive.at).toBe(NOW + 40_000);
  });

  it('names a rollout still in progress when the watch runs out of time, and records none', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    const drive = clock();
    await updateCloudflareDeployment({
      ...options, runner: scripted({ info: [rolloutInfo(31, 7, 7, RUNNING_IMAGE), rolloutInfo(32, 7, 2)] }),
      report: (l) => lines.push(l), clock: drive,
    });
    expect(lines.at(-1)).toBe('The rollout is still in progress; a run started now may land on an instance still on the old version.');
    expect(readDeploymentRecord(home)!.lastRollout).toBeUndefined();
    expect(drive.at).toBe(NOW + ROLLOUT_WATCH_TIMEOUT_SECONDS * 1000);
  });

  /** The application answering the version it already carried, poll after poll. */
  const standing = (polls: number): string[] => Array.from({ length: polls }, () => rolloutInfo(31, 7, 7, RUNNING_IMAGE));

  it('GATE: ends the watch inside the start window when the platform starts no rollout, and still records the settings it shipped', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    const drive = clock();
    // A container table that names the same resources by another spelling
    // rolls nothing: the application keeps its version and its image.
    await updateCloudflareDeployment({
      ...options, runner: scripted({ info: [rolloutInfo(31, 7, 7, RUNNING_IMAGE)] }),
      report: (l) => lines.push(l), clock: drive,
    });

    expect(lines.at(-1)).toBe('The platform started no rollout for this deploy: the container settings in force already match.');
    expect(lines.some((l) => l.includes('still in progress'))).toBe(false);
    expect(drive.at).toBe(NOW + ROLLOUT_START_WINDOW_SECONDS * 1000);
    // The next deploy must not decide to roll again for the same settings.
    expect(readDeploymentRecord(home)!.containersTable).toBe(settledContainers());
    expect(readDeploymentRecord(home)!.lastRollout).toBeUndefined();
    // The cadence is said once, so a silent three minutes reads as intended.
    expect(lines.filter((l) => l === 'Watching the rollout; the platform reports the instances every 20 s.').length).toBe(1);
  });

  it('watches a rollout that starts inside the window through to completion', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    const drive = clock();
    // The version stands for three polls and advances at 60 s.
    await updateCloudflareDeployment({
      ...options,
      runner: scripted({ info: [...standing(4), rolloutInfo(32, 7, 4), rolloutInfo(32, 7, 7)] }),
      report: (l) => lines.push(l), clock: drive,
    });

    expect(lines).toContain('Rolling out: 4 of 7 instances on the new version');
    expect(lines.at(-1)).toBe('Rollout complete.');
    expect(drive.at).toBe(NOW + 80_000);
    expect(readDeploymentRecord(home)!.lastRollout!.version).toBe(32);
  });

  it('GATE: a version that advances only at the edge of the start window is still watched to completion', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    const drive = clock();
    // Nine polls answer the standing version; the poll at the window's edge
    // reads the new one, and that is a rollout, not the absence of one.
    await updateCloudflareDeployment({
      ...options,
      runner: scripted({ info: [...standing(10), rolloutInfo(32, 7, 7)] }),
      report: (l) => lines.push(l), clock: drive,
    });

    expect(lines.some((l) => l.includes('started no rollout'))).toBe(false);
    expect(lines.at(-1)).toBe('Rollout complete.');
    expect(drive.at).toBe(NOW + ROLLOUT_START_WINDOW_SECONDS * 1000);
    expect(readDeploymentRecord(home)!.lastRollout!.version).toBe(32);
  });

  it('surfaces what wrangler said when the container application cannot be read, and claims no absent application', async () => {
    const { home, options } = setup();
    seed(home);
    const lines: string[] = [];
    await updateCloudflareDeployment({ ...options, runner: scripted({ fail: 'list' }), report: (l) => lines.push(l), clock: clock() });

    expect(lines.some((l) => l.includes('could not be read') && l.includes('not authorized to list containers'))).toBe(true);
    expect(lines.some((l) => l.includes('No container application answers yet'))).toBe(false);
    // The deploy itself still happened and was recorded.
    expect(readDeploymentRecord(home)!.versionId).toBe('16a2423e-af96-4310-b61b-4e2b5fd1310b');
    expect(readDeploymentRecord(home)!.lastRollout).toBeUndefined();
  });

  it('watches nothing when the deploy ships the image already running under the container settings already in force', async () => {
    const { home, options } = setup();
    seed(home, { harnessImage: PUSHED, containersTable: settledContainers() });
    const lines: string[] = [];
    await updateCloudflareDeployment({ ...options, runner: scripted({}), report: (l) => lines.push(l), clock: clock() });
    expect(lines).toContain('No container rollout (image and container settings unchanged).');
    expect(flatCalls().some((a) => a.includes(CONTAINERS_ROLLOUT_NONE))).toBe(true);
    expect(calls.some((c) => c.args.join(' ').includes('containers info'))).toBe(false);
    expect(readDeploymentRecord(home)!.lastRollout).toBeUndefined();
  });

  it('GATE: rolls the container when its settings changed under the image already running, and watches the instances onto them', async () => {
    const { home, options } = setup();
    // The platform replaces the instances when the [[containers]] table
    // changes; a deploy that asks for no rollout leaves them on the old settings.
    seed(home, { harnessImage: PUSHED, containersTable: 'the settings that stood before the table was edited' });
    const lines: string[] = [];
    await updateCloudflareDeployment({ ...options, runner: scripted({}), report: (l) => lines.push(l), clock: clock() });
    expect(flatCalls().some((a) => a.includes(CONTAINERS_ROLLOUT_NONE))).toBe(false);
    expect(lines.at(-1)).toBe('Rollout complete.');
    expect(readDeploymentRecord(home)!.lastRollout!.version).toBe(32);
  });

  it('rolls when the record names no container settings at all', async () => {
    const { home, options } = setup();
    // A record written before a deploy ever recorded the settings has nothing
    // to compare against, and is not evidence that the instances are current.
    seed(home, { harnessImage: PUSHED });
    const lines: string[] = [];
    await updateCloudflareDeployment({ ...options, runner: scripted({}), report: (l) => lines.push(l), clock: clock() });
    expect(flatCalls().some((a) => a.includes(CONTAINERS_ROLLOUT_NONE))).toBe(false);
    expect(lines.at(-1)).toBe('Rollout complete.');
  });

  it('records the container settings it shipped, so the next deploy has them to compare against', async () => {
    const { home, options } = setup();
    seed(home);
    await updateCloudflareDeployment({ ...options, runner: scripted({}), report: () => undefined, clock: clock() });
    expect(readDeploymentRecord(home)!.containersTable).toBe(settledContainers());
  });

  it('reads both wrangler answers past whatever npm and wrangler printed around them', () => {
    const preamble = [
      'npm notice run @goondocks/myco-monorepo@0.0.0-dev npx',
      "npm notice run 'wrangler' d1 execute myco-server --remote --json",
      '\u001b[33m\u25b2 \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m Processing wrangler.toml configuration:',
      // A warning whose colour codes were stripped opens with a bracket of its own.
      '[WARNING] the "standard" instance_type has been renamed',
      '',
    ].join('\n');
    const trailer = '\n\n🪵  Logs were written to "/tmp/wrangler.log"';
    const runs = wranglerJson<{ results: { id: string }[] }[]>(`${preamble}\n${liveRuns([{ id: 'run_g', task: 'titling', started_at: NOW }])}${trailer}`);
    expect(runs![0]!.results[0]!.id).toBe('run_g');
    const info = wranglerJson<{ version: number; health: { instances: { healthy: number } } }>(`${preamble}\n${rolloutInfo(32, 7, 5)}${trailer}`);
    expect({ version: info!.version, healthy: info!.health.instances.healthy }).toEqual({ version: 32, healthy: 5 });
    // A bracket inside a string is text, not the end of the document.
    expect(wranglerJson<{ name: string }>('{"name": "a ] b } c"}\ntrailing noise')).toEqual({ name: 'a ] b } c' });
    expect(wranglerJson('npm notice run npx\nnothing readable here')).toBeNull();
  });

  it('GATE: the budgets the wait and the watch mirror are the ones the Deployment enforces', () => {
    expect(RUN_OVERRUN_MARGIN_MS).toBe(SERVER_RUN_OVERRUN_MARGIN_MS);
    expect(DEFAULT_RUN_TIMEOUT_SECONDS).toBe(SERVER_DEFAULT_DISPATCH_TIMEOUT_SECONDS);
    expect(ROLLOUT_WATCH_TIMEOUT_SECONDS).toBe(Math.max(...Object.values(TASK_RUN_TIMEOUT_SECONDS)));
  });

  it('GATE: both targets spare a run for the same window, and the Compose bundle renders it', () => {
    // The two targets spare a run in flight by different mechanisms — the
    // platform's rollout grace there, the harness's stop grace here — and a
    // window shorter than the longest task budget kills a run inside its bound
    // on whichever target drifted.
    const longest = Math.max(...Object.values(TASK_RUN_TIMEOUT_SECONDS));
    const wrangler = Number(/^rollout_active_grace_period = (\d+)$/m.exec(WRANGLER_TEMPLATE)?.[1]);
    expect(HARNESS_STOP_GRACE_SECONDS).toBe(ROLLOUT_WATCH_TIMEOUT_SECONDS);
    expect(HARNESS_STOP_GRACE_SECONDS).toBe(longest);
    expect(HARNESS_STOP_GRACE_SECONDS).toBe(wrangler);
    // The rendered bundle carries the number, not just the constant. The
    // harness is the last service, so its block runs to the end of the file.
    const harness = COMPOSE_TEMPLATE.slice(COMPOSE_TEMPLATE.indexOf('\n  harness:'));
    expect(harness).toContain(`stop_grace_period: ${HARNESS_STOP_GRACE_SECONDS}s`);
  });
});
