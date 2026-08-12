import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectBuffers } from '@myco/capture/diagnostics/collect-buffers.js';

const PROSE = 'BUFFER_PROSE_planted';

function makeHome(): { home: string; bufDir: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'myco-home-'));
  const bufDir = path.join(home, 'groves', 'g1', 'projects', 'p1', 'buffer');
  mkdirSync(path.join(bufDir, 'quarantine'), { recursive: true });
  return { home, bufDir };
}

describe('collectBuffers', () => {
  test('collects live and quarantined buffers; notes absent ones', () => {
    const { home, bufDir } = makeHome();
    writeFileSync(path.join(bufDir, 'sessA.jsonl'), '{"e":1}\n');
    writeFileSync(path.join(bufDir, 'quarantine', 'sessB.jsonl'), '{"e":2}\n');

    const res = collectBuffers({
      groveId: 'g1',
      mycoHome: home,
      sessionIdsInWindow: ['sessA', 'sessB', 'sessC'],
      includeContent: false,
    });
    const paths = res.files.map((f) => f.path);
    expect(paths).toContain('buffers/p1/sessA.jsonl');
    expect(paths).toContain('buffers/p1/quarantine/sessB.jsonl');
    expect(res.notes.join('\n')).toContain('sessC');
  });

  test('skeletonizes buffer lines by default; verbatim only with includeContent', () => {
    const { home, bufDir } = makeHome();
    const line = JSON.stringify({
      event_type: 'prompt',
      timestamp: '2026-08-12T00:00:00Z',
      session_id: 'sessA',
      text: PROSE,
    });
    writeFileSync(path.join(bufDir, 'sessA.jsonl'), line + '\n');

    const skeletonized = collectBuffers({
      groveId: 'g1',
      mycoHome: home,
      sessionIdsInWindow: ['sessA'],
      includeContent: false,
    });
    const skelFile = skeletonized.files.find((f) => f.path === 'buffers/p1/sessA.jsonl');
    expect(skelFile).toBeDefined();
    expect(String(skelFile!.data)).not.toContain(PROSE);
    expect(String(skelFile!.data)).toContain('event_type');
    expect(String(skelFile!.data)).toContain('content_hash');

    const verbatim = collectBuffers({
      groveId: 'g1',
      mycoHome: home,
      sessionIdsInWindow: ['sessA'],
      includeContent: true,
    });
    const fullFile = verbatim.files.find((f) => f.path === 'buffers/p1/sessA.jsonl');
    expect(fullFile).toBeDefined();
    expect(String(fullFile!.data)).toContain(PROSE);
  });

  test('a live buffer outside the window is not collected', () => {
    const { home, bufDir } = makeHome();
    writeFileSync(path.join(bufDir, 'sessA.jsonl'), '{"e":1}\n');
    writeFileSync(path.join(bufDir, 'sessOutside.jsonl'), '{"e":2}\n');

    const res = collectBuffers({
      groveId: 'g1',
      mycoHome: home,
      sessionIdsInWindow: ['sessA'],
      includeContent: false,
    });
    const paths = res.files.map((f) => f.path);
    expect(paths).toContain('buffers/p1/sessA.jsonl');
    expect(paths).not.toContain('buffers/p1/sessOutside.jsonl');
  });

  test('quarantine is collected in full regardless of window', () => {
    const { home, bufDir } = makeHome();
    writeFileSync(path.join(bufDir, 'quarantine', 'notInWindow.jsonl'), '{"e":3}\n');

    const res = collectBuffers({
      groveId: 'g1',
      mycoHome: home,
      sessionIdsInWindow: [],
      includeContent: false,
    });
    expect(res.files.map((f) => f.path)).toContain('buffers/p1/quarantine/notInWindow.jsonl');
  });

  test('tolerates missing grove/projects directory', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'myco-home-'));
    const res = collectBuffers({
      groveId: 'ghost',
      mycoHome: home,
      sessionIdsInWindow: ['sessA'],
      includeContent: false,
    });
    expect(res.files).toEqual([]);
    expect(res.notes.some((n) => n.includes('sessA'))).toBe(true);
  });
});
