/**
 * The distributable plugin bundle and the marketplace that lists it.
 *
 * One directory carries every client's manifest over one skills tree, so the
 * thing that can go wrong is not a malformed file — the generator emits JSON —
 * but a manifest that disagrees with its siblings, or one that references a
 * configuration value nothing declares. Both are checked here against the spec
 * the emitters share, never against a value restated in this file.
 *
 * What no gate here can prove is that a client ACCEPTS the manifest. Parsing
 * JSON is not acceptance, and four of the five clients have no local validator.
 * Acceptance is recorded per client, by hand, in the pull request.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  MCP_PATH,
  MCP_SERVER_NAME,
  PLUGIN_CONFIG_KEYS,
  PLUGIN_DESCRIPTION,
  PLUGIN_NAME,
} from '@myco/plugins/spec.js';
import { SHIPPED_SKILLS_DIR } from '@myco/skills/names.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE = path.join(REPO_ROOT, 'plugins', PLUGIN_NAME);
const SKILLS_ROOT = path.join(REPO_ROOT, 'packages/myco', SHIPPED_SKILLS_DIR);

const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(BUNDLE, rel), 'utf-8')) as Record<string, unknown>;

/** Every manifest a client reads, by the path that client looks at. */
const MANIFESTS = [
  'plugin.json',
  '.claude-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  '.codex-plugin/plugin.json',
];

/** Every file that may carry an MCP entry, and the key each client's dialect puts it under. */
const MCP_FILES: ReadonlyArray<readonly [string, string]> = [
  ['mcp.json', 'servers'],
  ['.mcp.json', 'mcpServers'],
  ['mcp_config.json', 'mcpServers'],
];

describe('the plugin bundle', () => {
  it('carries a manifest for every client, and they agree on name and description', () => {
    for (const rel of MANIFESTS) {
      const manifest = readJson(rel);
      expect({ rel, name: manifest.name, description: manifest.description }).toEqual({
        rel,
        name: PLUGIN_NAME,
        description: PLUGIN_DESCRIPTION,
      });
    }
  });

  it('registers the MCP entry under the name every client uses, at the deployment endpoint', () => {
    for (const [rel, key] of MCP_FILES) {
      const servers = readJson(rel)[key] as Record<string, { url?: string; serverUrl?: string }>;
      const entry = servers[MCP_SERVER_NAME];
      expect({ rel, present: entry !== undefined }).toEqual({ rel, present: true });
      const url = entry.url ?? entry.serverUrl ?? '';
      expect({ rel, endsWith: url.endsWith(MCP_PATH) }).toEqual({ rel, endsWith: true });
    }
  });

  it('references only configuration values the spec declares', () => {
    // Every `${…}` in the bundle names one of the two values, in one of the
    // dialects. A manifest asking for a third would prompt for something no
    // other client collects, and the drift would show up only at install time.
    const declared = new Set(PLUGIN_CONFIG_KEYS.flatMap((k) => [k.id, k.id.toUpperCase()]));
    const referenced = new Set<string>();
    for (const rel of [...MANIFESTS, ...MCP_FILES.map(([f]) => f)]) {
      const body = fs.readFileSync(path.join(BUNDLE, rel), 'utf-8');
      for (const [, ref] of body.matchAll(/\$\{(?:input:|user_config\.)?([A-Za-z_]+)\}/g)) referenced.add(ref);
    }
    expect(referenced.size).toBeGreaterThan(0);
    expect([...referenced].filter((r) => !declared.has(r)).sort()).toEqual([]);
  });

  it('ships no hook, because a hook is an absolute binary path a bundle cannot carry', () => {
    const files = fs.readdirSync(BUNDLE, { recursive: true }) as string[];
    expect(files.filter((f) => path.basename(f) === 'hooks.json')).toEqual([]);
  });

  it('carries the skills tree byte for byte', () => {
    const source = fs
      .readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(SKILLS_ROOT, d.name, 'SKILL.md')))
      .map((d) => d.name)
      .sort();
    expect(source.length).toBeGreaterThan(0);
    const bundled = fs
      .readdirSync(path.join(BUNDLE, 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(bundled).toEqual(source);
    for (const name of source) {
      expect({
        name,
        equal:
          fs.readFileSync(path.join(SKILLS_ROOT, name, 'SKILL.md'), 'utf-8') ===
          fs.readFileSync(path.join(BUNDLE, 'skills', name, 'SKILL.md'), 'utf-8'),
      }).toEqual({ name, equal: true });
    }
  });
});

describe('the marketplace manifest', () => {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, '.claude-plugin/marketplace.json'), 'utf-8'),
  ) as { plugins: Array<{ name: string; source: string }> };

  it('lists the bundle at a source path that resolves', () => {
    expect(marketplace.plugins.map((p) => p.name)).toEqual([PLUGIN_NAME]);
    for (const plugin of marketplace.plugins) {
      expect(fs.existsSync(path.resolve(REPO_ROOT, plugin.source))).toBe(true);
    }
  });
});
