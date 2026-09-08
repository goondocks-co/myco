/**
 * Both dashboards reach the compiled binary as bytes.
 *
 * The binary ships without an adjacent build tree, so each dashboard travels as
 * a generated module of base64 files. An empty module compiles, links, and
 * serves nothing — a blank page at every route, with every other build step
 * green. The generator refuses to write one; this refuses to ship one that was
 * written before it did.
 *
 * Committed artifacts, so this reads what a release would carry rather than
 * what a local build happens to have produced.
 */
import { describe, expect, it } from 'bun:test';

import { BUNDLED_UI } from '@myco/ui-assets.generated.js';
import { BUNDLED_SERVER_UI } from '@myco/server-ui-assets.generated.js';

const BUNDLES: Array<[string, Readonly<Record<string, string>>]> = [
  ['member dashboard', BUNDLED_UI],
  ['Deployment dashboard', BUNDLED_SERVER_UI],
];

describe('the dashboards a compiled binary carries', () => {
  for (const [name, bundle] of BUNDLES) {
    it(`embeds the ${name} with a shell and its assets`, () => {
      const keys = Object.keys(bundle);
      expect({ name, hasShell: keys.includes('index.html') }).toEqual({ name, hasShell: true });
      // A shell alone is a page with no script; the build always produces both.
      expect(keys.some((key) => key.startsWith('assets/') && key.endsWith('.js'))).toBe(true);
      expect(bundle['index.html']!.length).toBeGreaterThan(0);
    });

    it(`stores every ${name} file as decodable base64 under a relative key`, () => {
      for (const [key, value] of Object.entries(bundle)) {
        expect({ key, leading: key.startsWith('/'), backslash: key.includes('\\') })
          .toEqual({ key, leading: false, backslash: false });
        expect(() => Buffer.from(value, 'base64')).not.toThrow();
      }
    });
  }
});
