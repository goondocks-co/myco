import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Capture execFileSync invocations so tests can assert on the command flow
// and control return values per command.
const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
const execHandlers: Array<(args: string[], cwd?: string) => string | Error> = [];

import * as childProcessActual__ns from 'node:child_process';
const childProcessActual = { ...childProcessActual__ns };
mock.module('node:child_process', () => ({
    ...childProcessActual,
    execFileSync: vi.fn((command: string, args: string[], options?: { cwd?: string; encoding?: string }) => {
      execCalls.push({ command, args, cwd: options?.cwd });
      const handler = execHandlers.shift();
      if (!handler) return options?.encoding ? '' : Buffer.from('');
      const result = handler(args, options?.cwd);
      if (result instanceof Error) throw result;
      return options?.encoding ? result : Buffer.from(result);
    }),
  }));

// Minimal existing wrangler.toml — pre-KV (older deployment)
const LEGACY_TOML = `name = "myco-team-abc12345"
main = "src/index.ts"
compatibility_date = "2025-03-27"

[vars]
SYNC_PROTOCOL_VERSION = "1"

[[d1_databases]]
binding = "MYCO_TEAM_DB"
database_name = "myco-team-abc12345"
database_id = "f9b0e166-a7e3-476c-b7a7-7a7f08723d67"

[[vectorize]]
binding = "MYCO_TEAM_VECTORS"
index_name = "myco-team-abc12345-vectors"

[ai]
binding = "AI"
`;

// Current worker source wrangler.toml template with KV placeholder
const NEW_TEMPLATE_TOML = `name = "myco-team-TEMPLATE"
main = "src/index.ts"
compatibility_date = "2025-03-27"

[vars]
SYNC_PROTOCOL_VERSION = "1"

[[d1_databases]]
binding = "MYCO_TEAM_DB"
database_name = "myco-team-TEMPLATE"
database_id = "<YOUR_D1_DATABASE_ID>"

[[vectorize]]
binding = "MYCO_TEAM_VECTORS"
index_name = "myco-team-TEMPLATE-vectors"

[[kv_namespaces]]
binding = "MYCO_SECRETS"
id = "<YOUR_KV_NAMESPACE_ID>"

[ai]
binding = "AI"
`;

function createFakeWorkerSource(sourceDir: string): void {
  fs.mkdirSync(path.join(sourceDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'wrangler.toml'), NEW_TEMPLATE_TOML, 'utf-8');
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({
    name: '@goondocks/myco-worker',
    dependencies: { agents: '^0.10.0' },
  }), 'utf-8');
  fs.writeFileSync(path.join(sourceDir, 'src', 'index.ts'), '// worker\n', 'utf-8');
}

