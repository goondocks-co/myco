import { describe, it, expect } from 'bun:test';
import { classifyCloudflareError, classifyD1Error } from '@myco-server-worker/platform/cloudflare/env.js';
import { classify, constraintDetail, emit, failureTelemetry, SchemaMismatchError } from '@myco-server-worker/telemetry.js';

describe('telemetry', () => {
  it('names admission failures with only fixed categories and allowlisted error names', () => {
    expect(failureTelemetry(new Error('this Deployment carries no recovery export target'), classifyCloudflareError))
      .toEqual({ error_class: 'configuration', error_reason: 'Error:configuration' });
    expect(failureTelemetry(new Error('RPC disconnected https://secret.invalid/?token=secret'), classifyCloudflareError))
      .toEqual({ error_class: 'rpc', error_reason: 'Error:rpc' });
    expect(failureTelemetry(new Error('D1_ERROR: private detail'), classifyCloudflareError)).toEqual({ error_class: 'db', error_reason: 'Error:db' });
    const hostile = new Error('https://secret.invalid/?token=secret');
    hostile.name = 'Bearer secret';
    expect(failureTelemetry(hostile, classifyCloudflareError)).toEqual({ error_class: 'unknown', error_reason: 'Unknown:unknown' });
    expect(failureTelemetry('Bearer secret')).toEqual({ error_class: 'unknown', error_reason: 'Unknown:unknown' });
  });
  it('names a failed constraint by its kind and schema identifiers only', () => {
    expect(constraintDetail(new Error('D1_ERROR: UNIQUE constraint failed: fact_classes.project_id, fact_classes.table_name, fact_classes.record_id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)')))
      .toBe('UNIQUE: fact_classes.project_id, fact_classes.table_name, fact_classes.record_id');
    expect(constraintDetail(new Error('FOREIGN KEY constraint failed'))).toBe('FOREIGN KEY');
    expect(constraintDetail(new Error("CHECK constraint failed: token <> 'SECRET-123'"))).toBe('CHECK');
    expect(constraintDetail(new Error('disk I/O error'))).toBeUndefined();
  });
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

  it('classifies every constraint failure as constraint: no constraint names a byte quota any more (#1416)', () => {
    expect(classify(new Error('D1_ERROR: CHECK constraint failed: member_tokens_quota: SQLITE_CONSTRAINT'))).toBe('constraint');
    expect(classify(new Error('CHECK constraint failed: member_tokens_quota'))).toBe('constraint');
    expect(classify(new Error('D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT'))).toBe('constraint');
    expect(classify(new Error('D1_ERROR: SQLITE_CONSTRAINT_CHECK'))).toBe('constraint');
    expect(classify(new SchemaMismatchError(1, '0'))).toBe('schema');
  });
});
