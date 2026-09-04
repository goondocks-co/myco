/**
 * Cloudflare Deployment operations, asserted by the argv they produce.
 *
 * The account hazard is not hypothetical. Running the #908 prototype against a
 * login that reaches two accounts, `wrangler containers list` refused outright
 * in non-interactive mode — and the vault records an earlier occasion where a
 * multi-account wrangler PARTIALLY provisioned before failing, leaving some
 * resources created and no record of which. A refused command is recoverable;
 * a half-provisioned account is not.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountNotSelected,
  backupCloudflare,
  CONTAINERS_ROLLOUT_NONE,
  cloudflareStatus,
  deployWorker,
  applyMigrations,
  listAccounts,
  readDeploymentRecord,
  writeDeploymentRecord,
} from '@myco/server/cloudflare.js';
import type { CommandRunner, CommandResult } from '@myco/server/runner.js';

let calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
const runner = (result: Partial<CommandResult> = {}): CommandRunner => ({
  async run(command, args, options) {
    calls.push({ command, args: [...args], env: options?.env });
    return { code: 0, stdout: '', stderr: '', ...result };
  },
});
beforeEach(() => { calls = []; });

const ACCOUNT = 'b134c2135129c4800082e677fbffb286';
const base = () => ({ accountId: ACCOUNT, configDir: '/tmp/cfg' });

describe('account selection', () => {
  it('GATE: refuses to run with no account named', async () => {
    // Wrangler picks nothing when several accounts are reachable; this refuses
    // before a command can create anything in the wrong one.
    await expect(deployWorker({ accountId: '', configDir: '/tmp/cfg', runner: runner() }))
      .rejects.toThrow(AccountNotSelected);
  });

  it('pins the account on every invocation rather than exporting it once', async () => {
    await deployWorker({ ...base(), runner: runner() });
    for (const call of calls) {
      expect(call.env?.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
    }
  });

  it('lists the accounts a login can reach, so a caller can choose', async () => {
    const whoami = [
      '┌───────────────────────────┬──────────────────────────────────┐',
      '│ Chris Kirby               │ b134c2135129c4800082e677fbffb286 │',
      '│ Collagen Advocacy Network │ 1f776044f26a8bbc73dc418bfafd4e0f │',
      '└───────────────────────────┴──────────────────────────────────┘',
    ].join('\n');

    expect(await listAccounts(runner({ stdout: whoami }))).toEqual([
      { name: 'Chris Kirby', id: 'b134c2135129c4800082e677fbffb286' },
      { name: 'Collagen Advocacy Network', id: '1f776044f26a8bbc73dc418bfafd4e0f' },
    ]);
  });
});

describe('deploy', () => {
  it('reports the version and URL wrangler printed', async () => {
    const out = 'Deployed myco-server triggers\n  https://myco-server.example.workers.dev\nCurrent Version ID: 16a2423e-af96-4310-b61b-4e2b5fd1310b\n';
    const result = await deployWorker({ ...base(), runner: runner({ stdout: out }) });

    expect(result.versionId).toBe('16a2423e-af96-4310-b61b-4e2b5fd1310b');
    expect(result.url).toBe('https://myco-server.example.workers.dev');
  });

  it('supports a dry run that creates nothing', async () => {
    await deployWorker({ ...base(), runner: runner(), dryRun: true });
    expect(calls[0]!.args).toContain('--dry-run');
  });

  it('rolls nothing when the deploy ships the image already running, and rolls as usual when the bytes moved', async () => {
    // Replacing the instances for identical bytes takes every run in flight
    // through a drain and gains nothing.
    const image = `registry.cloudflare.com/${'a'.repeat(32)}/myco-server-harnesscontainer@sha256:${'b'.repeat(64)}`;
    const unchanged = await deployWorker({ ...base(), runner: runner(), pushedImage: image, deployedImage: image });
    expect(calls[0]!.args).toContain(CONTAINERS_ROLLOUT_NONE);
    // The caller watching the instances onto a new version is told there is nothing to watch.
    expect(unchanged.rolled).toBe(false);

    calls = [];
    const moved = await deployWorker({ ...base(), runner: runner(), pushedImage: image, deployedImage: `${image.slice(0, -1)}c` });
    expect(calls[0]!.args).not.toContain(CONTAINERS_ROLLOUT_NONE);
    expect(moved.rolled).toBe(true);

    // A first deploy has nothing deployed to compare against, and rolls.
    calls = [];
    const first = await deployWorker({ ...base(), runner: runner(), pushedImage: image });
    expect(calls[0]!.args).not.toContain(CONTAINERS_ROLLOUT_NONE);
    expect(first.rolled).toBe(true);
  });

  it('applies migrations against the remote database, never a local one', async () => {
    await applyMigrations({ ...base(), runner: runner(), databaseName: 'myco-server' });
    // A migration applied locally reports success and changes nothing deployed.
    expect(calls[0]!.args).toEqual(['wrangler', 'd1', 'migrations', 'apply', 'myco-server', '--remote']);
  });
});

describe('status', () => {
  it('reports not-deployed when wrangler finds nothing', async () => {
    const status = await cloudflareStatus({ ...base(), runner: runner({ code: 1 }), workerName: 'myco-server' });
    expect(status.deployed).toBe(false);
  });

  it('answers the NEWEST version from a list wrangler prints oldest-first, in either version-line shape', async () => {
    const out = [
      'Created: 2026-08-29T21:26:44Z',
      'Version(s):  (100%) 09a60d39-9de2-4dd0-a202-a1bd5766ec6b',
      'Created: 2026-08-31T18:00:00Z',
      'Version(s):  (100%) 53a749a3-5798-4392-9d4a-c06965686038',
    ].join('\n');
    const status = await cloudflareStatus({ ...base(), runner: runner({ stdout: out }), workerName: 'myco-server' });
    expect(status.versionId).toBe('53a749a3-5798-4392-9d4a-c06965686038');

    const legacy = await cloudflareStatus({ ...base(), runner: runner({ stdout: 'Version ID: 16a2423e-af96-4310-b61b-4e2b5fd1310b' }), workerName: 'myco-server' });
    expect(legacy.versionId).toBe('16a2423e-af96-4310-b61b-4e2b5fd1310b');
  });
});

describe('backup coverage is stated, not implied', () => {
  it('GATE: names the blob store as NOT captured', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'myco-cf-')), 'backup');
    const coverage = await backupCloudflare({ ...base(), runner: runner(), databaseName: 'myco-server', destination: dest });

    expect(coverage.captured).toContain('relational store (d1.sql)');
    // A backup reporting plain success would restore every row and no
    // attachment, which is worse than refusing.
    expect(coverage.notCaptured.join(' ')).toMatch(/blob store/);
  });

  it('exports the database remotely', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'myco-cf-')), 'backup');
    await backupCloudflare({ ...base(), runner: runner(), databaseName: 'myco-server', destination: dest });
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['d1', 'export', 'myco-server', '--remote']));
  });
});

describe('deployment record', () => {
  it('round-trips metadata that holds no credential', () => {
    const home = mkdtempSync(join(tmpdir(), 'myco-cf-home-'));
    const record = {
      accountId: ACCOUNT,
      workerName: 'myco-server',
      databaseName: 'myco-server',
      bucketName: 'myco-server-blobs',
      versionId: 'abc',
      deployedAt: '2026-08-27T00:00:00.000Z',
    };
    writeDeploymentRecord(record, home);

    expect(readDeploymentRecord(home)).toEqual(record);
    // Names and ids are not credentials; the token reaching them lives in the
    // operator's own wrangler login.
    expect(JSON.stringify(record)).not.toMatch(/token|secret|key/i);
  });

  it('reports nothing when no Deployment has been recorded', () => {
    expect(readDeploymentRecord(mkdtempSync(join(tmpdir(), 'myco-cf-empty-')))).toBeNull();
  });
});
