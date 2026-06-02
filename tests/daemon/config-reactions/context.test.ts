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
    // The project tier (`myco.yaml`) only contributes leaves it OWNS under the
    // scope-aware prune. `cortex.enabled` is project-home, so it survives and
    // gives the merge a real project-tier value to carry through. The
    // `embedding.model` below is grove-home, so the prune DROPS it from the
    // project tier — it's a negative control proving project-tier pruning (see
    // the first test). Notification enablement is machine-home (+ local
    // override), so it deliberately lives nowhere in this project file.
    fs.writeFileSync(
      path.join(tmpDir, 'myco.yaml'),
      'version: 3\ncortex:\n  enabled: false\nembedding:\n  provider: ollama\n  model: project-tier-debris\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges the machine default under the local override and keeps project-owned leaves', () => {
    fs.writeFileSync(path.join(tmpDir, 'local.yaml'), 'notifications:\n  enabled: false\n');
    const logger = makeLogger();
    const ctx = loadReactionContext(tmpDir, logger);

    // Machine default (notifications enabled) overridden by the local/Personal
    // tier — the project file says nothing about enablement.
    expect(ctx?.notifications.enabled).toBe(false);
    // Project-owned leaf survives the prune and carries through the merge.
    expect(ctx?.cortex.enabled).toBe(false);
    // Negative control: `embedding` is grove-home, so the project tier's
    // `project-tier-debris` model is pruned and never reaches the merge — the
    // grove-default `bge-m3` stands.
    expect(ctx?.embedding.model).toBe('bge-m3');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns null and warns when merged config is invalid', () => {
    // `agent` is grove-home + local-overridable, so the scope-aware prune keeps
    // `agent.reasoningLevel` in the LOCAL tier. `bogus` is outside the
    // low|default|high enum, so the merged config genuinely fails to parse.
    fs.writeFileSync(path.join(tmpDir, 'local.yaml'), 'agent:\n  reasoningLevel: bogus\n');
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
