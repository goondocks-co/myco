import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VectorIndex } from '@myco/index/vectors';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('VectorIndex', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-vec-'));
    dbPath = path.join(tmpDir, 'vectors.db');
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('stores and retrieves embeddings', () => {
    const idx = new VectorIndex(dbPath, 3);
    idx.upsert('mem-1', [0.1, 0.2, 0.3], { type: 'memory', importance: 'high' });

    const results = idx.search([0.1, 0.2, 0.3], { limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('mem-1');
    expect(results[0].similarity).toBeGreaterThan(0.9);
    idx.close();
  });

  it('filters by metadata type', () => {
    const idx = new VectorIndex(dbPath, 3);
    idx.upsert('mem-1', [0.1, 0.2, 0.3], { type: 'memory' });
    idx.upsert('sess-1', [0.1, 0.2, 0.3], { type: 'session' });

    const results = idx.search([0.1, 0.2, 0.3], { limit: 5, type: 'memory' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('mem-1');
    idx.close();
  });

  it('applies relative threshold', () => {
    const idx = new VectorIndex(dbPath, 3);
    idx.upsert('close', [0.9, 0.1, 0.0], { type: 'memory' });
    idx.upsert('far', [0.0, 0.0, 1.0], { type: 'memory' });

    // With a high relative threshold, only results near the top score survive
    const results = idx.search([1.0, 0.0, 0.0], { limit: 5, relativeThreshold: 0.8 });
    expect(results.length).toBeGreaterThan(0);
    const topScore = results[0].similarity;
    expect(results.every((r) => r.similarity >= topScore * 0.8)).toBe(true);
    idx.close();
  });

  it('upserts existing id', () => {
    const idx = new VectorIndex(dbPath, 3);
    idx.upsert('mem-1', [0.1, 0.2, 0.3], { type: 'memory' });
    idx.upsert('mem-1', [0.4, 0.5, 0.6], { type: 'memory' });

    expect(idx.count()).toBe(1);
    idx.close();
  });
});
