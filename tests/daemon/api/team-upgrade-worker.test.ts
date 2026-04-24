/**
 * Tests for `handleUpgradeWorker` — the daemon-side handler that spawns
 * the `myco-team upgrade --json` subprocess.
 *
 * We cover the surface the handler owns (subprocess resolution, missing-
 * package error, output parsing, client reinit). The actual upgrade logic
 * lives in `@goondocks/myco-team` and is exercised by its own tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeVault(root: string): string {
  const vaultDir = path.join(root, 'project', '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), [
    'version: 3',
    'config_version: 0',
    'team:',
    '  enabled: true',
    '  worker_url: https://myco-team-test.example.workers.dev',
  ].join('\n'), 'utf-8');
  fs.writeFileSync(path.join(vaultDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=test-api-key\n', 'utf-8');
  return vaultDir;
}

function stageFakeMycoTeam(prefix: string, body: string): string {
  const teamDir = path.join(prefix, 'lib', 'node_modules', '@goondocks', 'myco-team');
  const distDir = path.join(teamDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, 'package.json'),
    JSON.stringify({ name: '@goondocks/myco-team', version: '9.9.9' }),
    'utf-8',
  );
  const entry = path.join(distDir, 'main.js');
  fs.writeFileSync(entry, body, { encoding: 'utf-8', mode: 0o644 });
  return entry;
}

function makeDeps(vaultDir: string, globalPrefix: string | null) {
  return {
    vaultDir,
    machineId: 'machine-test',
    globalPrefix,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getTeamClient: () => null,
    setTeamClient: () => undefined,
  };
}

describe('handleUpgradeWorker', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-upgrade-worker-'));
    vaultDir = makeVault(tempDir);
  });

  afterEach(() => {
    vi.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns myco_team_not_installed when the package is not present under globalPrefix', async () => {
    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const prefix = path.join(tempDir, 'empty-prefix');
    fs.mkdirSync(prefix, { recursive: true });
    const handlers = createTeamHandlers(makeDeps(vaultDir, prefix) as never);

    const res = await handlers.handleUpgradeWorker({} as never);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'myco_team_not_installed' });
  });

  it('returns myco_team_not_installed when globalPrefix is null', async () => {
    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const handlers = createTeamHandlers(makeDeps(vaultDir, null) as never);

    const res = await handlers.handleUpgradeWorker({} as never);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'myco_team_not_installed' });
  });

  it('parses the subprocess JSON result and propagates success', async () => {
    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const prefix = path.join(tempDir, 'success-prefix');
    // Stub myco-team: emit a success JSON payload and exit 0.
    stageFakeMycoTeam(prefix, [
      "process.stdout.write(JSON.stringify({",
      "  success: true,",
      "  worker_url: 'https://myco-team-test.example.workers.dev',",
      "  version: '9.9.9',",
      "}) + '\\n');",
    ].join('\n'));
    const handlers = createTeamHandlers(makeDeps(vaultDir, prefix) as never);

    const res = await handlers.handleUpgradeWorker({} as never);

    expect(res.status).toBeUndefined();
    expect(res.body).toMatchObject({
      success: true,
      worker_url: 'https://myco-team-test.example.workers.dev',
      version: '9.9.9',
    });
  });

  it('propagates subprocess-reported failure with stderr included', async () => {
    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const prefix = path.join(tempDir, 'fail-prefix');
    stageFakeMycoTeam(prefix, [
      "process.stderr.write('wrangler deploy failed\\n');",
      "process.stdout.write(JSON.stringify({",
      "  success: false,",
      "  error: 'wrangler deploy failed',",
      "}) + '\\n');",
      "process.exit(1);",
    ].join('\n'));
    const handlers = createTeamHandlers(makeDeps(vaultDir, prefix) as never);

    const res = await handlers.handleUpgradeWorker({} as never);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, error: 'wrangler deploy failed' });
    expect(typeof (res.body as { stderr?: string }).stderr).toBe('string');
  });

  it('returns upgrade_output_invalid when the subprocess emits garbage', async () => {
    const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
    const prefix = path.join(tempDir, 'garbage-prefix');
    stageFakeMycoTeam(prefix, "process.stdout.write('not json\\n');");
    const handlers = createTeamHandlers(makeDeps(vaultDir, prefix) as never);

    const res = await handlers.handleUpgradeWorker({} as never);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'upgrade_output_invalid' });
  });
});
