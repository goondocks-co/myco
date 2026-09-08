import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'bun:test';

function pluginSource(name: 'pi' | 'opencode'): string {
  const pluginPath = path.resolve(
    import.meta.dirname ?? __dirname,
    `../../packages/myco/src/symbionts/templates/${name}/plugin.ts`,
  );
  return fs.readFileSync(pluginPath, 'utf-8');
}

/**
 * Mirror the regex pair used inside each symbiont plugin. The functions
 * themselves are not exported (they live inside the plugin module), so we
 * pin the matching contract here so the manifest split (`[grove] {id}` in
 * project.toml, `[grove_binding]` in project.local.toml) can't regress.
 */
function detectsGrove(raw: string): boolean {
  return /\[grove\][^\[]*\bid\s*=/.test(raw);
}

const PORTABLE_MANIFEST = `[project]
id = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[grove]
id = "grv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
slug = "work"
name = "Work"
`;

const NO_GROVE_MANIFEST = `[project]
id = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
`;

const MALFORMED_GROVE_MANIFEST = `[project]
id = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[grove]
slug = "work"
`;

const LEGACY_BINDING_ONLY = `[project]
id = "proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

[grove]
binding_id = "gbind_legacy"
slug = "work"
mode = "local"
`;

describe('portable Grove manifest detector', () => {
  it('returns true for the portable [grove] { id } shape', () => {
    expect(detectsGrove(PORTABLE_MANIFEST)).toBe(true);
  });

  it('returns false when the [grove] block is absent', () => {
    expect(detectsGrove(NO_GROVE_MANIFEST)).toBe(false);
  });

  it('returns false when the [grove] block has no id', () => {
    expect(detectsGrove(MALFORMED_GROVE_MANIFEST)).toBe(false);
  });

  it('returns false for the legacy binding_id-only shape', () => {
    expect(detectsGrove(LEGACY_BINDING_ONLY)).toBe(false);
  });
});
