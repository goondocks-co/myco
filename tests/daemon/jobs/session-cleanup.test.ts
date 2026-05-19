import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanupAfterSessionCascade } from '@myco/daemon/jobs/session-cleanup.js';
import type { DeleteCascadeResult } from '@myco/db/queries/sessions.js';

// Stub that satisfies the slice of EmbeddingManager cleanupAfterSessionCascade
// reaches into. The real one is heavier and unrelated to what we're testing.
function makeEmbeddingStub() {
  return { onRemoved: vi.fn() } as unknown as Parameters<typeof cleanupAfterSessionCascade>[2];
}

function emptyResult(): DeleteCascadeResult {
  return {
    deleted: true,
    counts: {} as never,
    deletedSporeIds: [],
    deletedAttachmentPaths: [],
  } as unknown as DeleteCascadeResult;
}

describe('cleanupAfterSessionCascade — buffer journal unlink', () => {
  let vaultDir: string;
  let bufferDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-cascade-'));
    bufferDir = path.join(vaultDir, 'buffer');
    fs.mkdirSync(bufferDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  // Cascade-delete is the user's explicit "this session is gone" intent,
  // so the buffer journal is removed alongside the DB rows. Leaving it
  // behind lets a same-id reload resurrect stale events at reconcile.
  it('unlinks <vaultDir>/buffer/<sessionId>.jsonl when present', async () => {
    const sessionId = 'cascade-buf-001';
    const bufferPath = path.join(bufferDir, `${sessionId}.jsonl`);
    fs.writeFileSync(bufferPath, '{"type":"user_prompt","prompt":"hi","timestamp":"2026-05-18T00:00:00Z"}\n');
    expect(fs.existsSync(bufferPath)).toBe(true);

    await cleanupAfterSessionCascade(sessionId, emptyResult(), makeEmbeddingStub(), vaultDir);

    expect(fs.existsSync(bufferPath)).toBe(false);
  });

  it('is a no-op when no buffer file exists (best-effort)', async () => {
    const sessionId = 'cascade-buf-002';
    // No buffer file written. Should not throw.
    await expect(
      cleanupAfterSessionCascade(sessionId, emptyResult(), makeEmbeddingStub(), vaultDir),
    ).resolves.toBeUndefined();
  });

  it('leaves other sessions\' buffer files untouched', async () => {
    const targetId = 'cascade-buf-003';
    const survivorId = 'survivor-buf-004';
    const targetPath = path.join(bufferDir, `${targetId}.jsonl`);
    const survivorPath = path.join(bufferDir, `${survivorId}.jsonl`);
    fs.writeFileSync(targetPath, '{"type":"user_prompt","prompt":"x","timestamp":"2026-05-18T00:00:00Z"}\n');
    fs.writeFileSync(survivorPath, '{"type":"user_prompt","prompt":"y","timestamp":"2026-05-18T00:00:00Z"}\n');

    await cleanupAfterSessionCascade(targetId, emptyResult(), makeEmbeddingStub(), vaultDir);

    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.existsSync(survivorPath)).toBe(true);
  });
});
