/**
 * Synthetic-root display fix (Phase F, T5 — W2 follow-up #1). A Team Host
 * stamps its internal `<grove>/hosted/<projectId>` bookkeeping path onto the
 * session rows it forwards; a member viewing one of those sessions should see
 * its own checkout path instead. These pin the two pure helpers behind the
 * `SessionDetail` "Project" row: the hosted-shape detector and the
 * substitution's fallback chain.
 */
import { describe, expect, it } from 'bun:test';
import {
  displaySessionProjectRoot,
  isHostedRootPath,
} from '../../packages/myco/ui/src/lib/session-project-root';

describe('isHostedRootPath', () => {
  it('matches a Team Host synthetic root (…/groves/<grove>/hosted/<id>)', () => {
    expect(isHostedRootPath('/home/dev/.myco/groves/grove_abc/hosted/proj_123')).toBe(true);
    // The hosted dir itself (no trailing project segment) still matches.
    expect(isHostedRootPath('/root/.myco-team/groves/grove_x/hosted')).toBe(true);
  });

  it('matches a Windows-separated synthetic root too', () => {
    expect(isHostedRootPath('C:\\Users\\dev\\.myco\\groves\\grove_abc\\hosted\\proj_123')).toBe(true);
  });

  it('does not match an ordinary local checkout, even one that contains "hosted" elsewhere', () => {
    expect(isHostedRootPath('/Users/dev/Repos/myco')).toBe(false);
    expect(isHostedRootPath('/Users/dev/projects/my-hosted-app')).toBe(false);
    // "hosted" not directly under a grove dir → not the synthetic shape.
    expect(isHostedRootPath('/Users/dev/hosted/thing')).toBe(false);
    expect(isHostedRootPath('/Users/dev/groves/grove_x/other/hosted/thing')).toBe(false);
  });

  it('is false for null / undefined / empty', () => {
    expect(isHostedRootPath(null)).toBe(false);
    expect(isHostedRootPath(undefined)).toBe(false);
    expect(isHostedRootPath('')).toBe(false);
  });
});

describe('displaySessionProjectRoot', () => {
  const SYNTH = '/home/dev/.myco/groves/grove_abc/hosted/proj_123';

  it('leaves a local project untouched (not attached)', () => {
    expect(displaySessionProjectRoot('/Users/dev/Repos/myco', { attached: false, ref: undefined }))
      .toBe('/Users/dev/Repos/myco');
  });

  it('leaves an attached project untouched when the root is NOT a synthetic host path', () => {
    // Full-fidelity post-attach sessions carry the real local root already.
    expect(displaySessionProjectRoot('/Users/dev/Repos/myco', { attached: true, ref: { root: '/Users/dev/Repos/myco' } }))
      .toBe('/Users/dev/Repos/myco');
  });

  it('substitutes the membership ref\'s local root for an attached synthetic root', () => {
    expect(displaySessionProjectRoot(SYNTH, { attached: true, ref: { root: '/Users/dev/Repos/myco' } }))
      .toBe('/Users/dev/Repos/myco');
  });

  it('falls back to the project-id folder when the matched ref carries no local root', () => {
    expect(displaySessionProjectRoot(SYNTH, { attached: true, ref: { root: null } }))
      .toBe('proj_123');
  });

  it('falls back to the captured value when no membership ref matched at all', () => {
    expect(displaySessionProjectRoot(SYNTH, { attached: true, ref: undefined })).toBe(SYNTH);
  });

  it('does not substitute a synthetic-looking root when the project is not attached', () => {
    // Guard is load-bearing: only an attached project ever gets rewritten.
    expect(displaySessionProjectRoot(SYNTH, { attached: false, ref: { root: '/Users/dev/Repos/myco' } }))
      .toBe(SYNTH);
  });

  it('passes null / empty through unchanged', () => {
    expect(displaySessionProjectRoot(null, { attached: true, ref: { root: '/x' } })).toBeNull();
    expect(displaySessionProjectRoot('', { attached: true, ref: { root: '/x' } })).toBe('');
  });
});
