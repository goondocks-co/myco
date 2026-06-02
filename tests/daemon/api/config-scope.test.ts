import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  handleGetMergedConfig,
  handleGetLocalConfig,
  handlePutGroveConfig,
  handlePutScopedConfig,
} from '@myco/daemon/api/config';

function seedProject(dir: string) {
  fs.writeFileSync(path.join(dir, 'myco.yaml'),
    `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nnotifications:\n  enabled: true\n`);
}

describe('scoped config HTTP handlers', () => {
  let tmpDir: string;
  let mycoHome: string;
  let previousMycoHome: string | undefined;
  const groveId = 'grove_' + 'b'.repeat(32);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-scope-'));
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-scope-home-'));
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    seedProject(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(mycoHome, { recursive: true, force: true });
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
  });

  it('GET /merged returns project when no local', async () => {
    const res = await handleGetMergedConfig(tmpDir);
    expect((res.body as any).notifications.enabled).toBe(true);
  });

  it('PUT /scoped scope=local writes to <vault>/local.yaml', async () => {
    await handlePutScopedConfig(tmpDir, { scope: 'local', patch: { notifications: { enabled: false } } });
    const merged = await handleGetMergedConfig(tmpDir);
    expect((merged.body as any).notifications.enabled).toBe(false);
    const local = await handleGetLocalConfig(tmpDir);
    expect((local.body as any).notifications.enabled).toBe(false);
  });

  it('PUT /scoped scope=project with patch deep-merges into myco.yaml', async () => {
    // notifications.* moved to Machine tier (2026-06 scope correction), so a
    // project scoped PUT now exercises a project-tier field
    // (release_provenance.*) which is what actually persists to myco.yaml.
    await handlePutScopedConfig(tmpDir, {
      scope: 'project',
      patch: { release_provenance: { enabled: false } },
    });
    const project = fs.readFileSync(path.join(tmpDir, 'myco.yaml'), 'utf-8');
    expect(project).toContain('enabled: false');
  });

  it('PUT /scoped scope=project with invalid patch returns 400 validation_failed', async () => {
    const res = await handlePutScopedConfig(tmpDir, {
      scope: 'project',
      patch: { notifications: { enabled: 'nope' } },
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('validation_failed');
    expect(Array.isArray((res.body as any).issues)).toBe(true);
  });

  it('PUT /scoped rejects appearance writes because appearance is Grove-scoped', async () => {
    const local = await handlePutScopedConfig(tmpDir, {
      scope: 'local',
      patch: { appearance: { theme: 'moss' } },
    });
    const project = await handlePutScopedConfig(tmpDir, {
      scope: 'project',
      patch: { appearance: { theme: 'moss' } },
    });
    expect(local.status).toBe(400);
    expect((local.body as any).error).toBe('appearance_is_grove_scoped');
    expect(project.status).toBe(400);
    expect((project.body as any).error).toBe('appearance_is_grove_scoped');
  });

  it('PUT /grove-config writes appearance for the current Grove', async () => {
    const res = await handlePutGroveConfig(groveId, {
      patch: { appearance: { theme: 'plum', density: 'compact' } },
    });
    expect(res.response.status).toBeUndefined();
    const merged = await handleGetMergedConfig(tmpDir, { groveId });
    expect((merged.body as any).appearance.theme).toBe('plum');
    expect((merged.body as any).appearance.density).toBe('compact');
  });

  it('GET /local with Grove context lifts legacy local appearance before returning local overrides', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'local.yaml'),
      `appearance:\n  theme: terracotta\nnotifications:\n  enabled: false\n`,
    );

    const local = await handleGetLocalConfig(tmpDir, { groveId });
    const merged = await handleGetMergedConfig(tmpDir, { groveId });

    expect((local.body as any).appearance).toBeUndefined();
    expect((local.body as any).notifications.enabled).toBe(false);
    expect((merged.body as any).appearance.theme).toBe('terracotta');
    const groveYaml = fs.readFileSync(path.join(mycoHome, 'groves', groveId, 'grove.yaml'), 'utf-8');
    expect(groveYaml).toContain('terracotta');
  });

  it('PUT /scoped scope=project without patch returns 400', async () => {
    const res = await handlePutScopedConfig(tmpDir, { scope: 'project' });
    expect(res.status).toBe(400);
  });

  it('PUT /scoped rejects missing scope', async () => {
    const res = await handlePutScopedConfig(tmpDir, { patch: { notifications: { enabled: false } } });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('scope must be project or local');
  });

  it('PUT /scoped rejects invalid scope', async () => {
    const res = await handlePutScopedConfig(tmpDir, {
      scope: 'bogus' as 'project',
      patch: { notifications: { enabled: false } },
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('scope must be project or local');
  });

  it('PUT /scoped scope=local rejects missing patch', async () => {
    const res = await handlePutScopedConfig(tmpDir, { scope: 'local' });
    expect(res.status).toBe(400);
  });

  it('PUT /scoped with clear only at scope=local removes keys', async () => {
    await handlePutScopedConfig(tmpDir, { scope: 'local', patch: { notifications: { enabled: false } } });
    const res = await handlePutScopedConfig(tmpDir, { scope: 'local', clear: ['notifications.enabled'] });
    expect(res.status).toBeUndefined();
    const local = await handleGetLocalConfig(tmpDir);
    expect((local.body as any).notifications?.enabled).toBeUndefined();
  });

  it('PUT /scoped with clear only at scope=project removes keys from myco.yaml', async () => {
    await handlePutScopedConfig(tmpDir, { scope: 'project', patch: { notifications: { enabled: false } } });
    const res = await handlePutScopedConfig(tmpDir, { scope: 'project', clear: ['notifications.enabled'] });
    expect(res.status).toBeUndefined();
    const project = fs.readFileSync(path.join(tmpDir, 'myco.yaml'), 'utf-8');
    expect(project).not.toContain('enabled: false');
  });

  it('PUT /scoped applies patch and clear atomically', async () => {
    // Seed a local agent.provider override.
    await handlePutScopedConfig(tmpDir, { scope: 'local', patch: { agent: { provider: { type: 'anthropic' } } } });
    // Atomic: clear agent.provider AND set scheduled_tasks_enabled=false
    const res = await handlePutScopedConfig(tmpDir, {
      scope: 'local',
      patch: { agent: { scheduled_tasks_enabled: false } },
      clear: ['agent.provider'],
    });
    expect(res.status).toBeUndefined();
    const local = await handleGetLocalConfig(tmpDir);
    expect((local.body as any).agent?.provider).toBeUndefined();
    expect((local.body as any).agent?.scheduled_tasks_enabled).toBe(false);
  });

  it('PUT /scoped rejects 400 when patch and clear overlap', async () => {
    const res = await handlePutScopedConfig(tmpDir, {
      scope: 'local',
      patch: { notifications: { enabled: false } },
      clear: ['notifications.enabled'],
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('patch_clear_overlap');
  });

  it('PUT /scoped rejects 400 when patch and clear overlap by ancestry', async () => {
    const res = await handlePutScopedConfig(tmpDir, {
      scope: 'local',
      patch: { agent: { provider: { model: 'sonnet' } } },
      clear: ['agent.provider'],
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('patch_clear_overlap');
  });

  it('PUT /scoped rejects 400 when neither patch nor clear present', async () => {
    const res = await handlePutScopedConfig(tmpDir, { scope: 'local' });
    expect(res.status).toBe(400);
  });

  it('PUT /scoped rejects 400 when clear is not an array', async () => {
    const res = await handlePutScopedConfig(tmpDir, { scope: 'local', clear: 'agent.provider' as unknown as string[] });
    expect(res.status).toBe(400);
  });

  it('PUT /scoped rejects 400 when clear contains non-string entries', async () => {
    const res = await handlePutScopedConfig(tmpDir, {
      scope: 'local',
      clear: [123 as unknown as string],
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('clear entries must be non-empty strings');
  });

  it('PUT /scoped with empty patch object and non-empty clear is valid', async () => {
    await handlePutScopedConfig(tmpDir, { scope: 'local', patch: { notifications: { enabled: false } } });
    const res = await handlePutScopedConfig(tmpDir, { scope: 'local', patch: {}, clear: ['notifications.enabled'] });
    expect(res.status).toBeUndefined();
    const local = await handleGetLocalConfig(tmpDir);
    expect((local.body as any).notifications?.enabled).toBeUndefined();
  });

  it('PUT /scoped rejects invalid local overlays before writing local.yaml', async () => {
    const res = await handlePutScopedConfig(tmpDir, {
      scope: 'local',
      patch: { daemon: { log_level: 'verbose' } },
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('validation_failed');
    expect(fs.existsSync(path.join(tmpDir, 'local.yaml'))).toBe(false);
  });

  it('PUT /scoped local clear never writes config_version to local.yaml', async () => {
    // Simulate a local.yaml that gained config_version via a prior migration run.
    // Write the file directly to bypass the API (which now strips config_version).
    const localPath = path.join(tmpDir, 'local.yaml');
    fs.writeFileSync(localPath,
      `config_version: 9\nagent:\n  harness: claude-sdk\n  provider:\n    type: anthropic\n    model: claude-sonnet-4-5\n`);

    // Clear the agent.* paths — simulates "Reset to Grove".
    const res = await handlePutScopedConfig(tmpDir, {
      scope: 'local',
      patch: {},
      clear: ['agent.harness', 'agent.provider'],
    });
    expect(res.status).toBeUndefined();

    const rawYaml = fs.readFileSync(localPath, 'utf-8');
    expect(rawYaml).not.toContain('config_version');
    // local.yaml should be empty (or absent) when no user-set keys remain.
    const local = await handleGetLocalConfig(tmpDir);
    expect((local.body as any).agent?.harness).toBeUndefined();
    expect((local.body as any).agent?.provider).toBeUndefined();
  });

  it('PUT /scoped local patch never writes config_version to local.yaml', async () => {
    // Write a normal local override (no prior migration artifact).
    await handlePutScopedConfig(tmpDir, {
      scope: 'local',
      patch: { notifications: { enabled: false } },
    });
    const localPath = path.join(tmpDir, 'local.yaml');
    const rawYaml = fs.readFileSync(localPath, 'utf-8');
    expect(rawYaml).not.toContain('config_version');
  });
});
