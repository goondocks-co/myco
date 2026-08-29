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
import { memberMcpTemplate } from '@myco/symbionts/member-hooks.js';

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
    expect(memberMcpTemplate({ myco: { type: 'stdio', command: '/bin/myco', args: ['mcp'] } }, 'registry'))
      .toEqual({ myco: { type: 'stdio', command: '/bin/myco', args: ['mcp', CREDENTIAL_FLAG, 'registry'] } });
    expect(memberMcpTemplate({ myco: { type: 'local', command: ['/bin/myco', 'mcp'] } }, 'env'))
      .toEqual({ myco: { type: 'local', command: ['/bin/myco', 'mcp', CREDENTIAL_FLAG, 'env'] } });
    expect(() => memberMcpTemplate({ myco: { url: 'https://x' } }, 'env')).toThrow(/no argument list/);
  });
});

describe('the member MCP server', () => {
  it('renders a stdio launcher carrying the flag for an mcp-transport symbiont, and nothing for a cli-transport one', () => {
    const { installer } = memberInstaller('claude-code');
    const block = installer.renderMemberMcp('registry') as Record<string, { command: string; args: string[] }>;
    expect(Object.keys(block)).toEqual(['myco']);
    expect(block.myco.args).toEqual(['mcp', CREDENTIAL_FLAG, 'registry']);
    expect(block.myco.command.includes('{{')).toBe(false);
    expect(memberInstaller('codex').installer.renderMemberMcp('registry')).toBeNull();
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
