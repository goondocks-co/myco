import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveTeamDir } from '@myco/grove/paths';
import { teamRegistry } from '@myco/team/registry';

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

const TEMPLATE_TOML = `name = "myco-team-template"
main = "src/index.ts"
compatibility_date = "2025-03-27"

[vars]
SYNC_PROTOCOL_VERSION = "2"
MIN_COMPAT_CLIENT_VERSION = "1"
MYCO_TEAM_PACKAGE_VERSION = "<MYCO_TEAM_PACKAGE_VERSION>"
MYCO_SCHEMA_VERSION = "<MYCO_SCHEMA_VERSION>"
SYNC_QUEUE_NAME = "<YOUR_SYNC_QUEUE_NAME>"
SYNC_DLQ_NAME = "<YOUR_SYNC_DLQ_NAME>"

[[d1_databases]]
binding = "MYCO_TEAM_DB"
database_name = "myco-team-template"
database_id = "<YOUR_D1_DATABASE_ID>"

[[vectorize]]
binding = "MYCO_TEAM_VECTORS"
index_name = "myco-team-template-vectors"

[[kv_namespaces]]
binding = "MYCO_SECRETS"
id = "<YOUR_KV_NAMESPACE_ID>"

[[queues.producers]]
binding = "SYNC_QUEUE"
queue = "<YOUR_SYNC_QUEUE_NAME>"

[[queues.consumers]]
queue = "<YOUR_SYNC_QUEUE_NAME>"
dead_letter_queue = "<YOUR_SYNC_DLQ_NAME>"
`;

function createFakeWorkerSource(sourceDir: string): void {
  fs.mkdirSync(path.join(sourceDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'wrangler.toml'), TEMPLATE_TOML, 'utf-8');
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({
    name: '@goondocks/myco-worker',
    dependencies: { agents: '^0.10.0' },
  }), 'utf-8');
  fs.writeFileSync(path.join(sourceDir, 'src', 'index.ts'), '// worker\n', 'utf-8');
}

const TWO_ACCOUNT_WHOAMI = [
  '┌──────────────────┬──────────────────────────────────┐',
  '│ Account Name     │ Account ID                       │',
  '├──────────────────┼──────────────────────────────────┤',
  '│ Personal Account │ 0123456789abcdef0123456789abcdef │',
  '├──────────────────┼──────────────────────────────────┤',
  '│ Team Account     │ fedcba9876543210fedcba9876543210 │',
  '└──────────────────┴──────────────────────────────────┘',
].join('\n') + '\n';

