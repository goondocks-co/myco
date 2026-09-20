import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { tempMycoHome } from '../member/helpers/server.js';
import { claimSubsystem, releaseSubsystemClaim, SYMBIONT_CONFIG_SUBSYSTEM } from '@myco/grove/subsystem-claim.js';

let root: string;
let home: string;
let savedHome: string | undefined;
let mycoHome: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-global-project-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-global-agent-'));
  mycoHome = tempMycoHome();
  savedHome = process.env.HOME;
  process.env.HOME = home;
  writeRegistryEntry({ version: REGISTRY_VERSION, root, projectId: 'proj_1', serverUrl: 'https://myco.example', token: 'A'.repeat(43), machineId: 'm1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
const installer = (name: string) => new SymbiontInstaller(loadManifests().find((m) => m.name === name)!, root, resolvePackageRoot(), false, undefined, null, 'member-global', mycoHome);

describe('global member installation', () => {
  it('refuses a peer claim before writing and accepts the selected member home owner', () => {
    const previous = process.env.MYCO_CLAIMS_HOME;
    process.env.MYCO_CLAIMS_HOME = mycoHome;
    try {
      claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, 'peer');
      expect(() => installer('codex').install()).toThrow(/claimed by another installation/);
      expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
      releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, 'peer');
      claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome);
      expect(installer('codex').install().hooks).toBe(true);
    } finally {
      releaseSubsystemClaim(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome);
      if (previous === undefined) delete process.env.MYCO_CLAIMS_HOME; else process.env.MYCO_CLAIMS_HOME = previous;
    }
  });

  it('preserves legacy and foreign project commands while removing member commands', () => {
    const target = path.join(root, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const legacy = { command: '/opt/myco hook stop --myco-managed' };
    const foreign = { command: 'other-hook --credential registry' };
    const member = { command: '/opt/myco hook stop --credential registry --myco-managed' };
    fs.writeFileSync(target, JSON.stringify({ hooks: { Stop: [{ hooks: [legacy, foreign, member] }], SessionStart: [legacy, member] } }));
    installer('codex').install();
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).hooks).toEqual({ Stop: [{ hooks: [legacy, foreign] }], SessionStart: [legacy] });
  });

  it('installs Codex hooks, enables hooks, and writes remote MCP globally without project configuration', () => {
    const target = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'model = "mine"\n[features]\nhooks = false\n[mcp_servers.other]\ncommand = "other"\n');
    expect(installer('codex').install().hooks).toBe(true);
    const config = parseToml(fs.readFileSync(target, 'utf8'));
    expect(config.model).toBe('mine');
    expect(config.features).toEqual({ hooks: true });
    expect(config.mcp_servers).toMatchObject({ other: { command: 'other' }, myco: { url: 'https://myco.example/mcp' } });
    expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
    const installed = fs.readFileSync(target, 'utf8');
    expect(installer('codex').install()).toMatchObject({ hooks: false, mcp: false });
    expect(fs.readFileSync(target, 'utf8')).toBe(installed);
  });

  it('preserves unrelated Claude hooks and settings while writing its user-wide MCP file', () => {
    const target = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const foreign = { hooks: [{ type: 'command', command: 'other-hook' }] };
    fs.writeFileSync(target, JSON.stringify({ model: 'mine', hooks: { Stop: [foreign] } }));
    installer('claude-code').install();
    const config = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(config.model).toBe('mine');
    expect(config.hooks.Stop).toContainEqual(foreign);
    expect(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers.myco.url).toBe('https://myco.example/mcp');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('removes the project member registration only after installing its global replacement and preserves foreign settings', () => {
    const manifest = loadManifests().find((m) => m.name === 'codex')!;
    new SymbiontInstaller(manifest, root, resolvePackageRoot(), false, undefined, null, 'member-project', mycoHome).install();
    const localConfig = path.join(root, '.codex', 'config.toml');
    fs.appendFileSync(localConfig, '\n[mcp_servers.other]\ncommand = "other"\n');
    const localHooks = path.join(root, '.codex', 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(localHooks, 'utf8'));
    const foreign = { type: 'command', command: 'other-hook' };
    hooks.hooks.Stop[0].hooks.push(foreign);
    fs.writeFileSync(localHooks, JSON.stringify(hooks));
    installer('codex').install();
    expect(JSON.parse(fs.readFileSync(localHooks, 'utf8')).hooks.Stop).toEqual([{ hooks: [foreign] }]);
    expect(parseToml(fs.readFileSync(localConfig, 'utf8')).mcp_servers).toEqual({ other: { command: 'other' } });
    expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(true);
  });

  it('leaves global and local registrations untouched when the local configuration cannot be read', () => {
    const localConfig = path.join(root, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(localConfig), { recursive: true });
    fs.writeFileSync(localConfig, '[mcp_servers.myco');
    expect(() => installer('codex').install()).toThrow(/could not read/);
    expect(fs.readFileSync(localConfig, 'utf8')).toBe('[mcp_servers.myco');
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
  });

  it('refuses a legacy global capture installation before writing either registration', () => {
    const target = path.join(home, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: '/opt/myco hook stop --myco-managed' }] }] } });
    fs.writeFileSync(target, original);
    expect(() => installer('codex').install()).toThrow(/capture cutover/);
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(home, '.codex', 'config.toml'))).toBe(false);
  });

  it('refuses legacy reconciliation over the global member hooks', () => {
    installer('codex').install();
    const target = path.join(home, '.codex', 'hooks.json');
    const before = fs.readFileSync(target, 'utf8');
    const manifest = loadManifests().find((m) => m.name === 'codex')!;
    expect(() => new SymbiontInstaller(manifest, root, resolvePackageRoot(), false, undefined, null, 'global').install()).toThrow(/require member provisioning/);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  });

  it('installs member plugins globally and leaves the project untouched', () => {
    for (const name of ['opencode', 'pi']) {
      expect(installer(name).install().hooks).toBe(true);
      expect(installer(name).install().hooks).toBe(false);
    }
    expect(fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'myco.ts'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.pi', 'agent', 'extensions', 'myco', 'index.ts'))).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
