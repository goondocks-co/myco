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
