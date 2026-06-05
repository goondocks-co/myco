/**
 * Tests for the shared LogEntry -> LogEntryInsert mapping seam.
 *
 * This is the single place both the live persist path (main.ts logger
 * persistFn) and the buffer-replay path (log-reconcile.ts) resolve a daemon
 * log row's project_id. The invariant it enforces: a daemon-owned log row
 * carries the daemon's resolved fallback project id — which is NULL for the
 * groveless daemon anchor — and NEVER the phantom `_unbound-bootstrap`
 * project id. An explicit per-entry project_id always wins over the fallback.
 */

import { describe, it, expect } from 'bun:test';
import { logEntryToInsert } from '@myco/daemon/log-entry-insert.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';

// A real, registered Grove project id (32 hex after the prefix).
const REAL_PROJECT_ID = assertGroveProjectId('proj_11111111111111111111111111111111');
// The phantom `myco-bootstrap` id from `_unbound-bootstrap/project.toml`. It
// must never appear on a daemon log row.
const PHANTOM_PROJECT_ID = 'proj_a28e8a32e8b7727cfd19f22223b482c5';

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-06-04T00:00:00.000Z',
    level: 'info',
    kind: 'daemon.start',
    component: 'daemon',
    message: 'Daemon started',
    ...overrides,
  };
}

describe('logEntryToInsert', () => {
  it('maps a daemon-anchor log (null fallback) to project_id IS NULL', () => {
    const insert = logEntryToInsert(entry(), null);
    expect(insert.project_id).toBeNull();
  });

  it('never substitutes a phantom id for a groveless daemon anchor', () => {
    const insert = logEntryToInsert(entry(), null);
    expect(insert.project_id).not.toBe(PHANTOM_PROJECT_ID);
  });

  it('preserves an explicit per-entry project_id over the fallback', () => {
    const insert = logEntryToInsert(entry({ project_id: REAL_PROJECT_ID }), null);
    expect(insert.project_id).toBe(REAL_PROJECT_ID);
  });

  it('uses the fallback project id when the daemon is grove-bound', () => {
    const insert = logEntryToInsert(entry(), REAL_PROJECT_ID);
    expect(insert.project_id).toBe(REAL_PROJECT_ID);
  });

  it('throws on a malformed string project_id rather than writing junk', () => {
    expect(() => logEntryToInsert(entry({ project_id: 'not-a-project-id' }), null)).toThrow();
  });

  it('carries through the core columns', () => {
    const insert = logEntryToInsert(entry({ session_id: 'sess-abc' }), null);
    expect(insert.timestamp).toBe('2026-06-04T00:00:00.000Z');
    expect(insert.level).toBe('info');
    expect(insert.kind).toBe('daemon.start');
    expect(insert.component).toBe('daemon');
    expect(insert.message).toBe('Daemon started');
    expect(insert.session_id).toBe('sess-abc');
  });

  it('puts extra fields in data but excludes project_id and session_id', () => {
    const insert = logEntryToInsert(
      entry({ session_id: 'sess-abc', project_id: REAL_PROJECT_ID, foo: 'bar' }),
      null,
    );
    expect(insert.data).toBe('{"foo":"bar"}');
  });

  it('returns null data when no extra fields are present', () => {
    const insert = logEntryToInsert(entry(), null);
    expect(insert.data).toBeNull();
  });

  it('defensively derives kind/component for a malformed buffered line', () => {
    // Buffer replay parses arbitrary JSONL; an old/partial line may lack kind.
    const insert = logEntryToInsert(
      { timestamp: '2026-06-04T00:00:00.000Z', level: 'warn', message: 'x', component: 'session' },
      null,
    );
    expect(insert.kind).toBe('session.unknown');
    expect(insert.component).toBe('session');
  });
});
