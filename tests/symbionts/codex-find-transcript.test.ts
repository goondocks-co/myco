import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findCodexTranscript } from '@myco/symbionts/codex.js';

describe('findCodexTranscript', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-transcript-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds transcript in nested YYYY/MM/DD directory with rollout prefix', () => {
    const sessionId = '019d839a-0c22-7072-97fa-3d1b16910b0d';
    const dateDir = path.join(tmpDir, 'sessions', '2026', '04', '12');
    fs.mkdirSync(dateDir, { recursive: true });
    const filename = `rollout-2026-04-12T17-30-04-${sessionId}.jsonl`;
    fs.writeFileSync(path.join(dateDir, filename), '{}');

    const result = findCodexTranscript(tmpDir, sessionId);

    expect(result).toBe(path.join(dateDir, filename));
  });

  it('returns null when session ID not found', () => {
    const result = findCodexTranscript(tmpDir, 'nonexistent-session-id');
    expect(result).toBeNull();
  });

  it('finds transcript across different date directories', () => {
    const sessionId = 'abc-123-def';
    const dateDir = path.join(tmpDir, 'sessions', '2026', '03', '28');
    fs.mkdirSync(dateDir, { recursive: true });
    const filename = `rollout-2026-03-28T09-15-00-${sessionId}.jsonl`;
    fs.writeFileSync(path.join(dateDir, filename), '{}');

    const result = findCodexTranscript(tmpDir, sessionId);

    expect(result).toBe(path.join(dateDir, filename));
  });

  it('returns null when sessions directory does not exist', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-empty-'));
    try {
      const result = findCodexTranscript(emptyDir, 'some-session');
      expect(result).toBeNull();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
