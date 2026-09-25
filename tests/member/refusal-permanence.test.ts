/**
 * Every refusal code the member can be answered with is classified once, by
 * what it judges, and so as permanent for the bytes it refused or transient,
 * over the one list of codes the member and the server share. A code added to
 * that list and left out of the classification fails here by name.
 */
import { describe, expect, it } from 'bun:test';
import { MEMBER_CODES, REFUSAL_PERMANENCE, REFUSAL_SUBJECT } from '@myco/member/constants.js';

describe('refusal permanence', () => {
  it('classifies exactly the codes a server answers with, each as permanent or transient', () => {
    const unclassified = MEMBER_CODES.filter((code) => !Object.hasOwn(REFUSAL_PERMANENCE, code) || !Object.hasOwn(REFUSAL_SUBJECT, code));
    const unknown = [...Object.keys(REFUSAL_PERMANENCE), ...Object.keys(REFUSAL_SUBJECT)].filter((code) => !(MEMBER_CODES as readonly string[]).includes(code));
    const invalid = Object.entries(REFUSAL_PERMANENCE).filter(([, kind]) => kind !== 'permanent' && kind !== 'transient');
    expect({ unclassified, unknown, invalid }).toEqual({ unclassified: [], unknown: [], invalid: [] });
  });

  it('holds final only what judges the record or its session: what judges the Deployment, the credential, the clock or the server\'s version is sent again', () => {
    const permanent = MEMBER_CODES.filter((code) => REFUSAL_PERMANENCE[code] === 'permanent').sort();
    expect(permanent).toEqual([
      'blob_cap', 'blob_length_mismatch', 'body_cap', 'digest_mismatch', 'event_id_conflict', 'id_grammar', 'identity_mismatch', 'invalid_field', 'media_type', 'parse',
      'projection_conflict', 'session_tombstoned',
    ]);
    for (const code of MEMBER_CODES) {
      expect({ code, permanent: REFUSAL_PERMANENCE[code] === 'permanent' }).toEqual({ code, permanent: ['record', 'session'].includes(REFUSAL_SUBJECT[code]) });
    }
    for (const code of ['clock_skew', 'blob_absent', 'project_archived', 'no_project', 'unknown_kind', 'unknown_field', 'refused', 'transcript_replaced'] as const) {
      expect({ code, kind: REFUSAL_PERMANENCE[code] }).toEqual({ code, kind: 'transient' });
    }
    expect(REFUSAL_SUBJECT.refused).toBe('unclassified');
  });
});
