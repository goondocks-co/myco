import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'bun:test';
import { CAPTURE_EVENT_POLICY } from '@myco/capture/event-policy.js';
import * as opencodePluginModule from '@myco/symbionts/templates/opencode/plugin.ts';
import {
  pluginLegacyBufferRows,
  shouldBufferPluginFallback,
} from '@myco/symbionts/templates/opencode/plugin.ts';
/**
 * Plugin templates (opencode, pi) duplicate a helper block (BATCH_KIND,
 * bufferEvent, isIgnoredResponse, postEventWithBuffer) because they run in
 * zero-dependency host runtimes and can't import shared Myco code.
 *
 * The duplication is managed, not accepted: the canonical copy lives at
 *   packages/myco/src/symbionts/templates/_shared/plugin-helpers.ts.snippet
 * and the installer overwrites the marker block in each plugin template at
 * install time. Each plugin template also keeps an inline copy between the
 * `<myco:shared-helpers>` markers so the file stays valid TypeScript for
 * Vitest imports. This test enforces those inline copies match the snippet
 * byte-for-byte — if they drift, a contributor edited only one and the
 * other will silently lag behind until the next install.
 */

const SNIPPET_PATH = path.resolve(
  import.meta.dirname ?? __dirname,
  '../../packages/myco/src/symbionts/templates/_shared/plugin-helpers.ts.snippet',
);

const PLUGIN_PATHS = {
  opencode: path.resolve(
    import.meta.dirname ?? __dirname,
    '../../packages/myco/src/symbionts/templates/opencode/plugin.ts',
  ),
  pi: path.resolve(
    import.meta.dirname ?? __dirname,
    '../../packages/myco/src/symbionts/templates/pi/plugin.ts',
  ),
};

const START_MARKER = '// <myco:shared-helpers>';
const END_MARKER = '// </myco:shared-helpers>';

