import { describe, it, expect } from 'bun:test';
import { classify, emit, SchemaMismatchError } from '../../packages/myco-server/worker/src/telemetry.js';

describe('telemetry', () => {
  it('classifies without echoing the message', () => {
    let captured = '';
    const orig = console.log;
    console.log = (s: string) => { captured = s; };
    try {
      emit({ kind: 'ingest_error', projectId: 'p', error_class: classify(new SyntaxError('Unexpected token, ..."SECRET-123" is not valid JSON')) });
    } finally { console.log = orig; }
    expect(captured).toContain('parse');
    expect(captured).not.toContain('SECRET-123');
  });

  it('classifies database failures', () => {
    expect(classify(new Error('D1_ERROR: no such table: events'))).toBe('db');
    expect(classify(new Error('something else'))).toBe('unknown');
  });

  it('classifies the named quota constraint and no other CHECK as quota', () => {
    expect(classify(new Error('D1_ERROR: CHECK constraint failed: member_tokens_quota: SQLITE_CONSTRAINT'))).toBe('quota');
    expect(classify(new Error('CHECK constraint failed: member_tokens_quota'))).toBe('quota');
    expect(classify(new Error('D1_ERROR: CHECK constraint failed: sessions_transport: SQLITE_CONSTRAINT'))).toBe('db');
    expect(classify(new SchemaMismatchError(1, '0'))).toBe('schema');
  });
});
