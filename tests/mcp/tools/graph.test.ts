import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleMycoGraph, handleMycoOrphans } from '../../../src/mcp/tools/graph.js';
import { MycoIndex } from '../../../src/index/sqlite.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('myco_graph', () => {
  let tmpDir: string;
  let index: MycoIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-graph-'));
    index = new MycoIndex(path.join(tmpDir, 'index.db'));

    // Seed notes with wikilinks
    index.upsertNote({
      path: 'sessions/2026-03-13/session-abc.md',
      type: 'session',
      id: 'session-abc',
      title: 'Auth Refactor',
      content: '# Auth Refactor\n\nSession:: [[session-abc]]\n\n## Related Memories\n- [[gotcha-abc-123|CORS issue]]',
      frontmatter: { type: 'session', id: 'session-abc' },
      created: '2026-03-13T10:00:00Z',
    });

    index.upsertNote({
      path: 'memories/gotcha-abc-123.md',
      type: 'memory',
      id: 'gotcha-abc-123',
      title: 'CORS issue',
      content: '# CORS issue\n\nSession:: [[session-abc]]',
      frontmatter: { type: 'memory', id: 'gotcha-abc-123', session: 'session-abc' },
      created: '2026-03-13T10:05:00Z',
    });

    index.upsertNote({
      path: 'memories/decision-xyz-456.md',
      type: 'memory',
      id: 'decision-xyz-456',
      title: 'Chose RS256',
      content: '# Chose RS256\n\nNo wikilinks here.',
      frontmatter: { type: 'memory', id: 'decision-xyz-456' },
      created: '2026-03-13T10:10:00Z',
    });
  });

  afterEach(() => {
    index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds outgoing links from a note', async () => {
    const result = await handleMycoGraph(index, { note_id: 'session-abc', direction: 'outgoing' });
    expect(result.links.length).toBeGreaterThan(0);
    const targets = result.links.map((l) => l.target);
    expect(targets).toContain('gotcha-abc-123');
  });

  it('finds incoming links to a note', async () => {
    const result = await handleMycoGraph(index, { note_id: 'gotcha-abc-123', direction: 'incoming' });
    expect(result.links.length).toBeGreaterThan(0);
    const sources = result.links.map((l) => l.source);
    expect(sources).toContain('session-abc');
  });

  it('finds both directions by default', async () => {
    const result = await handleMycoGraph(index, { note_id: 'gotcha-abc-123' });
    const sources = result.links.map((l) => l.source);
    const targets = result.links.map((l) => l.target);
    // Incoming from session-abc, outgoing to session-abc
    expect(sources).toContain('session-abc');
    expect(targets).toContain('session-abc');
  });

  it('returns empty links for unknown note', async () => {
    const result = await handleMycoGraph(index, { note_id: 'nonexistent' });
    expect(result.links).toEqual([]);
  });
});

describe('myco_orphans', () => {
  let tmpDir: string;
  let index: MycoIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-orphans-'));
    index = new MycoIndex(path.join(tmpDir, 'index.db'));

    index.upsertNote({
      path: 'sessions/session-abc.md',
      type: 'session',
      id: 'session-abc',
      title: 'Connected Session',
      content: '# Connected\n\n- [[gotcha-abc|CORS]]',
      frontmatter: { type: 'session', id: 'session-abc' },
      created: '2026-03-13T10:00:00Z',
    });

    index.upsertNote({
      path: 'memories/gotcha-abc.md',
      type: 'memory',
      id: 'gotcha-abc',
      title: 'CORS',
      content: '# CORS\n\nSession:: [[session-abc]]',
      frontmatter: { type: 'memory', id: 'gotcha-abc', session: 'session-abc' },
      created: '2026-03-13T10:05:00Z',
    });

    index.upsertNote({
      path: 'memories/orphan-note.md',
      type: 'memory',
      id: 'orphan-note',
      title: 'Orphan',
      content: '# Orphan\n\nNo links at all.',
      frontmatter: { type: 'memory', id: 'orphan-note' },
      created: '2026-03-13T10:10:00Z',
    });
  });

  afterEach(() => {
    index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('identifies orphan notes', async () => {
    const result = await handleMycoOrphans(index);
    const orphanIds = result.orphans.map((o) => o.id);
    expect(orphanIds).toContain('orphan-note');
    expect(orphanIds).not.toContain('session-abc');
    expect(orphanIds).not.toContain('gotcha-abc');
  });
});
