/**
 * Cross-package pin: the server derives the same ids the member derives.
 *
 * A plan a member captures from a file and a plan the Deployment records for
 * the same file through the tool surface must share one row, so the two
 * derivations are held byte-equal here against fixed inputs.
 */
import { describe, expect, it } from 'bun:test';
import { deriveId, planKeyForPath } from '@myco/member/envelope.js';
import { normalizePlanPath } from '@myco/member/plan-files.js';
import { normalizePlanPath as serverNormalizePlanPath, planKeyFor } from '@myco-server-worker/core/plans.js';
import { MEMBER_ID_NAMESPACE } from '@myco/member/constants.js';
import { DERIVED_ID_NAMESPACE, uuidv5 } from '@myco-server-worker/hash.js';

describe('derived id parity', () => {
  it('shares the namespace', () => {
    expect(DERIVED_ID_NAMESPACE).toBe(MEMBER_ID_NAMESPACE);
  });

  it('derives the member plan key for a file, and the same id for any parts', async () => {
    const cases: string[][] = [
      ['plan', 'proj_1', 'docs/plans/x.md'],
      ['plan', 'proj_ecfd2c27e50729848003a856c1c3747e', 'docs/superpowers/plans/2026-08-29-921a.md'],
      ['plan-key', 'proj_1', 'primary'],
      ['subagent', 'sess_1', 'agent-a'],
      ['plan', 'p', 'ünïcode/päth.md'],
    ];
    for (const parts of cases) {
      expect({ parts, id: await uuidv5(...parts) }).toEqual({ parts, id: deriveId(...parts) });
    }
    expect(await uuidv5('plan', 'proj_1', 'docs/plans/x.md')).toBe(planKeyForPath('proj_1', 'docs/plans/x.md'));
  });

  it('keys a plan file the same way on both sides: the member sends the normalized path, the server keys it as given', async () => {
    const memberPath = normalizePlanPath('/work/repo', '/work/repo/.claude/plans/x.md');
    expect(memberPath).toBe('.claude/plans/x.md');
    expect(await planKeyFor('proj_1', { sourcePath: memberPath })).toBe(planKeyForPath('proj_1', memberPath));
    expect(serverNormalizePlanPath('.claude\\plans\\x.md')).toBe('.claude/plans/x.md');
  });

  it('answers a v5 UUID in the id grammar', async () => {
    expect(await uuidv5('plan', 'p', 'q')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
