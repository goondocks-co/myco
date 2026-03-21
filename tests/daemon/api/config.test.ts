import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleGetConfig, handlePutConfig } from '@myco/daemon/api/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

describe('config API', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-api-'));
    const config = { version: 2, intelligence: { llm: { provider: 'ollama', model: 'test' } } };
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('GET returns parsed config', async () => {
    const result = await handleGetConfig(vaultDir);
    expect(result.body).toHaveProperty('version', 2);
  });

  it('PUT validates and saves config', async () => {
    const newConfig = { version: 2, intelligence: { llm: { provider: 'ollama', model: 'new-model' } } };
    const result = await handlePutConfig(vaultDir, newConfig);
    expect(result.status).toBeUndefined(); // 200 default
  });

  it('PUT returns 400 for invalid config', async () => {
    const invalid = { version: 2, intelligence: { llm: { provider: 'invalid-provider' } } };
    const result = await handlePutConfig(vaultDir, invalid);
    expect(result.status).toBe(400);
  });
});
