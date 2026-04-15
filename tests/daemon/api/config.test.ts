import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPlanDirHandlers, handleGetConfig, handlePutScopedConfig } from '@myco/daemon/api/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

describe('config API', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-api-'));
    const config = { version: 3, embedding: { provider: 'ollama', model: 'bge-m3' } };
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('GET returns parsed config', async () => {
    const result = await handleGetConfig(vaultDir);
    expect(result.body).toHaveProperty('version', 3);
  });

  it('PUT scoped patch merges and saves config', async () => {
    const result = await handlePutScopedConfig(vaultDir, {
      scope: 'project',
      patch: {
        embedding: { provider: 'ollama', model: 'nomic-embed-text' },
        capture: { ignore_plan_dirs_in_git: true },
      },
    });
    expect(result.status).toBeUndefined(); // 200 default
    const saved = YAML.parse(fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf-8')) as {
      embedding?: { model?: string };
      capture?: { ignore_plan_dirs_in_git?: boolean };
    };
    expect(saved.embedding?.model).toBe('nomic-embed-text');
    expect(saved.capture?.ignore_plan_dirs_in_git).toBe(true);
  });

  it('PUT scoped patch preserves unrelated sections', async () => {
    await handlePutScopedConfig(vaultDir, {
      scope: 'project',
      patch: { daemon: { log_level: 'debug' } },
    });
    const saved = YAML.parse(fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf-8')) as {
      embedding?: { model?: string };
      daemon?: { log_level?: string };
    };
    expect(saved.embedding?.model).toBe('bge-m3');
    expect(saved.daemon?.log_level).toBe('debug');
  });

  it('PUT scoped returns 400 for missing patch', async () => {
    const result = await handlePutScopedConfig(vaultDir, { scope: 'project' });
    expect(result.status).toBe(400);
  });

  it('PUT scoped returns 400 for schema-invalid patch', async () => {
    const result = await handlePutScopedConfig(vaultDir, {
      scope: 'project',
      patch: { embedding: { provider: 'invalid-provider' } },
    });
    expect(result.status).toBe(400);
  });

  it('plan dir handlers persist the gitignore toggle and run reconciliation', async () => {
    let reconciled = false;
    const handlers = createPlanDirHandlers({
      vaultDir,
      symbiontPlanDirsByAgent: {},
      symbiontPlanDirs: [],
      planWatchConfig: { watchDirs: [], projectRoot: path.dirname(vaultDir) },
      setPlanWatchConfig: () => {},
      reconcileProjectFiles: () => { reconciled = true; },
    });

    const result = await handlers.handleUpdatePlanDirs({ body: {
      plan_dirs: ['docs/design'],
      ignore_plan_dirs_in_git: true,
    } } as never);

    expect(result.status).toBeUndefined();
    expect(reconciled).toBe(true);
    expect(result.body).toMatchObject({
      custom: ['docs/design'],
      ignore_plan_dirs_in_git: true,
    });

    const saved = YAML.parse(fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf-8')) as {
      capture?: { plan_dirs?: string[]; ignore_plan_dirs_in_git?: boolean };
    };
    expect(saved.capture?.plan_dirs).toEqual(['docs/design']);
    expect(saved.capture?.ignore_plan_dirs_in_git).toBe(true);
  });
});
