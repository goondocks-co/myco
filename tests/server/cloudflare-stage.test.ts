/**
 * The staged deploy directory: what one Cloudflare deploy reads, written from
 * artifacts the binary carries rather than from a checkout.
 *
 * The layout is load-bearing twice over. `no_bundle` turns wrangler's
 * `find_additional_modules` on by default, and `base_dir` defaults to the
 * directory holding the entry point — so an entry beside the dashboard and the
 * migrations carries both into the Worker script as modules. The entry sits
 * alone AND the sweep is turned off; either alone would do, and both together
 * mean the failure needs two independent mistakes.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { DEPLOY_CONFIG_NAME, stageCloudflareDeploy, stagingDir, WORKER_ENTRY } from '@myco/server/cloudflare-stage.js';
import type { DeploymentRecord } from '@myco/server/cloudflare.js';

const record = (over: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  accountId: 'a'.repeat(32),
  workerName: 'myco-server',
  databaseName: 'myco-server',
  bucketName: 'myco-server-blobs',
  versionId: null,
  deployedAt: '2026-09-08T00:00:00Z',
  databaseId: '11111111-2222-4333-8444-555555555555',
  ...over,
});

const home = (): string => mkdtempSync(join(tmpdir(), 'myco-cf-stage-'));

describe('the staged deploy directory', () => {
  it('writes the Worker, the dashboard, every migration, and the rendered config', () => {
    const root = home();
    const staged = stageCloudflareDeploy(record(), root);

    expect(staged.dir).toBe(stagingDir(root));
    expect(readFileSync(join(staged.dir, WORKER_ENTRY), 'utf8').length).toBeGreaterThan(0);
    expect(existsSync(join(staged.dir, 'ui', 'dist', 'index.html'))).toBe(true);

    // Enumerated from the schema itself: a step added without a file staged is
    // a Deployment that migrates to a version its code does not carry.
    const expected = renderMigrationFiles();
    expect(staged.migrations).toBe(expected.length);
    expect(readdirSync(join(staged.dir, 'migrations')).sort()).toEqual(expected.map((m) => m.name).sort());
    expect(readFileSync(join(staged.dir, 'migrations', expected[0]!.name), 'utf8')).toBe(expected[0]!.sql);

    expect(readFileSync(join(staged.dir, DEPLOY_CONFIG_NAME), 'utf8')).toContain('database_id = "11111111-2222-4333-8444-555555555555"');
  });

  it('GATE: the entry stands alone, and wrangler is told to bundle nothing and sweep nothing', () => {
    const staged = stageCloudflareDeploy(record(), home());
    const config = readFileSync(join(staged.dir, DEPLOY_CONFIG_NAME), 'utf8');

    expect(config).toContain(`main = "${WORKER_ENTRY.split('\\').join('/')}"`);
    expect(config).toContain('no_bundle = true');
    expect(config).toContain('find_additional_modules = false');
    // Nothing shares the entry's directory, so a lost flag sweeps nothing in.
    expect(readdirSync(join(staged.dir, 'worker'))).toEqual(['worker.js']);
  });

  it('GATE: a re-stage carries nothing over from the version before it', () => {
    const root = home();
    const first = stageCloudflareDeploy(record(), root);
    const stale = join(first.dir, 'ui', 'dist', 'assets', 'from-the-last-version.js');
    mkdirSync(join(first.dir, 'ui', 'dist', 'assets'), { recursive: true });
    writeFileSync(stale, 'export const old = 1;');
    expect(existsSync(stale)).toBe(true);

    // A stale asset is served exactly as confidently as a current one.
    stageCloudflareDeploy(record(), root);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(first.dir, WORKER_ENTRY))).toBe(true);
  });

  it('GATE: refuses a record it cannot address a database with, leaving the last stage standing', () => {
    const root = home();
    const good = stageCloudflareDeploy(record(), root);
    expect(() => stageCloudflareDeploy(record({ databaseId: undefined }), root)).toThrow(/databaseId/);
    // The refusal comes before the directory is touched, so what was there to
    // deploy is still there to deploy.
    expect(existsSync(join(good.dir, WORKER_ENTRY))).toBe(true);
    expect(readFileSync(join(good.dir, DEPLOY_CONFIG_NAME), 'utf8')).toContain('database_id =');
  });
});
