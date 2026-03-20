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
