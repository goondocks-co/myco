import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teamRegistry } from '@myco/team/registry';

const TEAM_ID = `team_${'c'.repeat(32)}`;
const WORKER_URL = 'https://myco-team-acme-oss-deadbeef.test.workers.dev';

describe('teamExport / teamImport', () => {
  let tempDir: string;
  let homeA: string;
  let homeB: string;
  let outDir: string;
  let originalMycoHome: string | undefined;
  let originalTeamHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-bundle-'));
    homeA = path.join(tempDir, 'homeA');
    homeB = path.join(tempDir, 'homeB');
    outDir = path.join(tempDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    originalMycoHome = process.env.MYCO_HOME;
    originalTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = homeA;
    process.env.MYCO_TEAM_HOME = homeA;

    teamRegistry.save({
      team_id: TEAM_ID,
      name: 'Acme OSS',
      worker_url: WORKER_URL,
      domain: null,
      mcp_endpoint: `${WORKER_URL}/mcp`,
      created_at: '2026-06-28T00:00:00.000Z',
      projects: [],
    });
    teamRegistry.saveDeployment({
      team_id: TEAM_ID,
      worker_name: 'myco-team-acme-oss-deadbeef',
      worker_url: WORKER_URL,
      package_version: '0.3.0',
      created_at: '2026-06-28T00:00:00.000Z',
      last_upgraded: '2026-06-28T00:00:00.000Z',
      config_version: 1,
    });
    teamRegistry.writeSecret(TEAM_ID, 'MYCO_TEAM_API_KEY', 'secret-key-abc');
    teamRegistry.writeSecret(TEAM_ID, 'MYCO_TEAM_MCP_TOKEN', 'mcp-token-xyz');
  });

  afterEach(() => {
    if (originalMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalMycoHome;
    if (originalTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = originalTeamHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('round-trips a team through export → import into a fresh team home', async () => {
    const { teamExport, teamImport } = await import('../../packages/myco-team/src/cli.js');

    await teamExport({ teamId: TEAM_ID, out: outDir });

    const bundleFile = fs.readdirSync(outDir).find((f) => f.endsWith('.myco-team.json'));
    expect(bundleFile).toBeDefined();
    const bundlePath = path.join(outDir, bundleFile!);
    // Bundle carries secrets, so it must be written 0600.
    expect(fs.statSync(bundlePath).mode & 0o777).toBe(0o600);
    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf-8')) as {
      team: { team_id: string };
      secrets: Record<string, string>;
    };
    expect(bundle.team.team_id).toBe(TEAM_ID);
    expect(bundle.secrets.MYCO_TEAM_API_KEY).toBe('secret-key-abc');

    // Switch to a fresh, empty team home and restore from the bundle.
    process.env.MYCO_HOME = homeB;
    process.env.MYCO_TEAM_HOME = homeB;
    expect(teamRegistry.get(TEAM_ID)).toBeNull();

    await teamImport(bundlePath);

    const restored = teamRegistry.get(TEAM_ID);
    expect(restored?.name).toBe('Acme OSS');
    expect(restored?.worker_url).toBe(WORKER_URL);
    expect(teamRegistry.readDeployment(TEAM_ID)?.worker_name).toBe('myco-team-acme-oss-deadbeef');
    const restoredSecrets = teamRegistry.readSecrets(TEAM_ID);
    expect(restoredSecrets.MYCO_TEAM_API_KEY).toBe('secret-key-abc');
    expect(restoredSecrets.MYCO_TEAM_MCP_TOKEN).toBe('mcp-token-xyz');
  });

  it('export rejects an unknown team id', async () => {
    const { teamExport } = await import('../../packages/myco-team/src/cli.js');
    await expect(teamExport({ teamId: `team_${'9'.repeat(32)}` })).rejects.toThrow(/Unknown Team ID/);
  });

  it('import rejects a missing bundle file', async () => {
    const { teamImport } = await import('../../packages/myco-team/src/cli.js');
    await expect(teamImport(path.join(tempDir, 'nope.json'))).rejects.toThrow(/Bundle not found/);
  });

  it('import only restores known secret keys and rejects newline-injected values', async () => {
    const { teamImport } = await import('../../packages/myco-team/src/cli.js');
    const tid = `team_${'e'.repeat(32)}`;
    const malicious = path.join(tempDir, 'malicious.myco-team.json');
    fs.writeFileSync(malicious, JSON.stringify({
      bundle_version: 1,
      team: { team_id: tid, name: 'M', worker_url: WORKER_URL, domain: null, mcp_endpoint: null, created_at: '2026', projects: [] },
      deployment: null,
      secrets: {
        MYCO_TEAM_API_KEY: 'good-key',
        EVIL_KEY: 'should-not-be-written',          // unknown key -> skipped
        MYCO_TEAM_MCP_TOKEN: 'tok\nINJECTED=evil',  // newline-bearing -> skipped
      },
    }));

    await teamImport(malicious);

    const secrets = teamRegistry.readSecrets(tid);
    expect(secrets.MYCO_TEAM_API_KEY).toBe('good-key');
    expect(secrets.EVIL_KEY).toBeUndefined();
    expect(secrets.INJECTED).toBeUndefined();
    expect(secrets.MYCO_TEAM_MCP_TOKEN).toBeUndefined();
  });
});
