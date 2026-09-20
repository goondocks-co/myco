/**
 * The member's MCP server, written beside the member hooks on join and removed
 * on leave: the Deployment's remote `/mcp` with a headers helper for a host
 * that takes one (Codex, Claude Code), else the symbiont's own stdio launcher carrying the
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
import { MemberMcpConflictError, SymbiontInstaller, resolveManagedBinaryPath } from '@myco/symbionts/installer.js';
import { MEMBER_MCP_LEVERS, memberMcpTemplate } from '@myco/symbionts/member-hooks.js';

const SERVER_URL = 'https://myco.example';
const helperFor = (source: string): string => `${resolveManagedBinaryPath()} member mcp-headers ${CREDENTIAL_FLAG} ${source} --server ${SERVER_URL}`;
/** Claude Code's remote entry: the JSON host keeps `type` and the levers. */
const claudeRemote = () => ({ type: 'http', url: `${SERVER_URL}/mcp`, headersHelper: helperFor('registry'), ...MEMBER_MCP_LEVERS });

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
    joinRoot(root);
    expect(installer.installMemberHooks()).toBe(true);
    const result = installer.install();
    expect({ hooks: result.hooks, mcp: result.mcp }).toEqual({ hooks: false, mcp: true });
    expect(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.myco).toEqual(claudeRemote());
  });

  it('renders Claude Code\'s entry as the Deployment\'s remote MCP with a headersHelper, and nothing before the project is joined', () => {
    const { installer, root } = memberInstaller('claude-code');
    expect(installer.renderMemberMcp('registry')).toBeNull();
    joinRoot(root);
    expect(installer.renderMemberMcp('registry')).toEqual({ myco: claudeRemote() });
  });

  it('renders a stdio launcher carrying the flag for Cursor, whose remote entries cannot carry a rotating token, and nothing for a symbiont without a template', () => {
    for (const name of ['cursor']) {
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
      myco: { type: 'http', url: `${SERVER_URL}/mcp`, http_headers_helper: helperFor('registry'), ...MEMBER_MCP_LEVERS },
    });
  });

  it('refuses, before any write, a Codex entry the global config would merge into one Codex refuses, and leaves the global file as it is', () => {
    const { installer, root } = memberInstaller('codex');
    joinRoot(root);
    const globalConfig = path.join(os.homedir(), '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
    const stdio = '[mcp_servers.myco]\ncommand = "/opt/myco"\nargs = ["mcp"]\n';
    try {
      fs.writeFileSync(globalConfig, stdio);
      expect(() => installer.install()).toThrow(MemberMcpConflictError);
      expect(() => installer.install()).toThrow(/command, args/);
      expect(fs.existsSync(path.join(root, '.codex'))).toBe(false);
      expect(fs.readFileSync(globalConfig, 'utf8')).toBe(stdio);

      // A credential of the global entry's own would replace the helper's.
      fs.writeFileSync(globalConfig, '[mcp_servers.myco]\nurl = "https://elsewhere.example/mcp"\nbearer_token_env_var = "OTHER_TOKEN"\n');
      expect(() => installer.install()).toThrow(/bearer_token_env_var/);
      expect(fs.existsSync(path.join(root, '.codex'))).toBe(false);

      // A global file that cannot be parsed is not "no global config".
      fs.writeFileSync(globalConfig, '[mcp_servers.myco\ncommand = "old"\n');
      expect(() => installer.install()).toThrow(/could not read/);
      expect(fs.existsSync(path.join(root, '.codex'))).toBe(false);

      // A remote global entry with its own options merges cleanly (Codex accepts
      // url + startup_timeout_sec), and so does another server.
      fs.writeFileSync(globalConfig, `[mcp_servers.myco]\nurl = "${SERVER_URL}/mcp"\nstartup_timeout_sec = 45\ntool_timeout_sec = 90\n\n[mcp_servers.other]\ncommand = "x"\n`);
      expect(installer.install().mcp).toBe(true);
    } finally {
      fs.rmSync(path.dirname(globalConfig), { recursive: true, force: true });
    }
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
      url: `${SERVER_URL}/mcp`, http_headers_helper: helperFor('registry'),
    });
    expect(installer.installMemberMcp()).toBe(false);
    expect(installer.uninstallMemberMcp()).toBe(true);
    const after = parseToml(fs.readFileSync(target, 'utf8')) as { mcp_servers: Record<string, unknown> };
    expect(Object.keys(after.mcp_servers)).toEqual(['other']);
    expect(installer.uninstallMemberMcp()).toBe(false);
  });

  it('writes the server into the symbiont\'s server list on install beside the hooks, keeps a foreign server, and removes only its own on uninstall', () => {
    const { installer, root } = memberInstaller('claude-code');
    joinRoot(root);
    const target = path.join(root, '.mcp.json');
    fs.writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const result = installer.install();
    expect({ hooks: result.hooks, mcp: result.mcp }).toEqual({ hooks: true, mcp: true });
    const written = JSON.parse(fs.readFileSync(target, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(written.mcpServers).sort()).toEqual(['myco', 'other']);
    expect(written.mcpServers.myco).toEqual(claudeRemote());
    expect(installer.uninstallMemberMcp()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ mcpServers: { other: { command: 'x' } } });
    expect(installer.uninstallMemberMcp()).toBe(false);
  });

  it('deletes the server list file on uninstall when nothing else is in it', () => {
    const { installer, root } = memberInstaller('claude-code');
    joinRoot(root);
    installer.install();
    const target = path.join(root, '.mcp.json');
    expect(fs.existsSync(target)).toBe(true);
    expect(installer.uninstallMemberMcp()).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('what a report reads from the member MCP targets', () => {
  /** A member installer at the scope the 2.0 join uses, with its global target under a home of its own. */
  const savedEnv: Array<[string, string | undefined]> = [];
  afterEach(() => { for (const [key, value] of savedEnv.splice(0)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  /**
   * A member installer at the scope the 2.0 join uses. The symbiont's global
   * target is a `~` path, so HOME moves into the sandbox and the sandbox
   * sentinel refuses any expansion that leaves it.
   */
  function globalInstaller(name: string): { installer: SymbiontInstaller; root: string; home: string } {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-inspect-sandbox-'));
    const root = path.join(sandbox, 'project');
    const home = path.join(sandbox, 'home');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    roots.push(sandbox);
    for (const key of ['HOME', 'MYCO_SANDBOX_ROOT']) savedEnv.push([key, process.env[key]]);
    process.env.HOME = home;
    process.env.MYCO_SANDBOX_ROOT = sandbox;
    const manifest = loadManifests().find((m) => m.name === name);
    if (!manifest) throw new Error(`no manifest ${name}`);
    return { installer: new SymbiontInstaller(manifest, root, resolvePackageRoot(), false, undefined, null, 'member-global', path.join(home, '.myco')), root, home };
  }

  /** Writes the member's server into every target the installer resolves, as the install does. */
  function writeEntries(installer: SymbiontInstaller, server: Record<string, unknown>): string[] {
    const files = globalTargetPaths(installer);
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { myco: server } }), 'utf-8');
    }
    return files;
  }

  it('reads the global targets under the member scope, and names the transport without the entry', () => {
    const { installer } = globalInstaller('claude-code');
    const files = writeEntries(installer, claudeRemote());
    expect(files.length).toBeGreaterThan(0);

    const seen = installer.inspectMemberMcp();
    expect(seen).toEqual(files.map(() => ({ scope: 'global', present: true, transport: 'http', carriesCredential: true, declaredCwd: null, deploymentsAgree: true, namesExpectedDeployment: null, readable: true })));
    // The Deployments are answered, never handed out: no URL, no helper command,
    // and nothing a credential travels in.
    expect(JSON.stringify(seen)).not.toContain(SERVER_URL);
    expect(JSON.stringify(seen)).not.toContain('mcp-headers');
    expect(JSON.stringify(seen)).not.toContain(CREDENTIAL_FLAG);
  });

  it('reads a global target with no Myco server as absent, not as unreadable', () => {
    const { installer } = globalInstaller('claude-code');
    for (const file of globalTargetPaths(installer)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { somethingElse: { url: 'https://elsewhere' } } }), 'utf-8');
    }

    expect(installer.inspectMemberMcp().every((t) => t.readable && !t.present && t.transport === null && !t.carriesCredential)).toBe(true);
  });

  it('reads a server that carries no member credential as present and not the member\'s', () => {
    const { installer } = globalInstaller('claude-code');
    // A 1.4 project install's shape: a URL, and none of the headers the
    // member's credential travels in.
    writeEntries(installer, { type: 'http', url: `${SERVER_URL}/mcp` });

    const seen = installer.inspectMemberMcp();
    expect(seen.every((t) => t.present && t.transport === 'http' && !t.carriesCredential)).toBe(true);
  });

  it('reads a launcher without the credential argument as not the member\'s either', () => {
    const { installer } = globalInstaller('claude-code');
    writeEntries(installer, { type: 'stdio', command: '/opt/myco', args: ['mcp'] });

    const seen = installer.inspectMemberMcp();
    expect(seen.every((t) => t.present && t.transport === 'stdio' && !t.carriesCredential)).toBe(true);
  });

  it('reads a member entry that names no transport as the member\'s, and as naming none', () => {
    const { installer } = globalInstaller('claude-code');
    // The headers its credential travels in, and neither a URL to send them to
    // nor a launcher to start.
    writeEntries(installer, { headersHelper: helperFor('registry') });

    const seen = installer.inspectMemberMcp();
    expect(seen.every((t) => t.present && t.carriesCredential && t.transport === null && t.readable)).toBe(true);
  });

  it('reads a servers block that is not one as unread, not as a file declaring nothing', () => {
    const { installer } = globalInstaller('claude-code');
    for (const file of globalTargetPaths(installer)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ mcpServers: 'not a block' }), 'utf-8');
    }

    expect(installer.inspectMemberMcp().every((t) => !t.readable && !t.present)).toBe(true);
  });

  it('reads a myco entry that is not an object as unread', () => {
    const { installer } = globalInstaller('claude-code');
    for (const file of globalTargetPaths(installer)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { myco: 'not an entry' } }), 'utf-8');
    }

    expect(installer.inspectMemberMcp().every((t) => !t.readable && !t.present)).toBe(true);
  });

  it('answers for each target on its own, so a malformed one is not hidden by a valid one', () => {
    // Copilot declares more than one global target and takes no headers helper,
    // so its member entry is the launcher carrying the credential flag.
    const { installer } = globalInstaller('copilot');
    const targets = globalTargets(installer);
    expect(targets.length).toBeGreaterThan(1);
    for (const { path: file } of targets) fs.mkdirSync(path.dirname(file), { recursive: true });
    // Each host reads its servers under its own key.
    const write = (target: { path: string; serversKey: string }, myco: unknown) =>
      fs.writeFileSync(target.path, JSON.stringify({ [target.serversKey]: { myco } }), 'utf-8');
    write(targets[0]!, { type: 'stdio', command: '/opt/myco', args: ['mcp', CREDENTIAL_FLAG, 'registry'] });
    // A myco key that is not a server block: unreadable, and read on its own.
    for (const target of targets.slice(1)) write(target, ['not an entry']);

    const seen = installer.inspectMemberMcp();
    expect(seen[0]).toEqual({ scope: 'global', present: true, transport: 'stdio', carriesCredential: true, declaredCwd: null, deploymentsAgree: null, namesExpectedDeployment: null, readable: true });
    expect(seen.slice(1).every((t) => !t.readable && !t.present)).toBe(true);
  });

  it('reads a launcher whose credential flag names no source as not the member\'s', () => {
    const { installer } = globalInstaller('claude-code');
    // The flag alone, a source the member does not know, and a list holding a
    // value that is not a word: none of them names a source.
    for (const args of [['mcp', CREDENTIAL_FLAG], ['mcp', CREDENTIAL_FLAG, 'somewhere-else'], ['mcp', CREDENTIAL_FLAG, 42, 'registry']]) {
      writeEntries(installer, { type: 'stdio', command: '/opt/myco', args });
      expect(installer.inspectMemberMcp().every((t) => t.present && !t.carriesCredential)).toBe(true);
    }
  });

  it('reads a headers helper naming no Deployment as not the member\'s', () => {
    const { installer } = globalInstaller('claude-code');
    // `mcp-headers` refuses without the server its entry's URL names.
    writeEntries(installer, { type: 'http', url: `${SERVER_URL}/mcp`, headersHelper: `/opt/myco member mcp-headers ${CREDENTIAL_FLAG} registry` });
    expect(installer.inspectMemberMcp().every((t) => t.present && !t.carriesCredential)).toBe(true);

    // And with a server flag carrying no value.
    writeEntries(installer, { type: 'http', url: `${SERVER_URL}/mcp`, headersHelper: `/opt/myco member mcp-headers ${CREDENTIAL_FLAG} registry --server --verbose` });
    expect(installer.inspectMemberMcp().every((t) => t.present && !t.carriesCredential)).toBe(true);
  });

  it('reads the helper provisioning writes as the member\'s', () => {
    const { installer } = globalInstaller('claude-code');
    writeEntries(installer, claudeRemote());
    expect(installer.inspectMemberMcp().every((t) => t.present && t.carriesCredential)).toBe(true);
  });

  it('reads a launcher written as an argument list, which opencode writes, as the member\'s', () => {
    const { installer } = globalInstaller('claude-code');
    // The template as a member's entry carries it: the flag and its source
    // appended to the command list, with no separate argument list.
    const written = memberMcpTemplate({ myco: { type: 'local', command: ['/opt/myco', 'mcp'] } }, 'registry').myco;
    expect(written).toMatchObject({ command: ['/opt/myco', 'mcp', CREDENTIAL_FLAG, 'registry'] });
    writeEntries(installer, written as Record<string, unknown>);

    expect(installer.inspectMemberMcp().every((t) => t.present && t.transport === 'stdio' && t.carriesCredential)).toBe(true);
  });

  it('reads a command list carrying no source as a launcher that is not the member\'s', () => {
    const { installer } = globalInstaller('claude-code');
    writeEntries(installer, { type: 'local', command: ['/opt/myco', 'mcp'] });

    expect(installer.inspectMemberMcp().every((t) => t.present && t.transport === 'stdio' && !t.carriesCredential)).toBe(true);
  });

  it('names no Deployment for a URL a membership could not carry, however well the two match', () => {
    const { installer } = globalInstaller('claude-code');
    // Matching text is not a Deployment: `mcp-headers` could resolve neither.
    writeEntries(installer, { type: 'http', url: 'not-a-url/mcp', headersHelper: `/opt/myco member mcp-headers ${CREDENTIAL_FLAG} registry --server not-a-url` });

    const seen = installer.inspectMemberMcp('not-a-url');
    expect(seen.every((t) => t.present && t.deploymentsAgree === null && t.namesExpectedDeployment === null && !t.carriesCredential)).toBe(true);
  });

  it('says a target it could not read is unread, rather than reading it as no entry', () => {
    const { installer } = globalInstaller('claude-code');
    writeEntries(installer, claudeRemote());
    for (const file of globalTargetPaths(installer)) fs.writeFileSync(file, 'not configuration at all', 'utf-8');

    expect(installer.inspectMemberMcp().every((t) => !t.readable && !t.present)).toBe(true);
  });

  it('reads the project target under an override, never the global one', () => {
    const { root } = globalInstaller('claude-code');
    const manifest = loadManifests().find((m) => m.name === 'claude-code')!;
    const override = new SymbiontInstaller(manifest, root, resolvePackageRoot(), false, undefined, null, 'member-project');
    const projectTarget = path.join(root, manifest.registration!.mcpTarget!);
    fs.mkdirSync(path.dirname(projectTarget), { recursive: true });
    fs.writeFileSync(projectTarget, JSON.stringify({ mcpServers: { myco: claudeRemote() } }), 'utf-8');

    const seen = override.inspectMemberMcp();
    // One target, the project's own: the member scope's global paths are not consulted.
    expect(seen).toEqual([{ scope: 'project', present: true, transport: 'http', carriesCredential: true, declaredCwd: null, deploymentsAgree: true, namesExpectedDeployment: null, readable: true }]);
    expect(globalTargetPaths(override)).toEqual([projectTarget]);
  });
});

/** The absolute MCP targets an installer resolves at its own scope, each with the key its host reads servers under. */
function globalTargets(installer: SymbiontInstaller): Array<{ path: string; serversKey: string }> {
  return (installer as unknown as { resolveAbsoluteMcpTargets(): Array<{ path: string; serversKey: string }> }).resolveAbsoluteMcpTargets();
}

/** Those targets' paths alone. */
function globalTargetPaths(installer: SymbiontInstaller): string[] {
  return globalTargets(installer).map((t) => t.path);
}
