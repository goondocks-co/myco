/**
 * The 1.4 registration locations a cutover reads and clears are exactly the
 * ones Myco 1.4.8 declared.
 *
 * `tests/fixtures/manifests-v1.4.8/` holds the nine 1.4.8 manifests byte for
 * byte: each file's git blob id is pinned below, and where the `myco/v1.4.8`
 * tag is fetched the pins are checked against the tag itself. The locations
 * are derived from those manifests the way the 1.4.8 installer read them and
 * compared with `LEGACY_REGISTRATIONS`.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { CREDENTIAL_FLAG } from '@myco/member/constants.js';
import {
  hookVerdict, LEGACY_REGISTRATIONS, mcpVerdict, pluginVerdict, removeLegacyRegistrations, scanLegacyRegistrations, type LegacyLocation,
} from '@myco/symbionts/legacy-registrations.js';

const FIXTURES = path.join(import.meta.dir, '..', 'fixtures', 'manifests-v1.4.8');
const TAG = 'myco/v1.4.8';
const TAG_BLOBS: Record<string, string> = {
  'antigravity.yaml': '2c76ad6646b8fa3eb2d7f05b5f35624911271316',
  'claude-code.yaml': '0bd4238deea367a7d1e76771aa54958bde1695e4',
  'cline.yaml': 'ff2d4a9210dd02ae37217afc701aaeb699855a2b',
  'codex.yaml': '89bf463afe3e0f83ef9528c934668f3068c77410',
  'copilot.yaml': '816b366956c2a94fe6881a77eb532af5750cfd6a',
  'cursor.yaml': '18734dc5b56a8f40af37b51fad0e8875a225ac05',
  'opencode.yaml': '806d18bfaf1af8b1af74b41ce24127466ea9821e',
  'pi.yaml': 'd57c03eceaeaf6b6bcbffffcf0dcc5a55a8cd34e',
  'windsurf.yaml': '95e6c56bd694cc387b18e5ba25ddb1eefc7ecda4',
};

const gitBlobId = (bytes: Buffer): string => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');

/** The global locations one 1.4.8 manifest declares, as its installer read them. */
function declaredLocations(manifest: { name: string; registration?: Record<string, unknown> }): LegacyLocation[] {
  const reg = manifest.registration ?? {};
  const out: LegacyLocation[] = [];
  if (typeof reg.globalHooksTarget === 'string') {
    out.push({ agent: manifest.name, kind: reg.hooksFormat === 'plugin-file' ? 'plugin-file' : 'hooks', path: reg.globalHooksTarget });
  }
  const mcpTargets = reg.globalMcpTarget === null || reg.globalMcpTarget === undefined ? [] : Array.isArray(reg.globalMcpTarget) ? reg.globalMcpTarget : [reg.globalMcpTarget];
  const toml = reg.mcpFormat === 'toml';
  for (const target of mcpTargets as Array<string | { path: string; serversKey?: string }>) {
    const file = typeof target === 'string' ? target : target.path;
    const serversKey = typeof target === 'string' ? (toml ? 'mcp_servers' : (reg.mcpServersKey as string | undefined) ?? 'mcpServers') : target.serversKey ?? 'mcpServers';
    out.push({ agent: manifest.name, kind: 'mcp', path: file, serversKey, format: toml ? 'toml' : 'json' });
  }
  if (typeof reg.globalPluginManifestTarget === 'string') out.push({ agent: manifest.name, kind: 'plugin-manifest', path: reg.globalPluginManifestTarget });
  return out;
}

const key = (l: LegacyLocation) => JSON.stringify([l.agent, l.kind, l.path, l.serversKey ?? null, l.format ?? null]);

