import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveProjectManifest } from '@myco/config/project-manifest';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry';
import { resolveProjectVaultDir, resolveTeamDir } from '@myco/grove/paths';
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

[[queues.consumers]]
queue = "<YOUR_SYNC_DLQ_NAME>"
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

describe('teamInit', () => {
  let tmpDir: string;
  let homeDir: string;
  let projectRoot: string;
  let vaultDir: string;
  let sourceDir: string;
  let previousHome: string | undefined;
  let previousMycoHome: string | undefined;
  let previousPackageRoot: string | undefined;
  let previousExit: typeof process.exit;
  let previousConsoleError: typeof console.error;

  beforeEach(() => {
    execCalls.length = 0;
    execHandlers.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-install-'));
    homeDir = path.join(tmpDir, 'home');
    projectRoot = path.join(tmpDir, 'project');
    vaultDir = resolveProjectVaultDir(projectRoot);
    sourceDir = path.join(tmpDir, 'package-root', 'worker');
    fs.mkdirSync(vaultDir, { recursive: true });
    createFakeWorkerSource(sourceDir);

    previousHome = process.env.HOME;
    previousMycoHome = process.env.MYCO_HOME;
    previousPackageRoot = process.env.MYCO_TEAM_PACKAGE_ROOT;
    previousExit = process.exit;
    previousConsoleError = console.error;
    process.env.HOME = tmpDir;
    process.env.MYCO_HOME = homeDir;
    process.env.MYCO_TEAM_PACKAGE_ROOT = path.join(tmpDir, 'package-root');

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
    if (previousPackageRoot === undefined) delete process.env.MYCO_TEAM_PACKAGE_ROOT;
    else process.env.MYCO_TEAM_PACKAGE_ROOT = previousPackageRoot;
    process.exit = previousExit;
    console.error = previousConsoleError;
  });

  it('derives consistent team-name resource names across newly provisioned Cloudflare assets', async () => {
    const grove = createGrove('Myco Dogfood', homeDir);
    saveProjectManifest(vaultDir, {
      project: { id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'myco' },
      grove: { binding_id: 'gbind_test', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, {
      projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      projectName: 'myco',
      projectRoot,
      bindingId: 'gbind_test',
    }, homeDir);

    // The resource name is now derived from the TEAM name + a hash of the
    // (non-deterministic) team id, so we can't predict it up front. The
    // wrangler handlers return canned outputs by POSITION in teamInit's call
    // sequence; the actual resource name is recovered from `execCalls` after
    // the run and used to drive every consistency assertion below.
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
    const deployHandler = (args: string[]): string => {
      // teamInit captures the worker_url from `wrangler deploy` output, which
      // must echo the *actual* resource name so worker_name === worker_url host.
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

    const { teamInit } = await import('../../packages/myco-team/src/cli.js');
    await teamInit(vaultDir, { name: 'Acme OSS' });

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

    const teams = teamRegistry.list(homeDir);
    expect(teams).toHaveLength(1);
    const teamId = teams[0].team_id;
    const deployDir = path.join(resolveTeamDir(teamId, homeDir), 'worker');
    const patchedToml = fs.readFileSync(path.join(deployDir, 'wrangler.toml'), 'utf-8');
    expect(patchedToml).toContain(`name = "${resourceName}"`);
    expect(patchedToml).toContain(`database_name = "${resourceName}"`);
    expect(patchedToml).toContain(`index_name = "${resourceName}-vectors"`);
    expect(patchedToml).toContain(`SYNC_QUEUE_NAME = "${resourceName}-sync"`);
    expect(patchedToml).toContain(`SYNC_DLQ_NAME = "${resourceName}-sync-dlq"`);
    expect(patchedToml).toContain(`queue = "${resourceName}-sync"`);
    expect(patchedToml).toContain(`dead_letter_queue = "${resourceName}-sync-dlq"`);
    expect(patchedToml).toContain(`queue = "${resourceName}-sync-dlq"`);

    const deployment = JSON.parse(
      fs.readFileSync(path.join(resolveTeamDir(teamId, homeDir), 'deployment.json'), 'utf-8'),
    ) as { team_id: string; worker_name: string; worker_url: string };
    expect(deployment.team_id).toMatch(/^team_[0-9a-f]{32}$/);
    expect(deployment.worker_name).toBe(resourceName);
    expect(deployment.worker_url).toBe(`https://${resourceName}.test.workers.dev`);
  });

  it('rejects fresh installs before provisioning when the project is not Grove-bound', async () => {
    const errors: string[] = [];
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    console.error = ((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    }) as typeof console.error;

    // Provision a project manifest without Grove binding so the request
    // context resolver succeeds, leaving the legacy
    // `requireGroveInstallScope` check to reject the install.
    saveProjectManifest(vaultDir, {
      project: { id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'fresh' },
    });

    const { teamInit } = await import('../../packages/myco-team/src/cli.js');
    // A team name is supplied so the install clears the up-front name gate
    // and reaches the Grove-bound check this test actually exercises.
    // Pre-Grove vaults exit with code 2 (configuration error) and a
    // friendly Grove prompt rather than the historical generic exit(1).
    await expect(teamInit(vaultDir, { name: 'Some Team' })).rejects.toThrow('process.exit(2)');

    const stderr = errors.join('\n');
    expect(stderr).toContain('myco-team install requires a Grove-bound project');
    expect(stderr).toContain('auto-registers');
    expect(stderr).not.toContain('--legacy');
    expect(execCalls).toHaveLength(0);
  });

});
