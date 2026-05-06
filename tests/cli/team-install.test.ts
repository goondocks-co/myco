import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveProjectManifest } from '@myco/config/project-manifest';
import { createGrove, registerProjectInGrove, type GroveRecord } from '@myco/grove/registry';
import { resolveGroveDir, resolveProjectVaultDir } from '@myco/grove/paths';

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
SYNC_PROTOCOL_VERSION = "1"
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

function expectedGroveResourceName(grove: GroveRecord): string {
  const hash = crypto.createHash('sha256').update(grove.id).digest('hex').slice(0, 8);
  return `myco-team-${grove.slug}-${hash}`;
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

  it('incorporates the Grove slug into newly provisioned Cloudflare resources', async () => {
    const grove = createGrove('Myco Dogfood', homeDir);
    saveProjectManifest(vaultDir, {
      project: { id: 'proj_test', name: 'myco' },
      grove: { binding_id: 'gbind_test', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, {
      projectId: 'proj_test',
      projectName: 'myco',
      projectRoot,
      bindingId: 'gbind_test',
    }, homeDir);

    const resourceName = expectedGroveResourceName(grove);
    execHandlers.push(
      () => 'wrangler 4.8.1\n',
      () => 'logged in\n',
      () => '{ "database_id": "11111111-1111-1111-1111-111111111111" }\n',
      () => '',
      () => '{ "kv_namespaces": [ { "id": "abcdef1234567890" } ] }\n',
      () => '',
      () => '',
      () => '',
      () => '',
      () => `https://${resourceName}.test.workers.dev\n`,
    );

    const { teamInit } = await import('../../packages/myco-team/src/cli.js');
    await teamInit(vaultDir);

    const args = execCalls.map((call) => call.args);
    expect(args).toContainEqual(['d1', 'create', resourceName]);
    expect(args).toContainEqual(['vectorize', 'create', `${resourceName}-vectors`, '--dimensions', '1024', '--metric', 'cosine']);
    expect(args).toContainEqual(['kv', 'namespace', 'create', `${resourceName}-secrets`]);
    expect(args).toContainEqual(['queues', 'create', `${resourceName}-sync`]);
    expect(args).toContainEqual(['queues', 'create', `${resourceName}-sync-dlq`]);
    expect(args).toContainEqual(['secret', 'put', 'MYCO_TEAM_API_KEY', '--name', resourceName]);

    const deployDir = path.join(resolveGroveDir(grove.id, homeDir), 'team', 'worker');
    const patchedToml = fs.readFileSync(path.join(deployDir, 'wrangler.toml'), 'utf-8');
    expect(patchedToml).toContain(`name = "${resourceName}"`);
    expect(patchedToml).toContain(`database_name = "${resourceName}"`);
    expect(patchedToml).toContain(`index_name = "${resourceName}-vectors"`);
    expect(patchedToml).toContain(`SYNC_QUEUE_NAME = "${resourceName}-sync"`);
    expect(patchedToml).toContain(`SYNC_DLQ_NAME = "${resourceName}-sync-dlq"`);
    expect(patchedToml).toContain(`queue = "${resourceName}-sync"`);
    expect(patchedToml).toContain(`dead_letter_queue = "${resourceName}-sync-dlq"`);
    expect(patchedToml).toContain(`queue = "${resourceName}-sync-dlq"`);

    const localConfig = JSON.parse(
      fs.readFileSync(path.join(resolveGroveDir(grove.id, homeDir), 'team', 'config.json'), 'utf-8'),
    ) as { worker_name: string; worker_url: string };
    expect(localConfig.worker_name).toBe(resourceName);
    expect(localConfig.worker_url).toBe(`https://${resourceName}.test.workers.dev`);
  });

  it('rejects fresh installs before provisioning when the project is not Grove-bound', async () => {
    const errors: string[] = [];
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    console.error = ((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    }) as typeof console.error;

    const { teamInit } = await import('../../packages/myco-team/src/cli.js');
    await expect(teamInit(vaultDir)).rejects.toThrow('process.exit(1)');

    expect(errors.join('\n')).toContain('myco-team install requires a Grove-bound project');
    expect(execCalls).toHaveLength(0);
  });
});
