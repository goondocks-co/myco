/**
 * The preview a run's session page carries: cut on a word boundary, and never
 * naming a tool 1.4 retired. A summary that still says `myco_remember` would
 * teach a run to call a tool no surface serves.
 */
import { describe, expect, it } from 'bun:test';
import { CONTENT_PREVIEW_MAX_CHARS, preview, RETIRED_TOOL_NAMES, RETIRED_TOOL_PLACEHOLDER } from '@myco-server-worker/core/run-material.js';

describe('the preview a run\'s page carries', () => {
  it('keeps a short body whole and cuts a long one on a word boundary', () => {
    expect(preview('short body')).toBe('short body');
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const cut = preview(long)!;
    expect(cut.length).toBeLessThanOrEqual(CONTENT_PREVIEW_MAX_CHARS + 1);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.slice(0, -1).endsWith(' ')).toBe(false);
    expect(preview('abcdef ghij', 8)).toBe('abcdef…');
  });

  it('rewrites every retired tool name rather than teaching it onward', () => {
    expect(preview('call myco_remember to save that')).toBe(`call ${RETIRED_TOOL_PLACEHOLDER} to save that`);
    for (const name of RETIRED_TOOL_NAMES) expect(preview(`use ${name} here`)).toBe(`use ${RETIRED_TOOL_PLACEHOLDER} here`);
    expect(preview('see myco_recall() for it')).toBe(`see ${RETIRED_TOOL_PLACEHOLDER} for it`);
  });

  it('answers nothing for an absent or empty body', () => {
    expect(preview(null)).toBeNull();
    expect(preview('')).toBeNull();
  });
});
