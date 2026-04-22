import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'bun:test';
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
  }

  it('snippet defines BATCH_KIND with the same values as src/db/queries/batches.ts', () => {
    expect(snippet).toContain('INITIAL: "initial"');
    expect(snippet).toContain('STEERING: "steering"');
    expect(snippet).toContain('INTERRUPT: "interrupt"');
  });
});
