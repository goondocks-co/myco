/**
 * Cross-package pins between the member and the worker. The two live under
 * separate npm roots and share no module, so every value both sides must agree
 * on is asserted here against the worker's own exports.
 */
import { describe, expect, it } from 'bun:test';
import { MAX_BLOB_BYTES, MIN_COMPAT_MEMBER_PROTOCOL, PROTOCOL_HEADER as SERVER_PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { CLASSIFIERS, UNAVAILABLE } from '@myco-server-worker/telemetry.js';
import { ID_GRAMMAR, MAX_PAYLOAD_BYTES } from '@myco-server-worker/ingest/envelope.js';
import {
  MEMBER_CODES, MEMBER_ID_NAMESPACE, MEMBER_INLINE_TEXT_MAX_BYTES, MEMBER_PROTOCOL, PARKED_CODE, PROTOCOL_HEADER, RESLICE_CODES, TRANSCRIPT_SLICE_BYTES,
} from '@myco/member/constants.js';

describe('member ↔ worker pins', () => {
  it('MEMBER_PROTOCOL is inside the server window', () => {
    expect(MEMBER_PROTOCOL).toBeGreaterThanOrEqual(MIN_COMPAT_MEMBER_PROTOCOL);
    expect(MEMBER_PROTOCOL).toBeLessThanOrEqual(SERVER_PROTOCOL);
    expect(PROTOCOL_HEADER).toBe(SERVER_PROTOCOL_HEADER);
  });

  it('the member code list is exactly the worker classifiers plus unavailable', () => {
    expect(new Set(MEMBER_CODES)).toEqual(new Set([...CLASSIFIERS, UNAVAILABLE]));
    expect(MEMBER_CODES.length).toBe(CLASSIFIERS.length + 1);
    expect(CLASSIFIERS as readonly string[]).not.toContain(UNAVAILABLE);
  });

  it('the action classes name worker classifiers', () => {
    for (const code of RESLICE_CODES) expect(CLASSIFIERS as readonly string[]).toContain(code);
    expect(CLASSIFIERS as readonly string[]).toContain(PARKED_CODE);
  });

  it('inline and slice ceilings sit under the server caps', () => {
    expect(MEMBER_INLINE_TEXT_MAX_BYTES).toBeLessThan(MAX_PAYLOAD_BYTES);
    expect(TRANSCRIPT_SLICE_BYTES).toBeLessThanOrEqual(MAX_BLOB_BYTES);
  });

  it('the derivation namespace is itself in the id grammar', () => {
    expect(ID_GRAMMAR.test(MEMBER_ID_NAMESPACE)).toBe(true);
  });
});
