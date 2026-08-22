/**
 * Cross-package pins between the member and the worker. The two live under
 * separate npm roots and share no module, so every value both sides must agree
 * on is asserted here against the worker's own exports.
 */
import { describe, expect, it } from 'bun:test';
import { MAX_BLOB_BYTES, MIN_COMPAT_MEMBER_PROTOCOL, PROTOCOL_HEADER as SERVER_PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { CLASSIFIERS, UNAVAILABLE } from '@myco-server-worker/telemetry.js';
import { ID_GRAMMAR, MAX_PAYLOAD_BYTES } from '@myco-server-worker/ingest/envelope.js';
import { kindSpec } from '@myco-server-worker/ingest/kinds.js';
import { MEMBER_TOKEN_PATTERN as SERVER_TOKEN_PATTERN, MEMBER_TOKEN_REFRESH_WINDOW_MS as SERVER_REFRESH_WINDOW_MS } from '@myco-server-worker/auth/tokens.js';
import {
  MEMBER_CODES, MEMBER_ID_NAMESPACE, MEMBER_INLINE_TEXT_MAX_BYTES, MEMBER_PROTOCOL, MEMBER_TOKEN_PATTERN, MEMBER_TOKEN_REFRESH_WINDOW_MS, PARKED_CODE, PROTOCOL_HEADER, RESLICE_CODES, TRANSCRIPT_SLICE_BYTES,
} from '@myco/member/constants.js';
import { BOUNDS } from '@myco/member/envelope.js';

/** Where each member bound lands in the worker catalogue: [kind, field]. */
const BOUND_FIELDS: Record<keyof typeof BOUNDS, [string, string] | [string, string, 'item']> = {
  agent: ['session.start', 'agent'],
  branch: ['session.start', 'branch'],
  originPath: ['session.start', 'originPath'],
  parentReason: ['session.start', 'parentReason'],
  toolName: ['tool.use', 'toolName'],
  output: ['tool.use', 'output'],
  errorMessage: ['tool.failure', 'errorMessage'],
  mycoTool: ['tool.use', 'mycoTool'],
  mycoOp: ['tool.use', 'mycoOp'],
  agentType: ['subagent.start', 'agentType'],
  trigger: ['compaction.pre', 'trigger'],
  message: ['notification', 'message'],
  level: ['notification', 'level'],
  threadLabel: ['prompt', 'threadLabel'],
  title: ['plan', 'title'],
  description: ['attachment', 'description'],
  fileItem: ['tool.use', 'filesAffected', 'item'],
  tagItem: ['plan', 'tags', 'item'],
};

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

  it('the token shape the member checks is the shape the server mints', () => {
    expect(MEMBER_TOKEN_PATTERN.source).toBe(SERVER_TOKEN_PATTERN.source);
  });

  it('the window the member assumes before the server announces one is the window the server keeps', () => {
    expect(MEMBER_TOKEN_REFRESH_WINDOW_MS).toBe(SERVER_REFRESH_WINDOW_MS);
  });

  it('every member string bound equals the worker bound on the field it truncates for', () => {
    for (const [name, max] of Object.entries(BOUNDS) as Array<[keyof typeof BOUNDS, number]>) {
      const [kind, field, item] = BOUND_FIELDS[name];
      const spec = kindSpec(kind);
      expect({ name, spec: spec !== null }).toEqual({ name, spec: true });
      const bound = spec!.fields[field]?.bound;
      expect({ name, bound: bound?.type }).toEqual({ name, bound: item ? 'stringArray' : 'string' });
      const serverMax = bound!.type === 'stringArray' ? bound!.maxItem : bound!.type === 'string' ? bound!.max : -1;
      expect({ name, max }).toEqual({ name, max: serverMax });
    }
  });
});
