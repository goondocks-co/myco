import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  CAPTURE_EVENT_POLICY,
  REPLAYABLE_EVENT_TYPES,
  captureEventPolicy,
} from '@myco/capture/event-policy.js';

/**
 * Return the innermost brace-balanced `{ ... }` object literal enclosing
 * `fromIdx`, or null when no balanced literal surrounds it. Walks backward
 * to the unmatched opening brace, then forward to its balanced close.
 */
function enclosingObjectLiteral(source: string, fromIdx: number): string | null {
  let depth = 0;
  let open = -1;
  for (let i = fromIdx; i >= 0; i--) {
    const ch = source[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) { open = i; break; }
      depth--;
    }
  }
  if (open === -1) return null;
  depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Drift guards for the capture event policy table — the single source of
 * truth the daemon reconciler derives its replayable set from.
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

  it('pins the replay mode of every replayable type', () => {
    expect(CAPTURE_EVENT_POLICY.user_prompt.replayMode).toBe('regate');
    expect(CAPTURE_EVENT_POLICY.tool_use.replayMode).toBe('direct');
    expect(CAPTURE_EVENT_POLICY.tool_failure.replayMode).toBe('direct');
    expect(CAPTURE_EVENT_POLICY.stop.replayMode).toBe('idempotent');
  });

  it('falls back to not-replayable for unknown types', () => {
    expect(captureEventPolicy('some_future_type')).toEqual({
      replayable: false,
      replayMode: null,
    });
    expect(captureEventPolicy(undefined).replayable).toBe(false);
  });

  it('covers every event type the capture hooks and plugin templates emit (and carries no orphan rows)', () => {
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

    // Plugin templates (opencode, pi) emit daemon events too, outside the
    // hook CLI. A daemon event is an object literal carrying BOTH a `type:`
    // string literal and a `session_id:` property — matched within the whole
    // brace-balanced literal so property order can't silently un-guard a
    // type, while UI-part literals (`type: "text"`, no session_id) stay out
    // of the scan. A plugin-emitted event type without a policy row fails
    // here.
    const templatesDir = path.resolve('packages/myco/src/symbionts/templates');
    const pluginFiles = ['opencode/plugin.ts', 'pi/plugin.ts']
      .map((rel) => path.join(templatesDir, rel));
    for (const file of pluginFiles) {
      const source = fs.readFileSync(file, 'utf-8');
      const fileTypes: string[] = [];
      for (const match of source.matchAll(/\bsession_id\s*:/g)) {
        const literal = enclosingObjectLiteral(source, match.index!);
        const typeMatch = literal?.match(/\btype:\s*["']([a-z_]+)["']/);
        if (typeMatch) fileTypes.push(typeMatch[1]);
      }
      expect(fileTypes.length).toBeGreaterThan(0);
      for (const type of fileTypes) emitted.add(type);
    }

    const tableTypes = new Set(Object.keys(CAPTURE_EVENT_POLICY));
    const missingFromTable = [...emitted].filter((type) => !tableTypes.has(type));
    expect(missingFromTable).toEqual([]);

    const orphanRows = [...tableTypes].filter((type) => !emitted.has(type));
    expect(orphanRows).toEqual([]);
  });
});
