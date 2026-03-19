import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeObservationNotes } from '@myco/vault/observations';
import { VaultWriter } from '@myco/vault/writer';
import { VaultReader } from '@myco/vault/reader';
import { MycoIndex } from '@myco/index/sqlite';
import { initFts } from '@myco/index/fts';
import type { Observation } from '@myco/daemon/processor';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('writeObservationNotes', () => {
  let vaultDir: string;
  let writer: VaultWriter;
  let reader: VaultReader;
  let index: MycoIndex;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-obs-'));
    writer = new VaultWriter(vaultDir);
    reader = new VaultReader(vaultDir);
    index = new MycoIndex(path.join(vaultDir, 'index.db'));
    initFts(index);
  });

  afterEach(() => {
    index.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('writes observation notes and returns paths', () => {
    const observations: Observation[] = [
      { type: 'gotcha', title: 'CORS Issue', content: 'Proxy strips headers.', tags: ['cors'] },
    ];

    const results = writeObservationNotes(observations, 'test-session', writer, index, vaultDir);

    expect(results).toHaveLength(1);
    expect(results[0].path).toContain('spores/gotcha/');
    expect(results[0].path).toContain('.md');

    const note = reader.readNote(results[0].path);
    expect(note.frontmatter.type).toBe('spore');
    expect(note.content).toContain('CORS Issue');
  });

  it('writes multiple observations', () => {
    const observations: Observation[] = [
      { type: 'decision', title: 'Choice A', content: 'Picked A.', tags: [] },
      { type: 'bug_fix', title: 'Fix B', content: 'Fixed B.', tags: [], root_cause: 'null ref', fix: 'added check' },
    ];

    const results = writeObservationNotes(observations, 's1', writer, index, vaultDir);
    expect(results).toHaveLength(2);
  });

  it('returns empty array for no observations', () => {
    const results = writeObservationNotes([], 's1', writer, index, vaultDir);
    expect(results).toHaveLength(0);
  });
});
