import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MycoIndex } from '@myco/index/sqlite';
import { initFts } from '@myco/index/fts';
import { rebuildIndex, indexNote } from '@myco/index/rebuild';
import { VaultWriter } from '@myco/vault/writer';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Index Rebuild', () => {
  let tmpDir: string;
  let vaultDir: string;
  let index: MycoIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rebuild-'));
    vaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    index = new MycoIndex(path.join(vaultDir, 'index.db'));
    initFts(index);
  });

  afterEach(() => {
    index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes a single note', () => {
    const writer = new VaultWriter(vaultDir);
    const notePath = writer.writeSession({
      id: 'abc', agent: 'claude-code', user: 'chris',
      started: '2026-03-12T09:00:00Z', summary: '# Session\n\nDid things.',
    });

    indexNote(index, vaultDir, notePath);
    const note = index.getNoteByPath(notePath);
    expect(note).toBeTruthy();
    expect(note!.type).toBe('session');
  });

  it('rebuilds full index from vault', () => {
    const writer = new VaultWriter(vaultDir);
    writer.writeSession({
      id: 's1', agent: 'claude-code', user: 'chris',
      started: '2026-03-12T09:00:00Z', summary: '# S1',
    });
    writer.writeSession({
      id: 's2', agent: 'claude-code', user: 'chris',
      started: '2026-03-12T10:00:00Z', summary: '# S2',
    });
    writer.writePlan({ id: 'p1', content: '# Plan' });
    writer.writeMemory({
      id: 'm1', observation_type: 'gotcha',
      content: '# Gotcha',
    });

    const count = rebuildIndex(index, vaultDir);
    expect(count).toBe(4);

    const sessions = index.query({ type: 'session' });
    expect(sessions).toHaveLength(2);
  });

  it('handles empty vault', () => {
    const count = rebuildIndex(index, vaultDir);
    expect(count).toBe(0);
  });

  it('clears existing index before rebuild', () => {
    index.upsertNote({
      path: 'old/stale.md', type: 'session', id: 'stale',
      title: 'Stale', content: '', frontmatter: {}, created: '2026-01-01T00:00:00Z',
    });

    rebuildIndex(index, vaultDir);
    expect(index.getNoteByPath('old/stale.md')).toBeNull();
  });
});
