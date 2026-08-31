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
  destroyCloudflareDeployment,
  updateCloudflareDeployment,
  DEPLOY_CONFIG_NAME,
} from '@myco/server/cloudflare-lifecycle.js';
import { readDeploymentRecord, writeDeploymentRecord } from '@myco/server/cloudflare.js';
import type { CommandRunner, CommandResult } from '@myco/server/runner.js';

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

    const flat = calls.map((c) => c.args.join(' '));
    const uiAt = flat.findIndex((a) => a.includes('run build:ui'));
    const bundleAt = flat.findIndex((a) => a.includes('run harness:bundle'));
    const migrateAt = flat.findIndex((a) => a.includes('migrations apply'));
    const deployAt = flat.findIndex((a) => /(^|\s)deploy(\s|$)/.test(a) && a.includes(DEPLOY_CONFIG_NAME));
    const secretAt = flat.findIndex((a) => a.includes('secret put SESSION_SECRET'));
    expect({ migrateAt: migrateAt >= 0, deployAt: deployAt >= 0, order: migrateAt < deployAt, secretAfterDeploy: secretAt > deployAt, artifactsBeforeDeploy: uiAt >= 0 && bundleAt > uiAt && bundleAt < deployAt }).toEqual({ migrateAt: true, deployAt: true, order: true, secretAfterDeploy: true, artifactsBeforeDeploy: true });
    expect(flat[migrateAt]).toContain(DEPLOY_CONFIG_NAME);
  });

  it('GATE: a deploy failure leaves the record on disk naming what exists', async () => {
    const { home, options } = setup();
    const failing = runner({ 'deploy -c wrangler.deploy.toml': { code: 1, stderr: 'build failed' } });
    await expect(createCloudflareDeployment({ ...options, runner: failing })).rejects.toThrow();
    const record = readDeploymentRecord(home)!;
    expect({ db: record.databaseId, store: record.storeId }).toEqual({ db: DB_ID, store: STORE });
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
    const flat = calls.map((c) => c.args.join(' '));
    expect(flat.some((a) => a.includes('delete --name myco-server'))).toBe(true);
    expect(flat.some((a) => a.includes('d1 delete') || a.includes('bucket delete'))).toBe(false);
    expect(readDeploymentRecord(home)).not.toBeNull();
  });
});
