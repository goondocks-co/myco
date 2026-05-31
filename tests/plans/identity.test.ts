/**
 * Anti-drift tests for plan logical-key builders.
 *
 * The MCP `myco_plans` op "save" tool path and the transcript-tag capture path both
 * compose session-scoped logical keys, but they MUST land in distinct
 * namespaces so an agent that drops a `<primary>` tag *and* calls
 * myco_plans({op: 'save', plan_key: 'primary'}) produces two rows, not one.
 *
 * Finding #10 of the pre-0.21 runtime review.
 */

import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  buildSessionPlanLogicalKey,
  buildSessionTagPlanLogicalKey,
  buildPathPlanLogicalKey,
  buildFilePlanLogicalKey,
  resolvePlanLogicalKey,
  humanizePlanToken,
  normalizePlanSourcePath,
} from '@myco/plans/identity.js';

describe('plan logical-key namespaces', () => {
  it('session tag capture and session plan_key use different namespaces', () => {
    const sessionId = 'sess-001';
    const name = 'primary';

    const fromTag = buildSessionTagPlanLogicalKey(sessionId, name);
    const fromKey = buildSessionPlanLogicalKey(sessionId, name);

    expect(fromTag).not.toBe(fromKey);
    expect(fromTag).toBe('session:sess-001:tag:primary');
    expect(fromKey).toBe('session:sess-001:key:primary');
  });

  it('session-scoped keys (tag or key) never collide with path-scoped keys', () => {
    const sessionId = 'sess-002';
    expect(buildSessionPlanLogicalKey(sessionId, 'plan.md'))
      .not.toBe(buildPathPlanLogicalKey('plan.md'));
    expect(buildSessionTagPlanLogicalKey(sessionId, 'plan.md'))
      .not.toBe(buildPathPlanLogicalKey('plan.md'));
  });

  it('distinct sessions produce distinct keys for the same tag/name', () => {
    expect(buildSessionTagPlanLogicalKey('sess-a', 'primary'))
      .not.toBe(buildSessionTagPlanLogicalKey('sess-b', 'primary'));
    expect(buildSessionPlanLogicalKey('sess-a', 'primary'))
      .not.toBe(buildSessionPlanLogicalKey('sess-b', 'primary'));
  });

  it('file intake produces a session-scoped key in the shared structure', () => {
    expect(buildFilePlanLogicalKey('sess-001', 'docs/plans/x.md'))
      .toBe('session:sess-001:file:docs/plans/x.md');
  });

  it('file keys are distinct from tag and key segments for the same token', () => {
    const sid = 'sess-009';
    const token = 'plan';
    expect(buildFilePlanLogicalKey(sid, token)).not.toBe(buildSessionPlanLogicalKey(sid, token));
    expect(buildFilePlanLogicalKey(sid, token)).not.toBe(buildSessionTagPlanLogicalKey(sid, token));
  });

  it('distinct sessions produce distinct file keys for the same path', () => {
    expect(buildFilePlanLogicalKey('sess-a', 'docs/p.md'))
      .not.toBe(buildFilePlanLogicalKey('sess-b', 'docs/p.md'));
  });
});

describe('resolvePlanLogicalKey', () => {
  it('uses the session key namespace when a plan_key is given (plan_key wins over source_path)', () => {
    expect(resolvePlanLogicalKey('s1', { planKey: 'primary', normalizedSourcePath: 'docs/p.md' }))
      .toBe(buildSessionPlanLogicalKey('s1', 'primary'));
  });

  it('falls back to the file key when only a normalized source path is given', () => {
    expect(resolvePlanLogicalKey('s1', { normalizedSourcePath: 'docs/p.md' }))
      .toBe(buildFilePlanLogicalKey('s1', 'docs/p.md'));
  });

  it('throws when neither a plan_key nor a source path is provided', () => {
    expect(() => resolvePlanLogicalKey('s1', {})).toThrow();
  });
});

describe('normalizePlanSourcePath', () => {
  it('rewrites Windows-style separators to POSIX in the normalized output', () => {
    const result = normalizePlanSourcePath('docs\\plans\\alpha.md', '/tmp/project');
    expect(result).toBe('docs/plans/alpha.md');
  });

  it('returns a normalized absolute path when the input escapes the project root', () => {
    const outside = path.resolve('/tmp/outside/plan.md');
    const result = normalizePlanSourcePath(outside, '/tmp/project');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result.includes('outside')).toBe(true);
    // Forward slashes in result (POSIX normalization).
    expect(result.includes('\\')).toBe(false);
  });

  it('passes through transcript:-prefixed sources unchanged', () => {
    expect(normalizePlanSourcePath('transcript:abc123')).toBe('transcript:abc123');
  });
});

describe('humanizePlanToken', () => {
  it('converts camelCase to Title Case', () => {
    expect(humanizePlanToken('primaryPlan')).toBe('Primary Plan');
    expect(humanizePlanToken('multiWordCamelCase')).toBe('Multi Word Camel Case');
  });

  it('converts hyphen / underscore separators to spaces with each word capitalized', () => {
    expect(humanizePlanToken('primary-plan')).toBe('Primary Plan');
    expect(humanizePlanToken('rollout_phase_one')).toBe('Rollout Phase One');
  });
});
