import { describe, it, expect } from 'bun:test';
import type { CanopyEntry } from '@myco/db/schema';
import { blobTokenCost, composeBlob } from '@myco/canopy/inject/compose';

function makeEntry(overrides: Partial<CanopyEntry> = {}): CanopyEntry {
  return {
    project_id: '/repo',
    machine_id: 'local',
    path: 'packages/myco/src/hooks/session-start.ts',
    content_hash: 'a'.repeat(64),
    size_bytes: 4096,
    token_estimate: 340,
    line_count: 87,
    language: 'typescript',
    exports_json: JSON.stringify(['handleSessionStart', 'SessionStartPayload']),
    imports_json: JSON.stringify(['./capture/buffer', './symbionts/adapter']),
    top_comment: 'Handles SessionStart lifecycle events; writes initial session row.',
    mechanical_updated_at: 1700000000,
    llm_description: null,
    llm_updated_at: null,
    ...overrides,
  };
}

describe('composeBlob — Tier 1 (mechanical only)', () => {
  it('emits the canopy header line with path, token estimate, line count', () => {
    const blob = composeBlob(makeEntry());
    expect(blob.split('\n')[0]).toBe(
      '[canopy] packages/myco/src/hooks/session-start.ts — 340 tok, 87 lines',
    );
  });

  it('renders exports and imports lists', () => {
    const blob = composeBlob(makeEntry());
    expect(blob).toContain('  exports: handleSessionStart, SessionStartPayload');
    expect(blob).toContain('  imports: ./capture/buffer, ./symbionts/adapter');
  });

  it('renders top comment as `top` when llm_description is null', () => {
    const blob = composeBlob(makeEntry());
    expect(blob).toContain('  top: "Handles SessionStart lifecycle events; writes initial session row."');
  });

  it('uses the anatomy-only [meta] line when no summary is present', () => {
    const blob = composeBlob(makeEntry());
    expect(blob).toContain('[meta] File anatomy from Myco.');
    expect(blob).not.toContain('File summary from Myco');
  });
});

describe('composeBlob — Tier 2 (with llm_description)', () => {
  it('renders summary in place of top when present', () => {
    const blob = composeBlob(
      makeEntry({ llm_description: 'SessionStart hook handler that persists the session.' }),
    );
    expect(blob).toContain('  summary: "SessionStart hook handler that persists the session."');
    expect(blob).not.toContain('  top:');
  });

  it('uses the summary [meta] line when summary is present', () => {
    const blob = composeBlob(makeEntry({ llm_description: 'A summary.' }));
    expect(blob).toContain('[meta] File summary from Myco.');
    expect(blob).not.toContain('File anatomy from Myco');
  });
});

describe('composeBlob — missing fields', () => {
  it('omits the exports line when exports_json is null', () => {
    const blob = composeBlob(makeEntry({ exports_json: null }));
    expect(blob).not.toContain('exports:');
  });

  it('omits the imports line when imports_json is null', () => {
    const blob = composeBlob(makeEntry({ imports_json: null }));
    expect(blob).not.toContain('imports:');
  });

  it('omits the top line when top_comment is null and no summary', () => {
    const blob = composeBlob(makeEntry({ top_comment: null }));
    expect(blob).not.toContain('  top:');
    expect(blob).not.toContain('  summary:');
  });

  it('survives malformed exports_json by treating it as empty', () => {
    const blob = composeBlob(makeEntry({ exports_json: '{not json' }));
    expect(blob).not.toContain('exports:');
  });
});

describe('composeBlob — safety cap', () => {
  it('keeps small blobs intact', () => {
    const blob = composeBlob(makeEntry());
    expect(blob.length).toBeLessThan(800);
  });

  it('truncates long summaries first', () => {
    const longSummary = 'A'.repeat(500);
    const blob = composeBlob(makeEntry({ llm_description: longSummary }));
    expect(blob.length).toBeLessThanOrEqual(800);
    expect(blob).toContain('[canopy]');
    expect(blob).toContain('[meta]');
  });

  it('preserves structural [canopy] and [meta] lines under truncation', () => {
    const longTop = 'X'.repeat(2000);
    const manyExports = Array.from({ length: 50 }, (_, i) => `export${i}`);
    const manyImports = Array.from({ length: 30 }, (_, i) => `./module${i}`);
    const blob = composeBlob(
      makeEntry({
        top_comment: longTop,
        exports_json: JSON.stringify(manyExports),
        imports_json: JSON.stringify(manyImports),
      }),
    );
    expect(blob.startsWith('[canopy] ')).toBe(true);
    expect(blob.split('\n').at(-1)?.startsWith('[meta] ')).toBe(true);
    expect(blob.length).toBeLessThanOrEqual(800);
  });
});

describe('blobTokenCost', () => {
  it('uses the 4 chars/token heuristic', () => {
    expect(blobTokenCost('a'.repeat(40))).toBe(10);
  });

  it('rounds up partial tokens', () => {
    expect(blobTokenCost('a'.repeat(41))).toBe(11);
  });
});
