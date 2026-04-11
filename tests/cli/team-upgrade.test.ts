import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Capture execFileSync invocations so tests can assert on the command flow
// and control return values per command.
const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
const execHandlers: Array<(args: string[], cwd?: string) => string | Error> = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn((command: string, args: string[], options?: { cwd?: string; encoding?: string }) => {
      execCalls.push({ command, args, cwd: options?.cwd });
      const handler = execHandlers.shift();
      if (!handler) return options?.encoding ? '' : Buffer.from('');
      const result = handler(args, options?.cwd);
      if (result instanceof Error) throw result;
      return options?.encoding ? result : Buffer.from(result);
    }),
  };
});

vi.mock('@myco/symbionts/detect.js', async () => {
  const actual = await vi.importActual<typeof import('@myco/symbionts/detect.js')>('@myco/symbionts/detect.js');
  return {
    ...actual,
    resolvePackageRoot: vi.fn(),
  };
});

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

  beforeEach(async () => {
    execCalls.length = 0;
    execHandlers.length = 0;

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-upgrade-'));
    vaultDir = path.join(testDir, '.myco');
    sourceDir = path.join(testDir, 'package-root', 'src', 'worker');
    deployDir = path.join(vaultDir, '.team-worker');

    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(deployDir, { recursive: true });

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

    const { resolvePackageRoot } = await import('@myco/symbionts/detect.js');
    vi.mocked(resolvePackageRoot).mockReturnValue(path.join(testDir, 'package-root'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('provisions a KV namespace on existing deployments that lack one', async () => {
    // Queue the expected wrangler/npm commands in order:
    // 1. kv namespace create → returns new KV ID
    // 2. npm install → ignored output
    // 3. wrangler secret put → ignored output
    // 4. wrangler deploy → returns deploy URL
    execHandlers.push(
      () => 'id: "0123456789abcdef0123456789abcdef"\n',
      () => '',
      () => '',
      () => 'https://myco-team-abc12345.test.workers.dev\n',
    );

    const { upgradeWorker } = await import('@myco/cli/team.js');
    const result = upgradeWorker(vaultDir);

    expect(result.success).toBe(true);
    expect(result.worker_url).toBe('https://myco-team-abc12345.test.workers.dev');

    // KV namespace create was the first call
    expect(execCalls[0]).toMatchObject({
      command: 'wrangler',
      args: ['kv', 'namespace', 'create', 'myco-team-abc12345-secrets'],
    });

    // npm install ran in the deploy dir
    const npmCall = execCalls.find((c) => c.command === 'npm' && c.args[0] === 'install');
    expect(npmCall).toBeDefined();
    expect(npmCall?.cwd).toBe(deployDir);

    // wrangler.toml in deploy dir has the real KV ID, not the placeholder
    const patchedToml = fs.readFileSync(path.join(deployDir, 'wrangler.toml'), 'utf-8');
    expect(patchedToml).not.toContain('<YOUR_KV_NAMESPACE_ID>');
    expect(patchedToml).toContain('id = "0123456789abcdef0123456789abcdef"');
    // Preserves existing D1 ID
    expect(patchedToml).toContain('database_id = "f9b0e166-a7e3-476c-b7a7-7a7f08723d67"');
    // Preserves existing worker name
    expect(patchedToml).toContain('name = "myco-team-abc12345"');
  });

  it('preserves existing KV namespace ID when already present', async () => {
    // Pre-existing deployment that already has a KV block
    const tomlWithKv = LEGACY_TOML + '\n[[kv_namespaces]]\nbinding = "MYCO_SECRETS"\nid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n';
    fs.writeFileSync(path.join(deployDir, 'wrangler.toml'), tomlWithKv, 'utf-8');

    // Only npm install + secret put + deploy should run; NO kv namespace create
    execHandlers.push(
      () => '',
      () => '',
      () => 'https://myco-team-abc12345.test.workers.dev\n',
    );

    const { upgradeWorker } = await import('@myco/cli/team.js');
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

  it('returns error when KV provisioning fails', async () => {
    execHandlers.push(() => new Error('Cloudflare API: authentication failed'));

    const { upgradeWorker } = await import('@myco/cli/team.js');
    const result = upgradeWorker(vaultDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to provision KV namespace');
    expect(result.error).toContain('authentication failed');
  });

  it('returns error when npm install fails', async () => {
    execHandlers.push(
      () => 'id: "0123456789abcdef0123456789abcdef"\n',
      () => new Error('npm ERR! ENOENT package.json'),
    );

    const { upgradeWorker } = await import('@myco/cli/team.js');
    const result = upgradeWorker(vaultDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to install worker dependencies');
  });

  it('runs npm install in the deploy dir before wrangler deploy', async () => {
    execHandlers.push(
      () => 'id: "0123456789abcdef0123456789abcdef"\n',
      () => '',
      () => '',
      () => 'https://myco-team-abc12345.test.workers.dev\n',
    );

    const { upgradeWorker } = await import('@myco/cli/team.js');
    upgradeWorker(vaultDir);

    // Verify ordering: npm install must run before wrangler deploy
    const npmInstallIndex = execCalls.findIndex((c) => c.command === 'npm' && c.args[0] === 'install');
    const wranglerDeployIndex = execCalls.findIndex((c) => c.command === 'wrangler' && c.args[0] === 'deploy');
    expect(npmInstallIndex).toBeGreaterThanOrEqual(0);
    expect(wranglerDeployIndex).toBeGreaterThanOrEqual(0);
    expect(npmInstallIndex).toBeLessThan(wranglerDeployIndex);
  });
});
