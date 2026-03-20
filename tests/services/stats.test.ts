import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gatherStats } from '@myco/services/stats';
import { MycoIndex } from '@myco/index/sqlite';
import { initFts } from '@myco/index/fts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('gatherStats', () => {
  let vaultDir: string;
  let index: MycoIndex;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stats-'));
    fs.mkdirSync(path.join(vaultDir, 'spores', 'gotcha'), { recursive: true });
    index = new MycoIndex(path.join(vaultDir, 'index.db'));
    initFts(index);
  });

  afterEach(() => {
    index.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('returns vault stats with zero counts for empty vault', () => {
    const stats = gatherStats(vaultDir, index);
    expect(stats.vault.session_count).toBe(0);
    expect(stats.vault.spore_counts).toEqual({});
    expect(stats.index.fts_entries).toBe(0);
  });
});

describe('MycoIndex aggregation methods', () => {
  let vaultDir: string;
  let index: MycoIndex;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-index-agg-'));
    index = new MycoIndex(path.join(vaultDir, 'index.db'));
  });

  afterEach(() => {
    index.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('countByType returns correct counts after indexing notes', () => {
    index.upsertNote({ path: 'sessions/s1.md', type: 'session', id: 's1', title: 'S1', content: '', frontmatter: {}, created: '2024-01-01T00:00:00Z' });
    index.upsertNote({ path: 'sessions/s2.md', type: 'session', id: 's2', title: 'S2', content: '', frontmatter: {}, created: '2024-01-02T00:00:00Z' });
    index.upsertNote({ path: 'spores/gotcha/g1.md', type: 'spore', id: 'g1', title: 'G1', content: '', frontmatter: { observation_type: 'gotcha' }, created: '2024-01-01T00:00:00Z' });
    index.upsertNote({ path: 'plans/p1.md', type: 'plan', id: 'p1', title: 'P1', content: '', frontmatter: {}, created: '2024-01-01T00:00:00Z' });

    const counts = index.countByType();
    expect(counts['session']).toBe(2);
    expect(counts['spore']).toBe(1);
    expect(counts['plan']).toBe(1);
  });

  it('sporeCountsByObservationType aggregates spores correctly', () => {
    index.upsertNote({ path: 'spores/gotcha/g1.md', type: 'spore', id: 'g1', title: 'G1', content: '', frontmatter: { observation_type: 'gotcha' }, created: '2024-01-01T00:00:00Z' });
    index.upsertNote({ path: 'spores/gotcha/g2.md', type: 'spore', id: 'g2', title: 'G2', content: '', frontmatter: { observation_type: 'gotcha' }, created: '2024-01-02T00:00:00Z' });
    index.upsertNote({ path: 'spores/decision/d1.md', type: 'spore', id: 'd1', title: 'D1', content: '', frontmatter: { observation_type: 'decision' }, created: '2024-01-01T00:00:00Z' });

    const sporeCounts = index.sporeCountsByObservationType();
    expect(sporeCounts['gotcha']).toBe(2);
    expect(sporeCounts['decision']).toBe(1);
  });

  it('countByType returns empty object for empty index', () => {
    expect(index.countByType()).toEqual({});
  });

  it('sporeCountsByObservationType returns empty object when no spores', () => {
    expect(index.sporeCountsByObservationType()).toEqual({});
  });
});
