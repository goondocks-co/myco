import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'bun:test';

/**
 * The native plugins share one helper block, and it is the whole of their
 * contact with Myco.
 *
 * They run in zero-dependency host runtimes and cannot import Myco code, so
 * the block is duplicated into each template. The duplication is managed, not
 * accepted: the canonical copy lives at
 *   packages/myco/src/symbionts/templates/_shared/plugin-helpers.ts.snippet
 * and the installer overwrites the marker block at install time, while each
 * template keeps an inline copy so the file stays valid TypeScript. These
 * tests hold the inline copies byte-for-byte against the snippet — a
 * contributor who edits one would otherwise leave the others lagging until
 * the next install.
 *
 * The stronger property is that a plugin speaks to no network at all. Every
 * one of them writes transcript lines and runs `myco hook <verb>`; the binary
 * owns the credential, the spool, the server-held offset and the refusal
 * codes. A plugin that opened its own connection would be a second member,
 * and the wire contract has one.
 */

const TEMPLATES = path.resolve(
  import.meta.dirname ?? __dirname,
  '../../packages/myco/src/symbionts/templates',
);

const SNIPPET_PATH = path.join(TEMPLATES, '_shared', 'plugin-helpers.ts.snippet');

/** Every plugin-file template, including cline — which carried an unmanaged third copy before #1157. */
const PLUGIN_PATHS = {
  cline: path.join(TEMPLATES, 'cline', 'plugin.ts'),
  opencode: path.join(TEMPLATES, 'opencode', 'plugin.ts'),
  pi: path.join(TEMPLATES, 'pi', 'plugin.ts'),
};

const START_MARKER = '// <myco:shared-helpers>';
const END_MARKER = '// </myco:shared-helpers>';

/** Anything that would open a connection from inside a harness runtime. */
const NETWORK_TOKENS = ['fetch(', 'XMLHttpRequest', 'node:http', 'node:https', 'require("http', "require('http"];

function extractInlineBlock(pluginSource: string): string {
  const start = pluginSource.indexOf(START_MARKER);
  const end = pluginSource.indexOf(END_MARKER, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return pluginSource.slice(start + START_MARKER.length, end).trim();
}

describe('plugin shared-helpers snippet', () => {
  const snippet = fs.readFileSync(SNIPPET_PATH, 'utf-8').trim();

  for (const [name, pluginPath] of Object.entries(PLUGIN_PATHS)) {
    it(`${name} plugin inlines the canonical snippet between the shared-helpers markers`, () => {
      expect(extractInlineBlock(fs.readFileSync(pluginPath, 'utf-8'))).toBe(snippet);
    });

    it(`${name} plugin makes no network call of its own`, () => {
      const source = fs.readFileSync(pluginPath, 'utf-8');
      const found = NETWORK_TOKENS.filter((token) => source.includes(token));
      expect({ name, found }).toEqual({ name, found: [] });
    });

    it(`${name} plugin reaches Myco only by running the binary's hook verbs`, () => {
      const source = fs.readFileSync(pluginPath, 'utf-8');
      expect(source).toContain('runMycoHook(');
      expect(source).toContain('resolveMycoBinary(');
    });
  }

  it('every plugin-file template carries the markers, so none holds an unmanaged copy', () => {
    const templates = fs
      .readdirSync(TEMPLATES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
      .map((entry) => path.join(TEMPLATES, entry.name, 'plugin.ts'))
      .filter((file) => fs.existsSync(file));

    const unmanaged = templates.filter((file) => !fs.readFileSync(file, 'utf-8').includes(START_MARKER));
    expect(unmanaged).toEqual([]);
    expect(templates.length).toBe(Object.keys(PLUGIN_PATHS).length);
  });

  it('the snippet owns home and binary resolution, so no plugin resolves either itself', () => {
    // A plugin that resolved the home its own way would route capture to a
    // different runtime than discovery reads, which is invisible until a
    // transcript goes missing.
    for (const [name, pluginPath] of Object.entries(PLUGIN_PATHS)) {
      const source = fs.readFileSync(pluginPath, 'utf-8');
      const outsideBlock = source.slice(source.indexOf(END_MARKER));
      expect({ name, defines: outsideBlock.includes('function resolveMycoHome') }).toEqual({ name, defines: false });
      expect({ name, defines: outsideBlock.includes('function resolveMycoBinary') }).toEqual({ name, defines: false });
    }
  });
});
