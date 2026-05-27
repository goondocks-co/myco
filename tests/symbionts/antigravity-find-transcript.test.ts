import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  findAntigravityTranscript,
  ANTIGRAVITY_SURFACE_DIRS,
} from '@myco/symbionts/antigravity.js';

describe('findAntigravityTranscript', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-transcript-test-'));
  });
  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  /** Place a fake transcript file under one of the surface brain dirs. */
  function plant(surface: typeof ANTIGRAVITY_SURFACE_DIRS[number], conversationId: string, content = '{}'): string {
    const dir = path.join(baseDir, surface, 'brain', conversationId, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, 'transcript_full.jsonl');
    fs.writeFileSync(transcript, content, 'utf-8');
    return transcript;
  }

  it('finds a transcript planted under antigravity-cli/', () => {
    const id = '85774e9a-997d-4d75-ae7a-b1a688bb3863';
    const transcript = plant('antigravity-cli', id);
    expect(findAntigravityTranscript(baseDir, id)).toBe(transcript);
  });

  it('finds a transcript planted under antigravity/ (desktop)', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const transcript = plant('antigravity', id);
    expect(findAntigravityTranscript(baseDir, id)).toBe(transcript);
  });

  it('finds a transcript planted under antigravity-ide/', () => {
    const id = 'ffffffff-1111-2222-3333-444444444444';
    const transcript = plant('antigravity-ide', id);
    expect(findAntigravityTranscript(baseDir, id)).toBe(transcript);
  });

  it('returns null when the conversationId has no transcript on any surface', () => {
    expect(findAntigravityTranscript(baseDir, 'no-such-conversation')).toBeNull();
  });

  it('returns null on an empty conversationId rather than scanning surfaces', () => {
    expect(findAntigravityTranscript(baseDir, '')).toBeNull();
  });

  it('prefers the first surface in ANTIGRAVITY_SURFACE_DIRS when the same ID exists in multiple', () => {
    const id = 'shared-id-edge-case';
    const cliPath = plant('antigravity-cli', id, '{"source":"cli"}');
    plant('antigravity', id, '{"source":"app"}');
    expect(findAntigravityTranscript(baseDir, id)).toBe(cliPath);
  });
});
