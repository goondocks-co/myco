import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleMycoRemember } from '@myco/mcp/tools/remember';
import { MycoIndex } from '@myco/index/sqlite';
import { initFts } from '@myco/index/fts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('myco_remember', () => {
  let tmpDir: string;
  let index: MycoIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-remember-'));
    index = new MycoIndex(path.join(tmpDir, 'index.db'));
    initFts(index);
  });

  afterEach(() => {
    index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a memory note and indexes it', async () => {
    const result = await handleMycoRemember(tmpDir, index, {
      content: 'CORS proxy strips auth headers',
      type: 'gotcha',
      tags: ['cors', 'auth'],
    });

    expect(result.note_path).toContain('memories/');
    expect(result.id).toContain('gotcha-');

    // Verify it was indexed
    const note = index.getNoteByPath(result.note_path);
    expect(note).toBeTruthy();
    expect(note!.type).toBe('memory');
  });

  it('links to a related plan', async () => {
    const result = await handleMycoRemember(tmpDir, index, {
      content: 'Decision: use RS256',
      type: 'decision',
      related_plan: 'auth-redesign',
    });

    const note = index.getNoteByPath(result.note_path);
    expect((note!.frontmatter as any).plan).toBe('[[auth-redesign]]');
  });
});
