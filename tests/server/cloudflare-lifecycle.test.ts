/**
 * The Cloudflare lifecycle, asserted by the argv it produces and the record it
 * writes. A fake runner scripts wrangler's answers; nothing here provisions
 * real infrastructure.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCloudflareDeployment,
  rollbackCloudflareDeployment,
  destroyCloudflareDeployment,
  updateCloudflareDeployment,
  DEPLOY_CONFIG_NAME,
} from '@myco/server/cloudflare-lifecycle.js';
import { stagingDir, stagingRoot, WORKER_ENTRY } from '@myco/server/cloudflare-stage.js';
import { readDeploymentRecord, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import type { CommandRunner, CommandResult } from '@myco/server/runner.js';

const ACCOUNT = 'a'.repeat(32);
const DB_ID = '11111111-2222-4333-8444-555555555555';
const STORE = 'f'.repeat(32);

let calls: { args: string[]; input?: string; cwd?: string }[] = [];

/** Answers each wrangler subcommand the way the real one does; the account's state accumulates across calls like the real one's. */
const buckets = new Set<string>();
const runner = (over: Record<string, Partial<CommandResult>> = {}): CommandRunner => ({
  async run(_command, args, options) {
    const opts = options as { input?: string; cwd?: string } | undefined;
    calls.push({ args: [...args], input: opts?.input, cwd: opts?.cwd });
    const flat = args.join(' ');
    if (flat.includes('r2 bucket create')) {
      const name = args[args.indexOf('create') + 1]!;
      if (buckets.has(name)) return { code: 1, stdout: '', stderr: `A bucket with the name ${name} already exists` };
      buckets.add(name);
      return { code: 0, stdout: `Created bucket ${name}`, stderr: '' };
    }
    const canned: Record<string, Partial<CommandResult>> = {
      'vectorize list --json': { stdout: '[{"name":"myco-server-memory"}]' },
      'vectorize get myco-server-memory --json': { stdout: '{"config":{"dimensions":1536,"metric":"cosine"}}' },
      'vectorize list-metadata-index': { stdout: '[{"propertyName":"type","indexType":"String"},{"propertyName":"status","indexType":"String"},{"propertyName":"session_id","indexType":"String"},{"propertyName":"created_at","indexType":"Number"},{"propertyName":"observation_type","indexType":"String"},{"propertyName":"release_state","indexType":"String"},{"propertyName":"release_confidence","indexType":"String"}]' },
      'd1 list --json': { stdout: '[]' },
      'd1 create myco-server': { stdout: `database_id = "${DB_ID}"` },
      'd1 execute': { stdout: '[\n  {\n    "results": [],\n    "success": true\n  }\n]' },
      'secrets-store store list': { stdout: '', code: 0 },
      'secrets-store store create': { stdout: `Created store myco (${STORE})` },
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
  return { home, dir: stagingDir(home), options: { accountId: ACCOUNT, mycoHome: home } };
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

    // Everything a deploy reads is staged from what the binary carries: no
    // checkout is consulted and nothing is built on the operator's machine.
    expect(existsSync(join(dir, WORKER_ENTRY))).toBe(true);
    expect(existsSync(join(dir, 'ui', 'dist', 'index.html'))).toBe(true);
    expect(readdirSync(join(dir, 'migrations')).length).toBe(renderMigrationFiles().length);

    const flat = calls.map((c) => c.args.join(' '));
    const migrateAt = flat.findIndex((a) => a.includes('migrations apply'));
    const deployAt = flat.findIndex((a) => /(^|\s)deploy(\s|$)/.test(a) && a.includes(DEPLOY_CONFIG_NAME));
    const secretAt = flat.findIndex((a) => a.includes('secret put SESSION_SECRET'));
    expect({ migrateAt: migrateAt >= 0, deployAt: deployAt >= 0, order: migrateAt < deployAt, secretAfterDeploy: secretAt > deployAt }).toEqual({ migrateAt: true, deployAt: true, order: true, secretAfterDeploy: true });
    expect(flat[migrateAt]).toContain(DEPLOY_CONFIG_NAME);

    // The absence the issue asks for: nothing on this machine builds, and no
    // command reaches a container runtime or a checkout.
    for (const forbidden of ['containers build', 'run build:ui', 'run harness:bundle', 'docker']) {
      expect({ forbidden, ran: flat.some((a) => a.includes(forbidden)) }).toEqual({ forbidden, ran: false });
    }
  });

  it('GATE: a deploy failure leaves the record on disk naming what exists', async () => {
    const { home, options } = setup();
    const failing = runner({ 'deploy -c wrangler.deploy.toml': { code: 1, stderr: 'build failed' } });
    await expect(createCloudflareDeployment({ ...options, runner: failing })).rejects.toThrow();
    const record = readDeploymentRecord(home)!;
    expect({ db: record.databaseId, store: record.storeId }).toEqual({ db: DB_ID, store: STORE });
  });

  it('GATE: every command runs in a directory this binary owns, never the one the operator stands in', async () => {
    // Wrangler walks UP from its working directory looking for a config, so a
    // command run from wherever the operator happens to be can pick up a
    // checkout's wrangler.toml — the second config source staging removes.
    const { home, dir, options } = setup();
    await createCloudflareDeployment({ ...options, runner: runner() });
    const root = stagingRoot(home);
    expect(calls.length).toBeGreaterThan(0);
    // Read off what each command was actually handed, not off intent: the two
    // directories this binary owns, and nothing else.
    const owned = [dir, root];
    for (const call of calls) {
      expect({ args: call.args.join(' '), owned: owned.includes(call.cwd ?? '') }).toEqual({ args: call.args.join(' '), owned: true });
    }
    expect(calls.some((c) => c.cwd === process.cwd())).toBe(false);
    // Every command reading a config reads the staged one.
    for (const call of calls.filter((c) => c.args.includes('-c'))) {
      expect({ args: call.args.join(' '), cwd: call.cwd }).toEqual({ args: call.args.join(' '), cwd: dir });
    }
  });

  it('puts the Deployment on the domain the operator named, in the record and in the config it deploys', async () => {
    const { home, dir, options } = setup();
    await createCloudflareDeployment({ ...options, runner: runner(), url: 'https://myco.example.com' });
    expect(readDeploymentRecord(home)!.url).toBe('https://myco.example.com');
    const rendered = readFileSync(join(dir, DEPLOY_CONFIG_NAME), 'utf8');
    expect(rendered).toContain('routes = [ { pattern = "myco.example.com", custom_domain = true } ]');
    expect(rendered).toContain('MYCO_ORIGIN = "https://myco.example.com"');
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
  });
});

