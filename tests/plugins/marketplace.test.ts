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
  ACCESS_KEY_COSTS,
  ACCESS_KEY_KEY,
  MCP_PATH,
  MCP_SERVER_NAME,
  PLUGIN_CONFIG_KEYS,
  PLUGIN_DESCRIPTION,
  PLUGIN_NAME,
} from '@myco/plugins/spec.js';
import { CLIENTS } from '../../packages/myco/scripts/gen-plugin-bundle.js';
import { SHIPPED_SKILLS_DIR } from '@myco/skills/names.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE = path.join(REPO_ROOT, 'plugins', PLUGIN_NAME);
const SKILLS_ROOT = path.join(REPO_ROOT, 'packages/myco', SHIPPED_SKILLS_DIR);

const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(BUNDLE, rel), 'utf-8')) as Record<string, unknown>;

/** Every manifest and MCP file, derived from the client table rather than restated. */
const MANIFESTS = CLIENTS.flatMap((c) => (c.manifestPath === undefined ? [] : [c.manifestPath]));
const MCP_FILES = [...new Set(CLIENTS.map((c) => c.mcpPath))];

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
    for (const rel of MCP_FILES) {
      const doc = readJson(rel);
      const servers = (doc.servers ?? doc.mcpServers) as Record<string, { url?: string; serverUrl?: string }>;
      const entry = servers[MCP_SERVER_NAME];
      expect({ rel, present: entry !== undefined }).toEqual({ rel, present: true });
      const url = entry.url ?? entry.serverUrl ?? '';
      expect({ rel, endsWith: url.endsWith(MCP_PATH) }).toEqual({ rel, endsWith: true });
    }
  });

  it('gives every client both values, in that client\'s own dialect and no other', () => {
    // The failure a set-union over every file cannot see: a manifest declaring
    // `${VAR}` while the MCP file it points at references `${input:...}`, so the
    // literal placeholder reaches the URL the client dials. Each client is
    // checked against ITS OWN file, through ITS OWN dialect.
    expect(CLIENTS.length).toBeGreaterThan(0);
    for (const client of CLIENTS) {
      const body = fs.readFileSync(path.join(BUNDLE, client.mcpPath), 'utf-8');
      const expected = PLUGIN_CONFIG_KEYS.map((key) => client.dialect(key));
      expect({ client: client.id, missing: expected.filter((ref) => !body.includes(ref)) }).toEqual({
        client: client.id,
        missing: [],
      });
      // And nothing from another client's dialect leaked into this file.
      const foreign = CLIENTS.filter((c) => c.dialect !== client.dialect).flatMap((c) =>
        PLUGIN_CONFIG_KEYS.map((key) => c.dialect(key)),
      );
      expect({ client: client.id, foreign: [...new Set(foreign.filter((ref) => body.includes(ref)))] }).toEqual({
        client: client.id,
        foreign: [],
      });
    }
  });

  it('sends the access key on every MCP entry', () => {
    // An entry carrying the URL and no credential authenticates as nobody. It
    // fails at first call, in the client, with nothing in this repository to
    // show why.
    for (const client of CLIENTS) {
      const body = fs.readFileSync(path.join(BUNDLE, client.mcpPath), 'utf-8');
      expect({ client: client.id, carriesKey: body.includes(client.dialect(ACCESS_KEY_KEY)) }).toEqual({
        client: client.id,
        carriesKey: true,
      });
      expect({ client: client.id, authorized: /Authorization/.test(body) }).toEqual({ client: client.id, authorized: true });
    }
  });

  it('ships no hook, because a hook is an absolute binary path a bundle cannot carry', () => {
    const files = fs.readdirSync(BUNDLE, { recursive: true }) as string[];
    expect(files.filter((f) => path.basename(f) === 'hooks.json')).toEqual([]);
    // Not by filename alone: a manifest may name a hooks file at any path, so
    // every manifest is checked for the key as well.
    for (const client of CLIENTS) {
      if (client.manifestPath === undefined) continue;
      const manifest = readJson(client.manifestPath);
      expect({ client: client.id, keys: Object.keys(manifest).filter((k) => /hook/i.test(k)) }).toEqual({
        client: client.id,
        keys: [],
      });
    }
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

describe('the bundle README', () => {
  const readme = fs.readFileSync(path.join(BUNDLE, 'README.md'), 'utf-8');

  it('states each cost of the access key, in the words the spec holds', () => {
    // The architecture document says these are stated where a user installs the
    // plugin. They are read from the spec so the claim and the page cannot
    // drift into disagreeing.
    expect(ACCESS_KEY_COSTS.length).toBe(3);
    expect(ACCESS_KEY_COSTS.filter((cost) => !readme.includes(cost))).toEqual([]);
  });

  it('says the plugin carries no binary and no hooks', () => {
    expect(readme).toContain('no binary and no hooks');
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
