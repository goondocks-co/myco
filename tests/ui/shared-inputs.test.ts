/**
 * Unit tests for `shared-inputs.ts` — the shared helper for extracting
 * recognized input identifiers (session_id / batch_id / target_session) and
 * template-variable names from instruction and prompt text.
 *
 * Covers the two consumers' needs in one place:
 *  - `detectSharedInputs` in `evaluation-helpers.ts` (summarizes whether
 *    multiple runs targeted the same input).
 *  - `buildRerunPrefill` in `rerun-prefill.ts` (re-populates per-var inputs
 *    when rerunning a run).
 */

import { describe, expect, it } from 'vitest';
import {
  SHARED_INPUT_KEYS,
  SHARED_INPUT_PATTERN,
  extractSharedInputs,
  extractTemplateVars,
} from '../../packages/myco/ui/src/components/agent/shared-inputs';

describe('SHARED_INPUT_KEYS', () => {
  it('includes the three canonical keys', () => {
    expect(SHARED_INPUT_KEYS).toEqual(['session_id', 'batch_id', 'target_session']);
  });
});

describe('SHARED_INPUT_PATTERN', () => {
  it('is a global+case-insensitive regex', () => {
    expect(SHARED_INPUT_PATTERN.global).toBe(true);
    expect(SHARED_INPUT_PATTERN.ignoreCase).toBe(true);
  });
});

describe('extractSharedInputs', () => {
  it('returns empty object on null/undefined/empty input', () => {
    expect(extractSharedInputs(null)).toEqual({});
    expect(extractSharedInputs(undefined)).toEqual({});
    expect(extractSharedInputs('')).toEqual({});
  });

  it('extracts colon-separated unquoted values', () => {
    expect(extractSharedInputs('session_id: abc-123')).toEqual({
      session_id: 'abc-123',
    });
  });

  it('extracts equals-separated unquoted values', () => {
    expect(extractSharedInputs('batch_id=batch-7')).toEqual({
      batch_id: 'batch-7',
    });
  });

  it('extracts double-quoted values', () => {
    expect(extractSharedInputs('session_id: "abc 123"')).toEqual({
      session_id: 'abc 123',
    });
  });

  it('extracts single-quoted values', () => {
    expect(extractSharedInputs("target_session = 'sess-xyz'")).toEqual({
      target_session: 'sess-xyz',
    });
  });

  it('extracts multiple keys from the same instruction', () => {
    const out = extractSharedInputs('batch_id=b1\nsession_id: s2');
    expect(out).toEqual({ batch_id: 'b1', session_id: 's2' });
  });

  it('is case-insensitive on the key', () => {
    expect(extractSharedInputs('SESSION_ID: Mixed-Case')).toEqual({
      session_id: 'Mixed-Case',
    });
  });

  it('first occurrence wins when a key appears twice', () => {
    expect(extractSharedInputs('session_id: first\nsession_id: second')).toEqual({
      session_id: 'first',
    });
  });

  it('ignores keys outside the recognized set', () => {
    expect(extractSharedInputs('user_id: u1\nsession_id: s1')).toEqual({
      session_id: 's1',
    });
  });

  it('supports embedded values alongside prose', () => {
    const body = 'Please process session_id: abc-123 and return the summary.';
    expect(extractSharedInputs(body)).toEqual({ session_id: 'abc-123' });
  });
});

describe('extractTemplateVars', () => {
  it('returns empty array on null/undefined/empty prompt', () => {
    expect(extractTemplateVars(null)).toEqual([]);
    expect(extractTemplateVars(undefined)).toEqual([]);
    expect(extractTemplateVars('')).toEqual([]);
  });

  it('extracts basic {{var}} names', () => {
    expect(extractTemplateVars('Summarize {{session_id}} for {{user_id}}')).toEqual([
      'session_id',
      'user_id',
    ]);
  });

  it('de-duplicates repeated names (preserves first-seen order)', () => {
    expect(extractTemplateVars('{{a}} {{b}} {{a}} {{c}} {{b}}')).toEqual(['a', 'b', 'c']);
  });

  it('excludes auto-resolved names by default', () => {
    const vars = extractTemplateVars('{{instruction}} {{session_id}}');
    expect(vars).toEqual(['session_id']);
  });

  it('includes auto-resolved names when opted in', () => {
    const vars = extractTemplateVars('{{instruction}} {{session_id}}', {
      includeAutoResolved: true,
    });
    expect(vars).toEqual(['instruction', 'session_id']);
  });

  it('ignores single-brace {x} and mismatched braces', () => {
    expect(extractTemplateVars('{foo} {{}} {{bar}')).toEqual([]);
    expect(extractTemplateVars('{{bar}}')).toEqual(['bar']);
  });
});
