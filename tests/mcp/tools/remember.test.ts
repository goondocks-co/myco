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

  it('creates a spore note and indexes it', async () => {
    const result = await handleMycoRemember(tmpDir, index, {
      content: 'CORS proxy strips auth headers',
      type: 'gotcha',
      tags: ['cors', 'auth'],
    });

    expect(result.note_path).toContain('spores/');
    expect(result.id).toContain('gotcha-');

    // Verify it was indexed
    const note = index.getNoteByPath(result.note_path);
    expect(note).toBeTruthy();
    expect(note!.type).toBe('spore');
  });

  it('links to a related plan', async () => {
    const result = await handleMycoRemember(tmpDir, index, {
      content: 'Decision: use RS256',
      type: 'decision',
      related_plan: 'auth-redesign',
    });

    const note = index.getNoteByPath(result.note_path);
    expect((note!.frontmatter as any).plan).toBe('auth-redesign');
  });

  it('uses explicit session when provided', async () => {
    const result = await handleMycoRemember(tmpDir, index, {
      content: 'Explicit session test',
      type: 'discovery',
      session: 'sess-explicit',
    });

    expect(result.session).toBe('sess-explicit');
    const note = index.getNoteByPath(result.note_path);
    expect((note!.frontmatter as any).session).toContain('sess-explicit');
  });

  it('auto-resolves session from most recent buffer file', async () => {
    const bufferDir = path.join(tmpDir, 'buffer');
    fs.mkdirSync(bufferDir);

    // Older buffer
    fs.writeFileSync(path.join(bufferDir, 'old-session.jsonl'), '{}');
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(bufferDir, 'old-session.jsonl'), past, past);

    // Most recent buffer — the calling session
    fs.writeFileSync(path.join(bufferDir, 'active-session.jsonl'), '{}');

    const result = await handleMycoRemember(tmpDir, index, {
      content: 'Auto-resolved session',
      type: 'gotcha',
    });

    expect(result.session).toBe('active-session');
    const note = index.getNoteByPath(result.note_path);
    expect((note!.frontmatter as any).session).toContain('active-session');
  });

  it('prefers explicit session over buffer heuristic', async () => {
    const bufferDir = path.join(tmpDir, 'buffer');
    fs.mkdirSync(bufferDir);
    fs.writeFileSync(path.join(bufferDir, 'buffer-session.jsonl'), '{}');

    const result = await handleMycoRemember(tmpDir, index, {
      content: 'Explicit wins',
      type: 'decision',
      session: 'explicit-session',
    });

    expect(result.session).toBe('explicit-session');
  });

  it('handles missing buffer directory gracefully', async () => {
    const result = await handleMycoRemember(tmpDir, index, {
      content: 'No buffer dir',
      type: 'gotcha',
    });

    expect(result.session).toBeUndefined();
    expect(result.note_path).toContain('spores/');
  });
});
