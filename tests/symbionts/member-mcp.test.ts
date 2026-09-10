/**
 * The member's MCP server: the symbiont's own stdio launcher carrying the
 * credential flag, written beside the member hooks on join and removed on
 * leave. The template shape is untouched — the launcher stays a stdio
 * command — so `mcp-template-shape.test.ts` keeps holding it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CREDENTIAL_FLAG } from '@myco/member/constants.js';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { MEMBER_MCP_LEVERS, memberMcpTemplate } from '@myco/symbionts/member-hooks.js';

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
  it('renders a stdio launcher carrying the flag for every symbiont with an MCP template, and nothing for one without', () => {
    for (const name of ['claude-code', 'codex', 'cursor']) {
      const block = memberInstaller(name).installer.renderMemberMcp('registry') as Record<string, { command: string; args: string[] }>;
      expect({ name, servers: Object.keys(block) }).toEqual({ name, servers: ['myco'] });
      expect({ name, args: block.myco.args }).toEqual({ name, args: ['mcp', CREDENTIAL_FLAG, 'registry'] });
      expect(block.myco.command.includes('{{')).toBe(false);
    }
    expect(memberInstaller('pi').installer.renderMemberMcp('registry')).toBeNull();
  });

  it('writes the server into a TOML server list (codex) beside the keys the agent owns, and removes only its own section', () => {
    const { installer, root } = memberInstaller('codex');
    const target = path.join(root, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
    expect(installer.installMemberMcp()).toBe(true);
    const written = fs.readFileSync(target, 'utf8');
    expect(written).toContain('model = "gpt-5"');
    expect(written).toContain('[mcp_servers.other]');
    expect(written).toContain('[mcp_servers.myco]');
    expect(written).toContain(`"${CREDENTIAL_FLAG}", "registry"`);
    // Codex reads command, args, env and cwd; the JSON hosts' levers are not written, and the child starts in the project.
    expect(written).toContain(`cwd = "${root}"`);
    expect(written).not.toContain('alwaysLoad');
    expect(written).not.toContain('type = ');
    expect(installer.uninstallMemberMcp()).toBe(true);
    const after = fs.readFileSync(target, 'utf8');
    expect(after).not.toContain('[mcp_servers.myco]');
    expect(after).toContain('[mcp_servers.other]');
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