describe('destroy', () => {
  it('GATE: removes only the Worker and names everything it kept', async () => {
    const { home, options } = setup();
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs', versionId: null, deployedAt: 'then', databaseId: DB_ID }, home);
    const destroyed = await destroyCloudflareDeployment({ ...options, runner: runner() });
    expect(destroyed.kept.join(' ')).toMatch(/d1 .* r2 .*secrets store.*record/);
    expect(destroyed.kept).toContain('vectorize myco-server-memory');
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
 * The two flags that no longer apply to this target. A flag silently ignored is
 * a flag an operator believes did something; both are refused by name and the
 * verb is driven to prove it, rather than the help text being read back.
 */
describe('the flags this target refuses by name', () => {
  const drive = async (argv: string[]): Promise<{ exited: boolean; said: string }> => {
    const said: string[] = [];
    const error = console.error;
    const exit = process.exit;
    console.error = (line: unknown) => { said.push(String(line)); };
    process.exit = ((code?: number) => { throw new Error(`exit ${code ?? 0}`); }) as typeof process.exit;
    try {
      const { run } = await import('@myco/cli/server.js');
      await run(argv);
      return { exited: false, said: said.join('\n') };
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('exit ')) throw err;
      return { exited: true, said: said.join('\n') };
    } finally {
      console.error = error;
      process.exit = exit;
    }
  };

  it('refuses --dir, naming what carries the deploy instead', async () => {
    const refused = await drive(['create', '--target', 'cloudflare', '--account-id', ACCOUNT, '--dir', '/some/checkout']);
    expect({ exited: refused.exited, names: /--dir is not a flag for this target/.test(refused.said) }).toEqual({ exited: true, names: true });
    expect(refused.said).toContain('travel in this binary');
  });

  it('refuses --no-drain, naming why there is nothing to drain', async () => {
    const refused = await drive(['update', '--target', 'cloudflare', '--account-id', ACCOUNT, '--no-drain']);
    expect({ exited: refused.exited, names: /--no-drain is not a flag for this target/.test(refused.said) }).toEqual({ exited: true, names: true });
    expect(refused.said).toContain('waits for nothing');
  });
});
