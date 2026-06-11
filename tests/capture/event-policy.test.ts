import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  CAPTURE_EVENT_POLICY,
  REPLAYABLE_EVENT_TYPES,
  captureEventPolicy,
} from '@myco/capture/event-policy.js';

/**
 * Drift guards for the capture event policy table — the single source of
 * truth the daemon reconciler (replayable set) and the hook CLI
 * (legacy buffer-fallback columns) both derive from.
 */
describe('capture event policy table', () => {
  it('derives REPLAYABLE_EVENT_TYPES exactly from the replayable column', () => {
    const fromTable = Object.entries(CAPTURE_EVENT_POLICY)
      .filter(([, policy]) => policy.replayable)
      .map(([type]) => type)
      .sort();
    expect([...REPLAYABLE_EVENT_TYPES].sort()).toEqual(fromTable);
  });

  it('pins the replayable set the reconciler replays after downtime', () => {
    expect([...REPLAYABLE_EVENT_TYPES].sort()).toEqual([
      'stop',
      'tool_failure',
      'tool_use',
      'user_prompt',
    ]);
  });

  it('gives every replayable type a replay mode and no mode to the rest', () => {
    for (const policy of Object.values(CAPTURE_EVENT_POLICY)) {
      if (policy.replayable) {
        expect(policy.replayMode).not.toBeNull();
      } else {
        expect(policy.replayMode).toBeNull();
      }
    }
  });

  it('pins the legacy per-hook columns the mixed-version fallback reproduces', () => {
    expect(CAPTURE_EVENT_POLICY.user_prompt).toMatchObject({
      replayMode: 'regate', legacyBufferOnIgnored: true, legacyBufferEvent: 'always',
    });
    expect(CAPTURE_EVENT_POLICY.tool_use).toMatchObject({
      replayMode: 'direct', legacyBufferOnIgnored: false, legacyBufferEvent: 'always',
    });
    expect(CAPTURE_EVENT_POLICY.tool_failure).toMatchObject({
      replayMode: 'direct', legacyBufferOnIgnored: true, legacyBufferEvent: 'always',
    });
    expect(CAPTURE_EVENT_POLICY.stop).toMatchObject({
      replayMode: 'idempotent', legacyBufferOnIgnored: true, legacyBufferEvent: 'summary-only',
    });
  });

  it('falls back fail-open for unknown types (legacy sendEvent defaults)', () => {
    expect(captureEventPolicy('some_future_type')).toEqual({
      replayable: false,
      replayMode: null,
      legacyBufferOnIgnored: true,
      legacyBufferEvent: 'always',
    });
    expect(captureEventPolicy(undefined).legacyBufferOnIgnored).toBe(true);
  });

  it('covers every event type the capture hooks emit (and carries no orphan rows)', () => {
    // The dispatcher's daemon-side buffer append is type-agnostic — every
    // event a hook POSTs gets appended. The set of bufferable types is
    // therefore the set of `type: '<event>'` literals in the hook sources;
    // scan them so adding a hook event without a policy row fails here.
    const hooksDir = path.resolve('packages/myco/src/hooks');
    const emitted = new Set<string>();
    for (const file of fs.readdirSync(hooksDir).filter((f) => f.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(hooksDir, file), 'utf-8');
      for (const match of source.matchAll(/\btype: '([a-z_]+)'/g)) {
        emitted.add(match[1]);
      }
    }
    expect(emitted.size).toBeGreaterThan(0);

    const tableTypes = new Set(Object.keys(CAPTURE_EVENT_POLICY));
    const missingFromTable = [...emitted].filter((type) => !tableTypes.has(type));
    expect(missingFromTable).toEqual([]);

    const orphanRows = [...tableTypes].filter((type) => !emitted.has(type));
    expect(orphanRows).toEqual([]);
  });
});