describe('the 1.4.8 registration locations', () => {
  it('are held byte for byte from the 1.4.8 manifests', () => {
    const files = fs.readdirSync(FIXTURES).sort();
    expect(files).toEqual(Object.keys(TAG_BLOBS).sort());
    for (const file of files) expect({ file, blob: gitBlobId(fs.readFileSync(path.join(FIXTURES, file))) }).toEqual({ file, blob: TAG_BLOBS[file] });
    const tagged = spawnSync('git', ['ls-tree', TAG, 'packages/myco/src/symbionts/manifests/'], { encoding: 'utf8' });
    if (tagged.status === 0 && tagged.stdout.trim().length > 0) {
      const fromTag = Object.fromEntries(tagged.stdout.trim().split('\n').map((line) => { const [, , blob, file] = line.split(/\s+/); return [path.basename(file), blob]; }));
      expect(fromTag).toEqual(TAG_BLOBS);
    }
  });

  it('match every global hook, plugin and MCP location those manifests declare', () => {
    const derived = fs.readdirSync(FIXTURES).flatMap((file) => declaredLocations(YAML.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'))));
    expect(LEGACY_REGISTRATIONS.map(key).sort()).toEqual(derived.map(key).sort());
  });
});

describe('whose a registration is', () => {
  const legacy = ['/Users/u/.myco-dev'];
  it('judges hooks, MCP entries and plugin files', () => {
    expect(hookVerdict('/Users/u/.myco-dev/bin/myco hook stop --symbiont codex --myco-managed', legacy)).toBe('legacy');
    expect(hookVerdict('myco hook stop --symbiont codex --myco-managed', legacy)).toBe('legacy');
    expect(hookVerdict('MYCO_HOME=/Users/u/smoke /Users/u/.myco-dev/bin/myco hook stop --myco-managed', legacy)).toBe('foreign');
    expect(hookVerdict('/Users/u/dsmoke-host/bin/myco hook stop --myco-managed', legacy)).toBe('foreign');
    expect(hookVerdict(`/Users/u/.myco-dev/bin/myco hook stop ${CREDENTIAL_FLAG} registry --myco-managed`, legacy)).toBe('member');
    expect(hookVerdict('echo mine', legacy)).toBeNull();
    expect(mcpVerdict({ command: '/Users/u/.myco-dev/bin/myco', args: ['mcp'] }, legacy)).toBe('legacy');
    expect(mcpVerdict({ command: ['/Users/u/.myco-dev/bin/myco', 'mcp'] }, legacy)).toBe('legacy');
    expect(mcpVerdict({ command: '/Users/u/.myco-dev/bin/myco', args: ['mcp'], env: { MYCO_HOME: '/Users/u/smoke' } }, legacy)).toBe('foreign');
    expect(mcpVerdict({ command: '/Users/u/.myco-dev/bin/myco', args: ['mcp', CREDENTIAL_FLAG, 'registry'] }, legacy)).toBe('member');
    expect(pluginVerdict('// myco:plugin-marker\n', legacy)).toBe('legacy');
    expect(pluginVerdict('// myco:member-plugin\n', legacy)).toBe('member');
    expect(pluginVerdict('export default {}\n', legacy)).toBeNull();
  });

  it('removes only 1.4 entries, from a TOML file as from JSON', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-reg-'));
    const toml = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(toml), { recursive: true });
    fs.writeFileSync(toml, '[features]\nhooks = true\n\n[mcp_servers.myco]\ncommand = "/Users/u/.myco-dev/bin/myco"\nargs = ["mcp"]\n\n[mcp_servers.mine]\ncommand = "mine"\n');
    const scan = scanLegacyRegistrations(home, legacy);
    expect(scan.findings.map((f) => [f.location.agent, f.verdict])).toEqual([['codex', 'legacy']]);
    expect(removeLegacyRegistrations(toml, scan.findings, legacy)).toEqual([`removed the 1.4 \`myco\` MCP entry from ${toml}`]);
    const after = fs.readFileSync(toml, 'utf8');
    expect(after).toContain('[mcp_servers.mine]');
    expect(after).not.toContain('[mcp_servers.myco]');
    expect(after).toContain('hooks = true');
  });
});