describe('teamCreate', () => {
  let tmpDir: string;
  let homeDir: string;
  let sourceDir: string;
  let previousHome: string | undefined;
  let previousMycoHome: string | undefined;
  let previousTeamHome: string | undefined;
  let previousPackageRoot: string | undefined;
  let previousAccountId: string | undefined;
  let previousExit: typeof process.exit;
  let previousConsoleError: typeof console.error;

  beforeEach(() => {
    execCalls.length = 0;
    execHandlers.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-create-'));
    homeDir = path.join(tmpDir, 'home');
    sourceDir = path.join(tmpDir, 'package-root', 'worker');
    fs.mkdirSync(homeDir, { recursive: true });
    createFakeWorkerSource(sourceDir);

    previousHome = process.env.HOME;
    previousMycoHome = process.env.MYCO_HOME;
    previousTeamHome = process.env.MYCO_TEAM_HOME;
    previousPackageRoot = process.env.MYCO_TEAM_PACKAGE_ROOT;
    previousAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    previousExit = process.exit;
    previousConsoleError = console.error;
    process.env.HOME = tmpDir;
    process.env.MYCO_HOME = homeDir;
    process.env.MYCO_TEAM_HOME = homeDir;
    process.env.MYCO_TEAM_PACKAGE_ROOT = path.join(tmpDir, 'package-root');
    delete process.env.CLOUDFLARE_ACCOUNT_ID;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith('/mcp/rotate')) {
        return new Response(JSON.stringify({ token: 'new-mcp-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    if (previousTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = previousTeamHome;
    if (previousPackageRoot === undefined) delete process.env.MYCO_TEAM_PACKAGE_ROOT;
    else process.env.MYCO_TEAM_PACKAGE_ROOT = previousPackageRoot;
    if (previousAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccountId;
    process.exit = previousExit;
    console.error = previousConsoleError;
  });

  it('provisions a team from anywhere — no project or Grove context — with consistent resource names', async () => {
    // No Grove is created and no project manifest is written: a team is a
    // global, machine-scoped entity, so `create` proceeds straight to
    // provisioning. The resource name derives from the TEAM name + a hash of
    // the (non-deterministic) team id, so we recover it from `execCalls` and
    // assert every asset reuses the same base.
    //
    // Call order (no custom domain):
    //   1. wrangler --version
    //   2. wrangler whoami
    //   3. wrangler d1 create <name>            -> D1 id JSON
    //   4. wrangler vectorize create <name>-vectors ...
    //   5. wrangler kv namespace create <name>-secrets   -> KV id JSON
    //   6. wrangler queues create <name>-sync
    //   7. wrangler queues create <name>-sync-dlq
    //   8. npm install (deploy-dir deps; fake worker has a package.json)
    //   9. wrangler secret put MYCO_TEAM_API_KEY --name <name>
    //  10. wrangler deploy                       -> workers.dev URL
    //  11. wrangler queues consumer worker remove <dlq> <name>
    //  12. wrangler queues consumer http add <dlq>
    const deployHandler = (): string => {
      const created = execCalls.find((call) => call.args[0] === 'd1' && call.args[1] === 'create');
      const name = created?.args[2] ?? 'myco-team-unknown';
      return `https://${name}.test.workers.dev\n`;
    };
    execHandlers.push(
      () => 'wrangler 4.8.1\n',                                          // 1 --version
      () => 'logged in\n',                                              // 2 whoami
      () => '{ "database_id": "11111111-1111-1111-1111-111111111111" }\n', // 3 d1 create
      () => '',                                                         // 4 vectorize create
      () => '{ "kv_namespaces": [ { "id": "abcdef1234567890" } ] }\n',  // 5 kv namespace create
      () => '',                                                         // 6 queues create sync
      () => '',                                                         // 7 queues create sync-dlq
      () => '',                                                         // 8 npm install
      () => '',                                                         // 9 secret put
      deployHandler,                                                    // 10 deploy
      () => '',                                                         // 11 dlq consumer remove
      () => '',                                                         // 12 dlq consumer http add
    );

    const { teamCreate } = await import('../../packages/myco-team/src/cli.js');
    await teamCreate({ name: 'Acme OSS' });

    // Recover the actual resource name from the recorded `d1 create` call.
    const d1Create = execCalls.find((call) => call.args[0] === 'd1' && call.args[1] === 'create');
    expect(d1Create).toBeDefined();
    const resourceName = d1Create!.args[2];
    // Team-name-derived: slug of "Acme OSS" + a hex hash of the team id.
    expect(resourceName).toMatch(/^myco-team-acme-oss-[0-9a-f]+$/);

    // Every other provisioned asset must reuse that exact base + documented suffix.
    const args = execCalls.map((call) => call.args);
    expect(args).toContainEqual(['vectorize', 'create', `${resourceName}-vectors`, '--dimensions', '1024', '--metric', 'cosine']);
    expect(args).toContainEqual(['kv', 'namespace', 'create', `${resourceName}-secrets`]);
    expect(args).toContainEqual(['queues', 'create', `${resourceName}-sync`]);
    expect(args).toContainEqual(['queues', 'create', `${resourceName}-sync-dlq`]);
    expect(args).toContainEqual(['secret', 'put', 'MYCO_TEAM_API_KEY', '--name', resourceName]);

    const teams = teamRegistry.list();
    expect(teams).toHaveLength(1);
    // Registered with NO projects — membership is an explicit later step in the UI.
    expect(teams[0].projects).toEqual([]);
    const teamId = teams[0].team_id;
    const deployDir = path.join(resolveTeamDir(teamId), 'worker');
    const patchedToml = fs.readFileSync(path.join(deployDir, 'wrangler.toml'), 'utf-8');
    expect(patchedToml).toContain(`name = "${resourceName}"`);
    expect(patchedToml).toContain(`database_name = "${resourceName}"`);
    expect(patchedToml).toContain(`index_name = "${resourceName}-vectors"`);
    expect(patchedToml).toContain(`SYNC_QUEUE_NAME = "${resourceName}-sync"`);
    expect(patchedToml).toContain(`SYNC_DLQ_NAME = "${resourceName}-sync-dlq"`);
    expect(patchedToml).toContain(`queue = "${resourceName}-sync"`);
    expect(patchedToml).toContain(`dead_letter_queue = "${resourceName}-sync-dlq"`);
    // Observability stays off unless --observability is passed.
    expect(patchedToml).not.toContain('[observability.logs]');
    expect(patchedToml).toContain('# Observability disabled');

    const deployment = JSON.parse(
      fs.readFileSync(path.join(resolveTeamDir(teamId), 'deployment.json'), 'utf-8'),
    ) as { team_id: string; worker_name: string; worker_url: string };
    expect(deployment.team_id).toMatch(/^team_[0-9a-f]{32}$/);
    expect(deployment.worker_name).toBe(resourceName);
    expect(deployment.worker_url).toBe(`https://${resourceName}.test.workers.dev`);
  });

  it('rejects create with no team name (and never touches Cloudflare)', async () => {
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    const errors: string[] = [];
    console.error = ((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    }) as typeof console.error;

    const { teamCreate } = await import('../../packages/myco-team/src/cli.js');
    // No --name and no TTY -> up-front name gate exits before any wrangler call.
    await expect(teamCreate({})).rejects.toThrow('process.exit(2)');
    expect(errors.join('\n')).toContain('myco-team create requires a team name');
    expect(execCalls).toHaveLength(0);
  });

  it('refuses to provision when multiple Cloudflare accounts and none is selected (non-interactive)', async () => {
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    const errors: string[] = [];
    console.error = ((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    }) as typeof console.error;

    execHandlers.push(
      () => 'wrangler 4.105.0\n',  // 1 --version
      () => TWO_ACCOUNT_WHOAMI,    // 2 whoami -> two accounts, no selection
    );

    const { teamCreate } = await import('../../packages/myco-team/src/cli.js');
    await expect(teamCreate({ name: 'Acme OSS' })).rejects.toThrow('process.exit(2)');

    expect(errors.join('\n')).toContain('More than one Cloudflare account');
    expect(errors.join('\n')).toContain('fedcba9876543210fedcba9876543210');
    // Resolution happens BEFORE any resource is created — only --version and
    // whoami ran, so nothing leaked into an arbitrary account.
    expect(execCalls.map((call) => call.args.slice(0, 2).join(' '))).toEqual(['--version', 'whoami']);
  });

  it('skips the account picker when CLOUDFLARE_ACCOUNT_ID is set (the --account-id flag path), even with multiple accounts', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    const deployHandler = (): string => {
      const created = execCalls.find((call) => call.args[0] === 'd1' && call.args[1] === 'create');
      const name = created?.args[2] ?? 'myco-team-unknown';
      return `https://${name}.test.workers.dev\n`;
    };
    execHandlers.push(
      () => 'wrangler 4.105.0\n',                                          // 1 --version
      () => TWO_ACCOUNT_WHOAMI,                                            // 2 whoami -> two accounts
      () => '{ "database_id": "11111111-1111-1111-1111-111111111111" }\n', // 3 d1 create
      () => '',                                                           // 4 vectorize create
      () => '{ "kv_namespaces": [ { "id": "abcdef1234567890" } ] }\n',    // 5 kv namespace create
      () => '',                                                           // 6 queues create sync
      () => '',                                                           // 7 queues create sync-dlq
      () => '',                                                           // 8 npm install
      () => '',                                                           // 9 secret put
      deployHandler,                                                      // 10 deploy
      () => '',                                                           // 11 dlq consumer remove
      () => '',                                                           // 12 dlq consumer http add
    );

    const { teamCreate } = await import('../../packages/myco-team/src/cli.js');
    await teamCreate({ name: 'Acme OSS' });

    // Provisioned end-to-end despite two accounts — the pre-set env short-circuits the picker.
    const d1Create = execCalls.find((call) => call.args[0] === 'd1' && call.args[1] === 'create');
    expect(d1Create).toBeDefined();
    expect(teamRegistry.list()).toHaveLength(1);
  });

  it('renders the observability block into the worker toml when --observability is passed', async () => {
    const deployHandler = (): string => {
      const created = execCalls.find((call) => call.args[0] === 'd1' && call.args[1] === 'create');
      const name = created?.args[2] ?? 'myco-team-unknown';
      return `https://${name}.test.workers.dev\n`;
    };
    execHandlers.push(
      () => 'wrangler 4.105.0\n',                                          // 1 --version
      () => 'logged in\n',                                                 // 2 whoami (single account)
      () => '{ "database_id": "11111111-1111-1111-1111-111111111111" }\n', // 3 d1 create
      () => '',                                                           // 4 vectorize create
      () => '{ "kv_namespaces": [ { "id": "abcdef1234567890" } ] }\n',    // 5 kv namespace create
      () => '',                                                           // 6 queues create sync
      () => '',                                                           // 7 queues create sync-dlq
      () => '',                                                           // 8 npm install
      () => '',                                                           // 9 secret put
      deployHandler,                                                      // 10 deploy
      () => '',                                                           // 11 dlq consumer remove
      () => '',                                                           // 12 dlq consumer http add
    );

    const { teamCreate } = await import('../../packages/myco-team/src/cli.js');
    await teamCreate({ name: 'Acme OSS', observability: true });

    const teamId = teamRegistry.list()[0].team_id;
    const toml = fs.readFileSync(
      path.join(resolveTeamDir(teamId), 'worker', 'wrangler.toml'),
      'utf-8',
    );
    expect(toml).toContain('[observability]');
    expect(toml).toContain('[observability.logs]');
    expect(toml).toContain('enabled = true');
    expect(toml).not.toContain('# Observability disabled');
  });
});
