/**
 * Every refusal code the member can be answered with is classified once, as
 * permanent for the bytes it refused or transient, over the one list of codes
 * the member and the server share. A code added to that list and left out of
 * the classification fails here by name.
 */
import { describe, expect, it } from 'bun:test';
import { MEMBER_CODES, REFUSAL_PERMANENCE } from '@myco/member/constants.js';

describe('refusal permanence', () => {
  it('classifies exactly the codes a server answers with, each as permanent or transient', () => {
    const unclassified = MEMBER_CODES.filter((code) => !Object.hasOwn(REFUSAL_PERMANENCE, code));
    const unknown = Object.keys(REFUSAL_PERMANENCE).filter((code) => !(MEMBER_CODES as readonly string[]).includes(code));
    const invalid = Object.entries(REFUSAL_PERMANENCE).filter(([, kind]) => kind !== 'permanent' && kind !== 'transient');
    expect({ unclassified, unknown, invalid }).toEqual({ unclassified: [], unknown: [], invalid: [] });
  });

  it('holds final only what these bytes or this session can never become: the rest, the moment\'s, is sent again', () => {
    const permanent = MEMBER_CODES.filter((code) => REFUSAL_PERMANENCE[code] === 'permanent').sort();
    expect(permanent).toEqual(['blob_cap', 'blob_length_mismatch', 'body_cap', 'digest_mismatch', 'media_type', 'parse', 'session_tombstoned']);
    for (const code of ['clock_skew', 'blob_absent', 'project_archived', 'no_project', 'unknown_kind', 'unknown_field', 'refused', 'transcript_replaced'] as const) {
      expect({ code, kind: REFUSAL_PERMANENCE[code] }).toEqual({ code, kind: 'transient' });
    }
  });
});
