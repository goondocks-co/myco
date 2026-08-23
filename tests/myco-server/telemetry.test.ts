import { describe, it, expect } from 'bun:test';
import { classifyD1Error } from '@myco-server-worker/platform/cloudflare/env.js';
import { classify, emit, SchemaMismatchError } from '@myco-server-worker/telemetry.js';

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
    // The D1 error prefix is Cloudflare's to recognise, not the shared classifier's.
    expect(classify(new Error('D1_ERROR: no such table: events'))).toBe('unknown');
    expect(classify(new Error('D1_ERROR: no such table: events'), classifyD1Error)).toBe('db');
    expect(classify(new Error('something else'))).toBe('unknown');
  });

  it('classifies the named quota constraint as quota and any other constraint failure as constraint', () => {
    expect(classify(new Error('D1_ERROR: CHECK constraint failed: member_tokens_quota: SQLITE_CONSTRAINT'))).toBe('quota');
    expect(classify(new Error('CHECK constraint failed: member_tokens_quota'))).toBe('quota');
    expect(classify(new Error('D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT'))).toBe('constraint');
    expect(classify(new Error('D1_ERROR: SQLITE_CONSTRAINT_CHECK'))).toBe('constraint');
    expect(classify(new SchemaMismatchError(1, '0'))).toBe('schema');
  });
});
