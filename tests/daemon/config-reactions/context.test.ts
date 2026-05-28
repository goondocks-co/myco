import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadReactionContext } from '@myco/daemon/config-reactions/context.js';

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('loadReactionContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-reaction-context-'));
    fs.writeFileSync(
      path.join(tmpDir, 'myco.yaml'),
      'version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nnotifications:\n  enabled: true\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns merged config when project and local config are valid', () => {
    fs.writeFileSync(path.join(tmpDir, 'local.yaml'), 'notifications:\n  enabled: false\n');
    const logger = makeLogger();
    const ctx = loadReactionContext(tmpDir, logger);
    expect(ctx?.notifications.enabled).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns null and warns when merged config is invalid', () => {
    fs.writeFileSync(path.join(tmpDir, 'local.yaml'), 'daemon:\n  log_level: verbose\n');
    const logger = makeLogger();
    const ctx = loadReactionContext(tmpDir, logger);
    expect(ctx).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'config-reactions',
      expect.stringContaining('skipping reactions'),
      expect.objectContaining({ issues: expect.any(Array) }),
    );
  });
});
