import { describe, expect, it } from 'bun:test';
import {
  canonicalRecordId, deriveLegacyRecordId, extractRecordSource, isReplySource, RECORD_ID_SCHEMES, RecordKindUndeclared,
  RecordSourceAbsent, RecordSourceInvalid, type RecordIdRequest, type RecordSourceRequest, type ReplySource,
} from '@goondocks/myco-shared/record-identity';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { deriveId, planKeyForPromptTag, planKeyForTag } from '@myco/member/envelope.js';
import { uuidv5 } from '@myco-server-worker/hash.js';
import evidence from '../fixtures/record-identity-evidence.json';

const base = { sessionId: 'session-1', transcriptId: 'transcript-1', agent: 'claude-code', offset: 123 };

describe('record identity registry', () => {
  it('freezes the shipped scheme generations', () => {
    expect(RECORD_ID_SCHEMES).toEqual({ 'legacy-session-v1': { generation: 1 }, 'source-record-v1': { generation: 1 } });
  });

  it('freezes exact declaration source facts and logical IDs under both schemes', async () => {
    for (const row of evidence) {
      const declaration = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === row.agent)!.recordIdentity;
      for (const scheme of ['legacy-session-v1', 'source-record-v1'] as const) {
        const source = extractRecordSource({ ...row.facts, declaration, scheme, kind: row.kind } as RecordSourceRequest);
        expect<unknown>({ case: row.label, agent: row.agent, source }).toEqual({ case: row.label, agent: row.agent, source: row.source });
        const request = { ...base, scheme, agent: row.agent, source, offset: row.offset, kind: row.kind,
          ...(row.kind === 'plan' ? { tag: row.tag!, coordinate: row.coordinate!, legacyPosition: row.legacyPosition! } : {}) } as RecordIdRequest;
        const expected = scheme === 'source-record-v1' ? row.sourceId : row.legacyId;
        expect(canonicalRecordId(deriveId, request)).toBe(expected);
        expect(await canonicalRecordId(uuidv5, request)).toBe(expected);
        expect(canonicalRecordId((...parts) => parts, request)).toEqual(scheme === 'source-record-v1' ? row.parts : row.legacyParts);
      }
    }
  });

  it('keeps copied keyed records stable while separating record keys, threads, blocks and positional transcripts', () => {
    const request: RecordIdRequest = { ...base, kind: 'response', scheme: 'source-record-v1', source: { key: 'a', thread: 'main', block: 0 } };
    const id = canonicalRecordId(deriveId, request);
    expect(canonicalRecordId(deriveId, { ...request, transcriptId: 'copy', offset: 456 })).toBe(id);
    for (const source of [{ key: 'b', thread: 'main', block: 0 }, { key: 'a', thread: 'agent', block: 0 }, { key: 'a', thread: 'main', block: 1 }]) {
      expect(canonicalRecordId(deriveId, { ...request, source })).not.toBe(id);
    }
    const positional = { ...request, source: { position: true, block: 0 } as const };
    expect(canonicalRecordId(deriveId, positional)).not.toBe(canonicalRecordId(deriveId, { ...positional, transcriptId: 'copy' }));
    expect(canonicalRecordId(deriveId, { ...request, kind: 'tool-call', source: { key: '123', block: 0 } }))
      .not.toBe(canonicalRecordId(deriveId, { ...request, kind: 'tool-call', source: { position: true, block: 0 } }));
  });

  it('derives compatibility identities independently of new source IDs and preserves member plan wrappers', () => {
    expect(deriveLegacyRecordId(deriveId, { kind: 'response', sessionId: base.sessionId, offset: 123 })).toBe('46ac81ec-47dc-50af-8894-f65f9125e997');
    expect(planKeyForTag('s', 't', 2)).toBe(deriveLegacyRecordId(deriveId, { kind: 'plan', sessionId: 's', tag: 't', legacyPosition: 2 }));
    expect(planKeyForPromptTag('s', 't', 'p')).toBe(deriveLegacyRecordId(deriveId, { kind: 'plan', sessionId: 's', tag: 't', legacyPromptId: 'p' }));
  });

  it('retains raw legacy source keys while rejecting NUL tuple components for new minting', () => {
    const declaration = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === 'claude-code')!.recordIdentity;
    for (const kind of ['response', 'tool-call'] as const) {
      const source = extractRecordSource({ declaration, scheme: 'legacy-session-v1', kind, record: { uuid: 'a\0b' }, call: { id: 'call\0a' }, block: 0 });
      const request = { ...base, kind, source };
      expect(canonicalRecordId(deriveId, { ...request, scheme: 'legacy-session-v1' })).toBe(kind === 'response' ? '46ac81ec-47dc-50af-8894-f65f9125e997' : 'eddf35d4-b862-5df2-b867-d37ac857dc1f');
      expect(() => canonicalRecordId(deriveId, { ...request, scheme: 'source-record-v1' })).toThrow(RecordSourceInvalid);
    }
  });

  it('refuses undeclared kinds and malformed source anchors before minting', () => {
    for (const scheme of ['legacy-session-v1', 'source-record-v1'] as const) {
      const declaration = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === 'cursor')!.recordIdentity;
      expect(() => extractRecordSource({ declaration, scheme, kind: 'tool-call', record: {} })).toThrow(RecordKindUndeclared);
      expect(() => extractRecordSource({ declaration: undefined, scheme, kind: 'response' })).toThrow(RecordKindUndeclared);
    }
    const declaration = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === 'claude-code')!.recordIdentity;
    expect(extractRecordSource({ declaration, scheme: 'source-record-v1', kind: 'response', record: { uuid: 'a\0b' }, block: 0 })).toEqual({ key: 'a\0b', thread: 'main', block: 0 });
    expect(() => extractRecordSource({ declaration, scheme: 'source-record-v1', kind: 'response', record: { uuid: 'a' } })).toThrow(RecordSourceInvalid);
    const toolDeclaration = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === 'codex')!.recordIdentity;
    expect(() => extractRecordSource({ declaration: toolDeclaration, scheme: 'source-record-v1', kind: 'tool-call', record: {} })).toThrow(RecordSourceAbsent);
    for (const value of [{}, { key: 'a' }, { position: true, block: -1 }, { key: 'a', block: 0, position: true }, { key: 'a\0b', block: 0 }]) expect(isReplySource(value)).toBe(false);
    for (const value of [{ key: 'a', block: 0 }, { position: true, block: 0 }]) expect(isReplySource(value)).toBe(true);
    expect(() => canonicalRecordId(deriveId, { ...base, kind: 'response', scheme: 'source-record-v1', source: {} as ReplySource })).toThrow(RecordSourceInvalid);
  });
});
