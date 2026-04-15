import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  handleGetMergedConfig,
  handleGetLocalConfig,
  handlePutScopedConfig,
  handleClearLocalConfig,
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

  it('POST /local/clear removes specified keys', async () => {
    await handlePutScopedConfig(tmpDir, { scope: 'local', patch: { appearance: { theme: 'dusk', font: 'geist-mono' } } });
    await handleClearLocalConfig(tmpDir, { keys: ['appearance.theme'] });
    const local = await handleGetLocalConfig(tmpDir);
    expect((local.body as any).appearance).toEqual({ font: 'geist-mono' });
  });

  it('PUT /scoped scope=local rejects missing patch', async () => {
    const res = await handlePutScopedConfig(tmpDir, { scope: 'local' });
    expect(res.status).toBe(400);
  });
});