describe('upgradeWorker', () => {
  let testDir: string;
  let vaultDir: string;
  let sourceDir: string;
  let deployDir: string;
  let tempHomeDir: string;
  let previousHome: string | undefined;

  async function importTeamCli(): Promise<typeof import('@myco-team/cli')> {
    // Pre-import the real module before registering the mock, so the factory
    // doesn't recurse into the eclipsed registry entry.
    const deployActual = await import('@myco-deploy/index.js');
    mock.module('@myco-deploy/index.js', () => ({
      ...deployActual,
      resolveHomeConfigPath: (configDir: string, fileName: string) => path.join(tempHomeDir, configDir, fileName),
    }));
    return import('@myco-team/cli');
  }

  beforeEach(async () => {
    execCalls.length = 0;
    execHandlers.length = 0;

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-upgrade-'));
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = tempHomeDir;
    vaultDir = path.join(testDir, '.myco');
    sourceDir = path.join(testDir, 'package-root', 'worker');
    deployDir = path.join(vaultDir, 'team', 'worker');

    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(deployDir, { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'project.toml'),
      '[project]\nid = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\nname = "upgrade-test"\n',
      'utf-8',
    );

    // Existing deployment with legacy (pre-KV) wrangler.toml
    fs.writeFileSync(path.join(deployDir, 'wrangler.toml'), LEGACY_TOML, 'utf-8');

    // myco.yaml so loadConfig succeeds
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), [
      'version: 3',
      'config_version: 0',
      'team:',
      '  enabled: true',
      '  worker_url: https://myco-team-abc12345.test.workers.dev',
    ].join('\n'), 'utf-8');

    // Secrets file with API key so the wrangler secret put path runs
    fs.writeFileSync(path.join(vaultDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=test-api-key\n', 'utf-8');

    // Fake "package" source the CLI will copy from
    createFakeWorkerSource(sourceDir);

    process.env.MYCO_TEAM_PACKAGE_ROOT = path.join(testDir, 'package-root');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ processed: 0, reindexed: 0, deleted: 0, next_cursor: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.resetModules();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    delete process.env.MYCO_TEAM_PACKAGE_ROOT;
    vi.unstubAllGlobals();
  });

  /**
   * Push the trailing 5 handlers every happy-path upgrade test needs after
   * its KV-mode prefix: queues create sync, queues create dlq, npm install,
   * wrangler secret put, wrangler deploy. Override individual stages by
   * passing them in `overrides`.
   */
  function pushUpgradeTailHandlers(overrides: {
    queueSync?: () => string | Error;
    queueDlq?: () => string | Error;
    npmInstall?: () => string | Error;
    secretPut?: () => string | Error;
    deploy?: () => string | Error;
  } = {}): void {
    execHandlers.push(
      overrides.queueSync ?? (() => ''),
      overrides.queueDlq ?? (() => ''),
      overrides.npmInstall ?? (() => ''),
      overrides.secretPut ?? (() => ''),
      overrides.deploy ?? (() => 'https://myco-team-abc12345.test.workers.dev\n'),
    );
  }

  it('provisions a KV namespace on existing deployments that lack one', async () => {
    // Simulate wrangler's actual output format: a JSON config snippet with "id": "..."
    // Real-world observation: KV IDs can be 31 hex chars, not always 32.
    const wranglerKvCreateOutput = `⛅️ wrangler 4.8.1
Resource location: remote
🌀 Creating namespace with title "myco-team-abc12345-secrets"
✨ Success! To access your new KV Namespace in your Worker, add the following snippet to your configuration file:
{ "kv_namespaces": [ { "binding": "myco_team_abc12345_secrets", "id": "7cc069cb32b4438b29079cca4714056" } ] }
`;

    execHandlers.push(() => wranglerKvCreateOutput);
    pushUpgradeTailHandlers();

    const { upgradeWorker } = await importTeamCli();
    const result = upgradeWorker(vaultDir);

    expect(result.success).toBe(true);
    expect(result.worker_url).toBe('https://myco-team-abc12345.test.workers.dev');

    expect(execCalls[0]).toMatchObject({
      command: 'wrangler',
      args: ['kv', 'namespace', 'create', 'myco-team-abc12345-secrets'],
    });
    expect(execCalls[1]).toMatchObject({
      command: 'wrangler',
      args: ['queues', 'create', 'myco-team-abc12345-sync'],
    });
    expect(execCalls[2]).toMatchObject({
      command: 'wrangler',
      args: ['queues', 'create', 'myco-team-abc12345-sync-dlq'],
    });

    const npmCall = execCalls.find((c) => c.command === 'npm' && c.args[0] === 'install');
    expect(npmCall).toBeDefined();
    expect(npmCall?.cwd).toBe(deployDir);

    const patchedToml = fs.readFileSync(path.join(deployDir, 'wrangler.toml'), 'utf-8');
    expect(patchedToml).not.toContain('<YOUR_KV_NAMESPACE_ID>');
    expect(patchedToml).toContain('id = "7cc069cb32b4438b29079cca4714056"');
    expect(patchedToml).toContain('database_id = "f9b0e166-a7e3-476c-b7a7-7a7f08723d67"');
    expect(patchedToml).toContain('name = "myco-team-abc12345"');
  });

  it('looks up KV namespace via list when create reports already-exists', async () => {
    // Simulate retry after partial failure: wrangler rejects the create,
    // then the list output has a banner prefix before the JSON array.
    const listOutput = `⛅️ wrangler 4.8.1
[
  { "id": "aaaa1111bbbb2222cccc3333dddd4444", "title": "other-namespace" },
  { "id": "7cc069cb32b4438b29079cca4714056", "title": "myco_team_abc12345_secrets" }
]
`;
    execHandlers.push(
      () => new Error('A namespace with the same title already exists'),
      () => listOutput,
    );
    pushUpgradeTailHandlers();

    const { upgradeWorker } = await importTeamCli();
    const result = upgradeWorker(vaultDir);

    expect(result.success).toBe(true);

    const patchedToml = fs.readFileSync(path.join(deployDir, 'wrangler.toml'), 'utf-8');
    expect(patchedToml).toContain('id = "7cc069cb32b4438b29079cca4714056"');
  });

  it('preserves existing KV namespace ID when already present', async () => {
    // Pre-existing deployment that already has a KV block
    const tomlWithKv = LEGACY_TOML + '\n[[kv_namespaces]]\nbinding = "MYCO_SECRETS"\nid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n';
    fs.writeFileSync(path.join(deployDir, 'wrangler.toml'), tomlWithKv, 'utf-8');

    // KV is preserved (no create); queue creates still run; then npm install, secret put, deploy
    pushUpgradeTailHandlers();

    const { upgradeWorker } = await importTeamCli();
    const result = upgradeWorker(vaultDir);

    expect(result.success).toBe(true);

    // Should NOT have called kv namespace create
    const kvCreateCall = execCalls.find(
      (c) => c.command === 'wrangler' && c.args[0] === 'kv' && c.args[1] === 'namespace' && c.args[2] === 'create',
    );
    expect(kvCreateCall).toBeUndefined();

    // Existing KV ID preserved
    const patchedToml = fs.readFileSync(path.join(deployDir, 'wrangler.toml'), 'utf-8');
    expect(patchedToml).toContain('id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
  });

  it('treats existing queues as a successful upgrade (CF "is already taken")', async () => {
    // KV exists; wrangler queues create reports the collision shape we hit
    // live ("is already taken", error code 11009). ensureQueue must swallow
    // both shapes so re-running upgrade is idempotent.
    const tomlWithKv = LEGACY_TOML + '\n[[kv_namespaces]]\nbinding = "MYCO_SECRETS"\nid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n';
    fs.writeFileSync(path.join(deployDir, 'wrangler.toml'), tomlWithKv, 'utf-8');

    pushUpgradeTailHandlers({
      queueSync: () => new Error("Queue name 'myco-team-abc12345-sync' is already taken. [code: 11009]"),
      queueDlq: () => new Error("Queue name 'myco-team-abc12345-sync-dlq' is already taken. [code: 11009]"),
    });

    const { upgradeWorker } = await importTeamCli();
    const result = upgradeWorker(vaultDir);
    expect(result.success).toBe(true);
  });

  it('returns error when KV provisioning fails', async () => {
    execHandlers.push(() => new Error('Cloudflare API: authentication failed'));

    const { upgradeWorker } = await importTeamCli();
    const result = upgradeWorker(vaultDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to provision KV namespace');
    expect(result.error).toContain('authentication failed');
  });

  it('returns error when npm install fails', async () => {
    execHandlers.push(() => '{ "kv_namespaces": [ { "binding": "x", "id": "0123456789abcdef0123456789abcdef" } ] }\n');
    pushUpgradeTailHandlers({
      npmInstall: () => new Error('npm ERR! ENOENT package.json'),
    });

    const { upgradeWorker } = await importTeamCli();
    const result = upgradeWorker(vaultDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to install worker dependencies');
  });

  it('runs npm install in the deploy dir before wrangler deploy', async () => {
    execHandlers.push(() => '{ "kv_namespaces": [ { "binding": "x", "id": "0123456789abcdef0123456789abcdef" } ] }\n');
    pushUpgradeTailHandlers();

    const { upgradeWorker } = await importTeamCli();
    upgradeWorker(vaultDir);

    // Verify ordering: npm install must run before wrangler deploy
    const npmInstallIndex = execCalls.findIndex((c) => c.command === 'npm' && c.args[0] === 'install');
    const wranglerDeployIndex = execCalls.findIndex((c) => c.command === 'wrangler' && c.args[0] === 'deploy');
    expect(npmInstallIndex).toBeGreaterThanOrEqual(0);
    expect(wranglerDeployIndex).toBeGreaterThanOrEqual(0);
    expect(npmInstallIndex).toBeLessThan(wranglerDeployIndex);
  });

  it('upgrade omits an [observability] block by default (Cloudflare logs cost extra)', async () => {
    execHandlers.push(() => '{ "kv_namespaces": [ { "binding": "x", "id": "0123456789abcdef0123456789abcdef" } ] }\n');
    pushUpgradeTailHandlers();

    const { upgradeWorker } = await importTeamCli();
    upgradeWorker(vaultDir);

    const patchedToml = fs.readFileSync(path.join(deployDir, 'wrangler.toml'), 'utf-8');
    expect(patchedToml).not.toContain('[observability]');
    expect(patchedToml).toContain('Pass `--observability`');
  });

  it('upgrade with observability:true writes an [observability] block to wrangler.toml', async () => {
    execHandlers.push(() => '{ "kv_namespaces": [ { "binding": "x", "id": "0123456789abcdef0123456789abcdef" } ] }\n');
    pushUpgradeTailHandlers();

    const { upgradeWorker } = await importTeamCli();
    upgradeWorker(vaultDir, { observability: true });

    const patchedToml = fs.readFileSync(path.join(deployDir, 'wrangler.toml'), 'utf-8');
    expect(patchedToml).toContain('[observability]');
    expect(patchedToml).toContain('enabled = true');
  });

  it('upgrade strips a stale [observability] block when observability:false', async () => {
    // Simulate a deploy dir from a prior --observability run: it already has
    // an [observability] block. Upgrade without the flag should leave the
    // toml block-free, not produce two blocks.
    const tomlWithObs = LEGACY_TOML
      + '\n[[kv_namespaces]]\nbinding = "MYCO_SECRETS"\nid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n'
      + '\n[observability]\n[observability.logs]\nenabled = true\ninvocation_logs = true\n';
    fs.writeFileSync(path.join(deployDir, 'wrangler.toml'), tomlWithObs, 'utf-8');
    pushUpgradeTailHandlers();

    const { upgradeWorker } = await importTeamCli();
    upgradeWorker(vaultDir);

    const patchedToml = fs.readFileSync(path.join(deployDir, 'wrangler.toml'), 'utf-8');
    expect(patchedToml).not.toContain('[observability]');
  });

  it('teamUpgrade does not trigger remote vector reindex by default', async () => {
    execHandlers.push(() => '{ "kv_namespaces": [ { "binding": "x", "id": "0123456789abcdef0123456789abcdef" } ] }\n');
    pushUpgradeTailHandlers();

    const { teamUpgrade } = await importTeamCli();
    await teamUpgrade(vaultDir);

    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(
      'https://myco-team-abc12345.test.workers.dev/vectors/reindex',
    );
  });

  it('teamUpgrade triggers remote vector reindex when explicitly requested', async () => {
    execHandlers.push(() => '{ "kv_namespaces": [ { "binding": "x", "id": "0123456789abcdef0123456789abcdef" } ] }\n');
    pushUpgradeTailHandlers();

    vi.mocked(fetch).mockImplementation(async () => new Response(
      JSON.stringify({ enqueued: 0, by_table: { spores: 0, sessions: 0, plans: 0, artifacts: 0, skill_records: 0 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const { teamUpgrade } = await importTeamCli();
    await teamUpgrade(vaultDir, { reindexVectors: true });

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'https://myco-team-abc12345.test.workers.dev/vectors/reindex',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('retries remote vector reindex when the new route is not ready immediately after deploy', async () => {
    execHandlers.push(() => '{ "kv_namespaces": [ { "binding": "x", "id": "0123456789abcdef0123456789abcdef" } ] }\n');
    pushUpgradeTailHandlers();

    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"Not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementation(async () => new Response(JSON.stringify({ enqueued: 0, by_table: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const { teamUpgrade } = await importTeamCli();
    await teamUpgrade(vaultDir, { reindexVectors: true });

    // 1 retry for not-ready + 1 successful POST = 2 calls. The old
    // protocol made 5 paginated calls per table; the new one is one
    // fire-and-forget enqueue.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries remote vector reindex when the request times out', async () => {
    execHandlers.push(() => '{ "kv_namespaces": [ { "binding": "x", "id": "0123456789abcdef0123456789abcdef" } ] }\n');
    pushUpgradeTailHandlers();

    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      .mockImplementation(async () => new Response(JSON.stringify({ enqueued: 0, by_table: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const { teamUpgrade } = await importTeamCli();
    await teamUpgrade(vaultDir, { reindexVectors: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
