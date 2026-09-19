/**
 * The member's MCP server, written beside the member hooks on join and removed
 * on leave: the Deployment's remote `/mcp` with a headers helper for a host
 * that takes one (Codex), else the symbiont's own stdio launcher carrying the
 * credential flag. The template shape is untouched — the launcher stays a
 * stdio command — so `mcp-template-shape.test.ts` keeps holding it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { CREDENTIAL_FLAG } from '@myco/member/constants.js';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { resolveMycoHome } from '@myco/paths/home.js';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { SymbiontInstaller, resolveManagedBinaryPath } from '@myco/symbionts/installer.js';
import { MEMBER_MCP_LEVERS, memberMcpTemplate } from '@myco/symbionts/member-hooks.js';

const SERVER_URL = 'https://myco.example';

/** Record `root` as a member of a Deployment in the home the installer resolves for it. */
function joinRoot(root: string): void {
  writeRegistryEntry({
    version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl: `${SERVER_URL}/`, token: 'A'.repeat(43), root, machineId: 'm1', joinedAt: 1, updatedAt: 1,
  }, { mycoHome: resolveMycoHome({ cwd: root }) });
}

const roots: string[] = [];
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.length = 0; });

function memberInstaller(name: string): { installer: SymbiontInstaller; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-mcp-'));
  roots.push(root);
  const manifest = loadManifests().find((m) => m.name === name);
  if (!manifest) throw new Error(`no manifest ${name}`);
  return { installer: new SymbiontInstaller(manifest, root, resolvePackageRoot(), false, undefined, null, 'member-project'), root };
}

describe('memberMcpTemplate', () => {
  it('appends the credential flag to an args launcher and to a command-list launcher, and refuses a launcher with neither', () => {
    // Every member entry also carries the levers the Deployment surface needs;
    // the launcher assertions below are about the flag, not about that set.
    expect(memberMcpTemplate({ myco: { type: 'stdio', command: '/bin/myco', args: ['mcp'] } }, 'registry'))
      .toEqual({ myco: { type: 'stdio', command: '/bin/myco', args: ['mcp', CREDENTIAL_FLAG, 'registry'], ...MEMBER_MCP_LEVERS } });
    expect(memberMcpTemplate({ myco: { type: 'local', command: ['/bin/myco', 'mcp'] } }, 'env'))
      .toEqual({ myco: { type: 'local', command: ['/bin/myco', 'mcp', CREDENTIAL_FLAG, 'env'], ...MEMBER_MCP_LEVERS } });
    expect(() => memberMcpTemplate({ myco: { url: 'https://x' } }, 'env')).toThrow(/no argument list/);
  });
});

describe('the member MCP server', () => {
  it('installs a missing MCP entry when the member hooks are already current', () => {
    const { installer, root } = memberInstaller('claude-code');
    expect(installer.installMemberHooks()).toBe(true);
    const result = installer.install();
    expect({ hooks: result.hooks, mcp: result.mcp }).toEqual({ hooks: false, mcp: true });
    expect(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.myco.args).toEqual(['mcp', CREDENTIAL_FLAG, 'registry']);
  });

  it('renders a stdio launcher carrying the flag for every stdio symbiont with an MCP template, and nothing for one without', () => {
    for (const name of ['claude-code', 'cursor']) {
      const block = memberInstaller(name).installer.renderMemberMcp('registry') as Record<string, { command: string; args: string[] }>;
      expect({ name, servers: Object.keys(block) }).toEqual({ name, servers: ['myco'] });
      expect({ name, args: block.myco.args }).toEqual({ name, args: ['mcp', CREDENTIAL_FLAG, 'registry'] });
      expect(block.myco.command.includes('{{')).toBe(false);
    }
    expect(memberInstaller('pi').installer.renderMemberMcp('registry')).toBeNull();
  });

  it('renders Codex\'s entry as the Deployment\'s remote MCP with a headers helper, and nothing before the project is joined', () => {
    const { installer, root } = memberInstaller('codex');
    expect(installer.renderMemberMcp('registry')).toBeNull();
    expect(installer.installMemberMcp()).toBe(false);
    joinRoot(root);
    expect(installer.renderMemberMcp('registry')).toEqual({
      myco: { url: `${SERVER_URL}/mcp`, http_headers_helper: `${resolveManagedBinaryPath()} member mcp-headers ${CREDENTIAL_FLAG} registry` },
    });
  });

  it('writes the remote server into Codex\'s TOML server list beside the keys the agent owns, replacing a stdio entry, and removes only its own section', () => {
    const { installer, root } = memberInstaller('codex');
    joinRoot(root);
    const target = path.join(root, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `model = "gpt-5"\n\n[mcp_servers.myco]\ncommand = "/opt/myco"\nargs = ["mcp", "${CREDENTIAL_FLAG}", "registry"]\ncwd = "${root}"\n\n[mcp_servers.other]\ncommand = "x"\n`);
    expect(installer.installMemberMcp()).toBe(true);
    const written = parseToml(fs.readFileSync(target, 'utf8')) as { model: string; mcp_servers: Record<string, Record<string, unknown>> };
    expect(written.model).toBe('gpt-5');
    expect(written.mcp_servers.other).toEqual({ command: 'x' });
    // Codex refuses its whole config when a streamable HTTP server declares a
    // cwd, and reads no launcher from a URL entry: the entry is url + helper alone.
    expect(written.mcp_servers.myco).toEqual({
      url: `${SERVER_URL}/mcp`, http_headers_helper: `${resolveManagedBinaryPath()} member mcp-headers ${CREDENTIAL_FLAG} registry`,
    });
    expect(installer.installMemberMcp()).toBe(false);
    expect(installer.uninstallMemberMcp()).toBe(true);
    const after = parseToml(fs.readFileSync(target, 'utf8')) as { mcp_servers: Record<string, unknown> };
    expect(Object.keys(after.mcp_servers)).toEqual(['other']);
    expect(installer.uninstallMemberMcp()).toBe(false);
  });

  it('writes the server into the symbiont\'s server list on install beside the hooks, keeps a foreign server, and removes only its own on uninstall', () => {
    const { installer, root } = memberInstaller('claude-code');
    const target = path.join(root, '.mcp.json');
    fs.writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const result = installer.install();
    expect({ hooks: result.hooks, mcp: result.mcp }).toEqual({ hooks: true, mcp: true });
    const written = JSON.parse(fs.readFileSync(target, 'utf8')) as { mcpServers: Record<string, { args?: string[] }> };
    expect(Object.keys(written.mcpServers).sort()).toEqual(['myco', 'other']);
    expect(written.mcpServers.myco.args).toEqual(['mcp', CREDENTIAL_FLAG, 'registry']);
    expect(installer.uninstallMemberMcp()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ mcpServers: { other: { command: 'x' } } });
    expect(installer.uninstallMemberMcp()).toBe(false);
  });

  it('deletes the server list file on uninstall when nothing else is in it', () => {
    const { installer, root } = memberInstaller('claude-code');
    installer.install();
    const target = path.join(root, '.mcp.json');
    expect(fs.existsSync(target)).toBe(true);
    expect(installer.uninstallMemberMcp()).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });
});
