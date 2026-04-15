import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  handleGetMergedConfig,
  handleGetLocalConfig,
  handlePutScopedConfig,
} from '@myco/daemon/api/config';

function seedProject(dir: string) {
  fs.writeFileSync(path.join(dir, 'myco.yaml'),
    `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nappearance:\n  theme: sage\n`);
}

describe('scoped config HTTP handlers', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-scope-')); seedProject(tmpDir); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('GET /merged returns project when no local', async () => {
    const res = await handleGetMergedConfig(tmpDir);
    expect((res.body as any).appearance.theme).toBe('sage');
  });

  it('PUT /scoped scope=local writes to <vault>/local.yaml', async () => {
    await handlePutScopedConfig(tmpDir, { scope: 'local', patch: { appearance: { theme: 'moss' } } });
    const merged = await handleGetMergedConfig(tmpDir);
    expect((merged.body as any).appearance.theme).toBe('moss');
    const local = await handleGetLocalConfig(tmpDir);
    expect((local.body as any).appearance.theme).toBe('moss');
  });

  it('PUT /scoped scope=project with patch deep-merges into myco.yaml', async () => {
    await handlePutScopedConfig(tmpDir, {
      scope: 'project',
      patch: { appearance: { theme: 'plum' } },
    });
    const project = fs.readFileSync(path.join(tmpDir, 'myco.yaml'), 'utf-8');
    expect(project).toContain('theme: plum');
    expect(project).toContain('provider: ollama');
  });

  it('PUT /scoped scope=project with invalid patch returns 400 validation_failed', async () => {
    const res = await handlePutScopedConfig(tmpDir, {
      scope: 'project',
      patch: { appearance: { theme: 'hotpink' } },  // 'hotpink' not in APPEARANCE_THEMES enum
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('validation_failed');
    expect(Array.isArray((res.body as any).issues)).toBe(true);
  });

  it('PUT /scoped scope=project without patch returns 400', async () => {
    const res = await handlePutScopedConfig(tmpDir, { scope: 'project' });
    expect(res.status).toBe(400);
  });

  it('PUT /scoped rejects missing scope', async () => {
    const res = await handlePutScopedConfig(tmpDir, { patch: { appearance: { theme: 'moss' } } });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('scope must be project or local');
  });

  it('PUT /scoped rejects invalid scope', async () => {
    const res = await handlePutScopedConfig(tmpDir, {
      scope: 'bogus' as 'project',
      patch: { appearance: { theme: 'moss' } },
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('scope must be project or local');
  });

  it('PUT /scoped scope=local rejects missing patch', async () => {
    const res = await handlePutScopedConfig(tmpDir, { scope: 'local' });
    expect(res.status).toBe(400);
  });

  it('PUT /scoped with clear only at scope=local removes keys', async () => {
    await handlePutScopedConfig(tmpDir, { scope: 'local', patch: { appearance: { theme: 'moss' } } });
    const res = await handlePutScopedConfig(tmpDir, { scope: 'local', clear: ['appearance.theme'] });
    expect(res.status).toBeUndefined();
    const local = await handleGetLocalConfig(tmpDir);
    expect((local.body as any).appearance?.theme).toBeUndefined();
  });

  it('PUT /scoped with clear only at scope=project removes keys from myco.yaml', async () => {
    await handlePutScopedConfig(tmpDir, { scope: 'project', patch: { appearance: { theme: 'plum' } } });
    const res = await handlePutScopedConfig(tmpDir, { scope: 'project', clear: ['appearance.theme'] });
    expect(res.status).toBeUndefined();
    const project = fs.readFileSync(path.join(tmpDir, 'myco.yaml'), 'utf-8');
    expect(project).not.toContain('theme: plum');
  });

  it('PUT /scoped applies patch and clear atomically', async () => {
    // Seed: appearance.theme=sage (project), agent.provider set locally
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
      patch: { appearance: { theme: 'moss' } },
      clear: ['appearance.theme'],
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
    await handlePutScopedConfig(tmpDir, { scope: 'local', patch: { appearance: { theme: 'moss' } } });
    const res = await handlePutScopedConfig(tmpDir, { scope: 'local', patch: {}, clear: ['appearance.theme'] });
    expect(res.status).toBeUndefined();
    const local = await handleGetLocalConfig(tmpDir);
    expect((local.body as any).appearance?.theme).toBeUndefined();
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
});