function extractInlineBlock(pluginSource: string): string {
  const start = pluginSource.indexOf(START_MARKER);
  const end = pluginSource.indexOf(END_MARKER, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // Slice the content BETWEEN the markers, trimming surrounding newlines so
  // the comparison isn't sensitive to how the markers are wrapped in the
  // plugin file.
  const inner = pluginSource.slice(start + START_MARKER.length, end);
  return inner.trim();
}

describe('plugin shared-helpers snippet', () => {
  const snippet = fs.readFileSync(SNIPPET_PATH, 'utf-8').trim();

  for (const [name, pluginPath] of Object.entries(PLUGIN_PATHS)) {
    it(`${name} plugin inlines the canonical snippet between the shared-helpers markers`, () => {
      const source = fs.readFileSync(pluginPath, 'utf-8');
      const inline = extractInlineBlock(source);
      expect(inline).toBe(snippet);
    });

    it(`${name} plugin sends Grove request context headers on daemon HTTP calls`, () => {
      const source = fs.readFileSync(pluginPath, 'utf-8');
      expect(source).toContain('x-myco-project-root');
      expect(source).toContain('x-myco-project-id');
      expect(source).toContain('withRequestContextHeaders(directory, init)');
      expect(source).toContain('readTomlString(raw, "project", "id")');
    });
  }

  it('snippet defines BATCH_KIND with the same values as src/db/queries/batches.ts', () => {
    expect(snippet).toContain('INITIAL: "initial"');
    expect(snippet).toContain('STEERING: "steering"');
    expect(snippet).toContain('INTERRUPT: "interrupt"');
  });

  // Regression for /code-review finding C6: readProjectAndGroveIds's
  // non-greedy `[\s\S]*?` previously crossed TOML section boundaries —
  // a project.toml whose [project] table lacked an `id` would return
  // the [grove] section's id as projectId, and plugins would write
  // buffer JSONL into ~/.myco/groves/<id>/projects/<id>/ (the same id
  // twice), a path the daemon's reconciler never scans. The fix uses
  // a negative-lookahead `(?:(?!\n\[)[\s\S])*?` that won't cross the
  // next `[section]` header. Verify both regex patterns carry it.
  it('readProjectAndGroveIds regex is section-anchored against TOML headers', () => {
    expect(snippet).toContain(String.raw`\[project\](?:(?!\n\[)[\s\S])*?\bid\s*=\s*"([^"]+)"`);
    expect(snippet).toContain(String.raw`\[grove\](?:(?!\n\[)[\s\S])*?\bid\s*=\s*"([^"]+)"`);
  });

  // Behavioral regression for the same finding: re-evaluate the two
  // regex patterns the snippet ships and prove the section-anchor
  // semantics hold against a project.toml where [project] is missing
  // its id but [grove] still has one.
  it('section-anchored regex returns no match when [project] is missing id', () => {
    const projectPattern = /\[project\](?:(?!\n\[)[\s\S])*?\bid\s*=\s*"([^"]+)"/;
    const grovePattern = /\[grove\](?:(?!\n\[)[\s\S])*?\bid\s*=\s*"([^"]+)"/;

    const truncatedProject = [
      '[project]',
      'name = "still-here"',
      '',
      '[grove]',
      'id = "grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      '',
    ].join('\n');

    // Project's id key isn't present — must NOT fall through to grove's.
    expect(truncatedProject.match(projectPattern)).toBeNull();
    // Grove's id key IS present — must match.
    const groveMatch = truncatedProject.match(grovePattern);
    expect(groveMatch?.[1]).toBe('grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    // A well-formed project.toml still works — both patterns match the
    // values inside their own sections.
    const wellFormed = [
      '[project]',
      'id = "proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
      'name = "ok"',
      '',
      '[grove]',
      'id = "grove_cccccccccccccccccccccccccccccccc"',
    ].join('\n');
    expect(wellFormed.match(projectPattern)?.[1]).toBe('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(wellFormed.match(grovePattern)?.[1]).toBe('grove_cccccccccccccccccccccccccccccccc');
  });
});

/**
 * Walk forward from an opening `{` to its balanced closing `}`.
 * Returns the index of the closing brace, or -1 when unbalanced.
 */
function balancedClose(source: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract the `type: "<event>"` literal from the object argument of every
 * `postEventWithBuffer(...)` occurrence. Brace-balanced so the guard holds
 * regardless of property order inside the event literal (a reordered field
 * must not silently un-guard a type). Occurrences without an event-type
 * literal in their next object (doc comments, the helper's own definition)
 * contribute nothing.
 */
function eventTypesPostedWithBuffer(source: string): string[] {
  const types: string[] = [];
  let idx = 0;
  for (;;) {
    const call = source.indexOf('postEventWithBuffer(', idx);
    if (call === -1) break;
    const open = source.indexOf('{', call);
    if (open === -1) break;
    const close = balancedClose(source, open);
    if (close === -1) break;
    const literal = source.slice(open, close + 1);
    const typeMatch = literal.match(/\btype:\s*["']([a-z_]+)["']/);
    if (typeMatch) types.push(typeMatch[1]!);
    idx = close + 1;
  }
  return types;
}

describe('plugin buffer-fallback decision (ported capture event policy)', () => {
  // The decision function and the legacy rows are imported from the opencode
  // template, which Vitest executes directly. The byte-for-byte snippet-sync
  // test above guarantees the pi template carries identical code, so these
  // assertions cover both plugins.

  it('inlined legacy rows match CAPTURE_EVENT_POLICY\'s legacyBufferOnIgnored column', () => {
    // The plugins can't import capture/event-policy.ts (zero-runtime-dep
    // templates), so the rows they need are inlined. This pins the inline
    // copy to the canonical table — a divergence is a drift bug.
    const entries = Object.entries(pluginLegacyBufferRows());
    expect(entries.length).toBeGreaterThan(0);
    for (const [type, legacyBufferOnIgnored] of entries) {
      expect(CAPTURE_EVENT_POLICY[type]).toBeDefined();
      expect({ type, legacyBufferOnIgnored }).toEqual({
        type,
        legacyBufferOnIgnored: CAPTURE_EVENT_POLICY[type].legacyBufferOnIgnored,
      });
    }
  });

  it('every event type a plugin routes through postEventWithBuffer has an inline legacy row', () => {
    // A new event type routed through the helper without a legacy row would
    // silently fall back to the buffer-on-unknown default; require the row
    // to be deliberate.
    const rowTypes = Object.keys(pluginLegacyBufferRows());
    for (const pluginPath of Object.values(PLUGIN_PATHS)) {
      const source = fs.readFileSync(pluginPath, 'utf-8');
      const types = eventTypesPostedWithBuffer(source);
      expect(types.length).toBeGreaterThan(0);
      for (const type of types) {
        expect(rowTypes).toContain(type);
      }
    }
  });

  it('the opencode template module carries only function exports (loader constraint)', () => {
    // opencode's legacy-plugin loader iterates every module export and
    // THROWS for any value that isn't a function (or a {server: fn} MCP
    // shape) — one non-function export aborts the ENTIRE Myco plugin at
    // load and capture goes dark. Verified against sst/opencode v1.14.41.
    // This pins the constraint so a future `export const` can't recur.
    for (const [name, value] of Object.entries(opencodePluginModule)) {
      expect({ name, type: typeof value }).toEqual({ name, type: 'function' });
    }
  });

  it('covers every row of the canonical decision table (mirrors hooks shouldBufferFallback)', () => {
    // Same response-shape matrix as tests/hooks/capture-critical-event.test.ts
    // — the plugin port must match hooks/send-event.ts semantics exactly.

    // Transport / timeout / non-2xx — always buffer.
    expect(shouldBufferPluginFallback({ ok: false }, 'user_prompt')).toBe(true);
    expect(shouldBufferPluginFallback({ ok: false, data: { error: 'x' } }, 'tool_use')).toBe(true);

    // Honest contract.
    expect(shouldBufferPluginFallback({ ok: true, data: { ok: true, persisted: true } }, 'user_prompt')).toBe(false);
    expect(shouldBufferPluginFallback({ ok: true, data: { ok: true, persisted: false, buffered: true } }, 'user_prompt')).toBe(false);
    expect(shouldBufferPluginFallback({ ok: true, data: { ok: true, persisted: false, buffered: false } }, 'user_prompt')).toBe(true);
    // Unknown shape under persisted:false (no buffered field) fails toward
    // durability — buffer.
    expect(shouldBufferPluginFallback({ ok: true, data: { ok: true, persisted: false } }, 'tool_use')).toBe(true);

    // Contract-aware daemon's ignored — never buffer, even for types whose
    // LEGACY column buffers on ignored.
    expect(shouldBufferPluginFallback({ ok: true, data: { ok: true, ignored: 'rule', persisted: false } }, 'user_prompt')).toBe(false);
    expect(shouldBufferPluginFallback({ ok: true, data: { ok: true, ignored: 'duplicate', persisted: false } }, 'pre_compact')).toBe(false);

    // LEGACY daemon (no persisted field): exact per-type legacy behavior.
    expect(shouldBufferPluginFallback({ ok: true, data: { ok: true, ignored: 'rule' } }, 'user_prompt')).toBe(true);
    expect(shouldBufferPluginFallback({ ok: true, data: { ok: true, ignored: 'rule' } }, 'tool_use')).toBe(false);
    expect(shouldBufferPluginFallback({ ok: true, data: { ok: true, ignored: 'rule' } }, 'pre_compact')).toBe(true);
    // Unknown event type on a legacy ignore fails toward durability — buffer.
    expect(shouldBufferPluginFallback({ ok: true, data: { ok: true, ignored: 'rule' } }, 'some_future_type')).toBe(true);
    expect(shouldBufferPluginFallback({ ok: true, data: { ok: true, ignored: 'rule' } }, undefined)).toBe(true);

    // Plain legacy ok — no buffer.
    expect(shouldBufferPluginFallback({ ok: true, data: { ok: true } }, 'user_prompt')).toBe(false);
    expect(shouldBufferPluginFallback({ ok: true, data: { ok: true, batchId: 7 } }, 'user_prompt')).toBe(false);
    // Empty / non-JSON body (postJson returns ok with no data) — no buffer.
    expect(shouldBufferPluginFallback({ ok: true }, 'user_prompt')).toBe(false);
  });
});
