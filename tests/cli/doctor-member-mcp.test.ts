import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkMemberMcpResolution } from '@myco/cli/doctor-member.js';
import { REGISTRY_VERSION, writeRegistryEntry, projectsDir, registryKeyFor } from '@myco/member/registry.js';
describe('checkMemberMcpResolution', () => {
  let savedHome: string | undefined;
  let savedMycoHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    savedHome = process.env.HOME;
    savedMycoHome = process.env.MYCO_HOME;
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-home-'));
    process.env.HOME = homeDir;
    delete process.env.MYCO_HOME;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedMycoHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const member = (root: string, mycoHome: string, projectId: string, serverUrl = 'https://srv.example') => writeRegistryEntry({
    version: REGISTRY_VERSION, projectId, serverUrl, token: 'A'.repeat(43), root, machineId: 'm1', joinedAt: 1, updatedAt: 1,
  }, { mycoHome });

  const reasons = (checks: Awaited<ReturnType<typeof checkMemberMcpResolution>>) =>
    checks.filter((c) => c.name === 'Member MCP resolution')
      .map((c) => ({ reason: c.reason ?? null, symbiont: c.symbiont ?? null, scope: c.scope ?? null, status: c.status }));

  /** Claude Code's remote entry: the URL a host dials, and the helper that mints its headers. */
  const remote = (url: string, helperServer: string) => JSON.stringify({
    mcpServers: { myco: { type: 'http', url: `${url}/mcp`, headersHelper: `/opt/myco member mcp-headers --credential registry --server ${helperServer}` } },
  });
  /** Writes that entry in Claude Code's user-level MCP file. */
  const writeRemote = (url: string, helperServer: string) =>
    fs.writeFileSync(path.join(homeDir, '.claude.json'), remote(url, helperServer));

  it('says nothing for a project that is not a member', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    expect(await checkMemberMcpResolution(path.join(root, '.myco'), process.env)).toEqual([]);
  });

  it('names the scope and transport of a global member entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    member(root, path.join(homeDir, '.myco'), 'proj_1');
    fs.mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });
    // Cursor takes no headers helper, so its member entry is the stdio bridge carrying the credential flag.
    fs.writeFileSync(path.join(homeDir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { myco: { type: 'stdio', command: '/opt/myco', args: ['mcp', '--credential', 'registry'] } } }));

    expect(reasons(await checkMemberMcpResolution(path.join(root, '.myco'), process.env)))
      .toContainEqual({ reason: 'mcp_entry_stdio', symbiont: 'cursor', scope: 'global', status: 'ok' });
  });

  it('names a Codex TOML entry under its own servers section, which a JSON key would miss', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    member(root, path.join(homeDir, '.myco'), 'proj_1');
    fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.codex', 'config.toml'),
      '[mcp_servers.myco]\nurl = "https://srv.example/mcp"\nhttp_headers_helper = "/opt/myco member mcp-headers --credential registry --server https://srv.example"\n');

    expect(reasons(await checkMemberMcpResolution(path.join(root, '.myco'), process.env)))
      .toContainEqual({ reason: 'mcp_entry_http', symbiont: 'codex', scope: 'global', status: 'ok' });
  });

  /** Cursor's member entry: the stdio bridge, optionally naming the directory it starts in. */
  const launcher = (cwd?: string) => JSON.stringify({
    mcpServers: { myco: { type: 'stdio', command: '/opt/myco', args: ['mcp', '--credential', 'registry'], ...(cwd === undefined ? {} : { cwd }) } },
  });

  it('warns that a launcher naming no directory resolves nothing in particular on a machine holding several memberships', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    member(root, path.join(homeDir, '.myco'), 'proj_1');
    member(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj2-')), path.join(homeDir, '.myco'), 'proj_2', 'https://other.example');
    fs.mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.cursor', 'mcp.json'), launcher());

    expect(reasons(await checkMemberMcpResolution(path.join(root, '.myco'), process.env)))
      .toContainEqual({ reason: 'mcp_cwd_ambiguous', symbiont: 'cursor', scope: 'global', status: 'warn' });
  });

  it('accepts a launcher naming no directory where the machine holds one membership', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    member(root, path.join(homeDir, '.myco'), 'proj_1');
    fs.mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.cursor', 'mcp.json'), launcher());

    expect(reasons(await checkMemberMcpResolution(path.join(root, '.myco'), process.env)))
      .toContainEqual({ reason: 'mcp_entry_stdio', symbiont: 'cursor', scope: 'global', status: 'ok' });
  });

  it('accepts a launcher that names this project, and warns about one naming another directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-other-'));
    fs.mkdirSync(path.join(root, '.myco'));
    member(root, path.join(homeDir, '.myco'), 'proj_1');
    member(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj2-')), path.join(homeDir, '.myco'), 'proj_2', 'https://other.example');
    fs.mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });

    fs.writeFileSync(path.join(homeDir, '.cursor', 'mcp.json'), launcher(root));
    expect(reasons(await checkMemberMcpResolution(path.join(root, '.myco'), process.env)))
      .toContainEqual({ reason: 'mcp_entry_stdio', symbiont: 'cursor', scope: 'global', status: 'ok' });

    fs.writeFileSync(path.join(homeDir, '.cursor', 'mcp.json'), launcher(elsewhere));
    expect(reasons(await checkMemberMcpResolution(path.join(root, '.myco'), process.env)))
      .toContainEqual({ reason: 'mcp_cwd_elsewhere', symbiont: 'cursor', scope: 'global', status: 'warn' });
  });

  it('warns on a relative directory, which names no launch location the report can check', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    member(root, path.join(homeDir, '.myco'), 'proj_1');
    member(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj2-')), path.join(homeDir, '.myco'), 'proj_2', 'https://other.example');
    fs.mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });
    // A relative directory resolves against whoever reads it, not against the harness.
    fs.writeFileSync(path.join(homeDir, '.cursor', 'mcp.json'), launcher('.'));

    expect(reasons(await checkMemberMcpResolution(path.join(root, '.myco'), process.env)))
      .toContainEqual({ reason: 'mcp_cwd_ambiguous', symbiont: 'cursor', scope: 'global', status: 'warn' });
  });

  it('leaves a remote entry alone: its headers helper resolves the membership without a directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    member(root, path.join(homeDir, '.myco'), 'proj_1');
    member(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj2-')), path.join(homeDir, '.myco'), 'proj_2', 'https://other.example');
    fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.codex', 'config.toml'),
      '[mcp_servers.myco]\nurl = "https://srv.example/mcp"\nhttp_headers_helper = "/opt/myco member mcp-headers --credential registry --server https://srv.example"\n');

    const found = reasons(await checkMemberMcpResolution(path.join(root, '.myco'), process.env)).filter((r) => r.symbiont === 'codex');
    expect(found).toContainEqual({ reason: 'mcp_entry_http', symbiont: 'codex', scope: 'global', status: 'ok' });
    expect(found.every((r) => r.reason !== 'mcp_cwd_ambiguous')).toBe(true);
  });

  it('warns when the headers a helper mints are sent to another Deployment', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    member(root, path.join(homeDir, '.myco'), 'proj_1');
    // The URL names A; the helper mints for B.
    writeRemote('https://srv.example', 'https://other.example');

    const found = await checkMemberMcpResolution(path.join(root, '.myco'), process.env);
    expect(reasons(found)).toContainEqual({ reason: 'mcp_server_mismatch', symbiont: 'claude-code', scope: 'global', status: 'warn' });
    // The entry is wrong wherever it is read from, so it names no root.
    expect(found.find((c) => c.reason === 'mcp_server_mismatch')?.root).toBeUndefined();
  });

  it('warns when an entry agrees with itself but names a Deployment this project is not a member of', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    // The membership is on A; the entry pairs B with B.
    member(root, path.join(homeDir, '.myco'), 'proj_1');
    writeRemote('https://other.example', 'https://other.example');

    const found = await checkMemberMcpResolution(path.join(root, '.myco'), process.env);
    expect(reasons(found)).toContainEqual({ reason: 'mcp_server_stale', symbiont: 'claude-code', scope: 'global', status: 'warn' });
    // True of this project alone, so it carries the root it was asked about.
    expect(found.find((c) => c.reason === 'mcp_server_stale')?.root).toBe(root);
  });

  it('accepts an entry whose URL, helper and membership all name one Deployment', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    member(root, path.join(homeDir, '.myco'), 'proj_1');
    writeRemote('https://srv.example', 'https://srv.example');

    expect(reasons(await checkMemberMcpResolution(path.join(root, '.myco'), process.env)))
      .toContainEqual({ reason: 'mcp_entry_http', symbiont: 'claude-code', scope: 'global', status: 'ok' });
  });

  it('names a target it could not read, rather than reading it as no entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    member(root, path.join(homeDir, '.myco'), 'proj_1');
    fs.mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.cursor', 'mcp.json'), 'not configuration at all');

    expect(reasons(await checkMemberMcpResolution(path.join(root, '.myco'), process.env)))
      .toContainEqual({ reason: 'mcp_target_unreadable', symbiont: 'cursor', scope: 'global', status: 'warn' });
  });

  it('warns that a member entry naming no command carries no credential, without calling it a launcher', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    member(root, path.join(homeDir, '.myco'), 'proj_1');
    fs.mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });
    // The flag is there; no command runs it, so nothing resolves the membership.
    fs.writeFileSync(path.join(homeDir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { myco: { args: ['mcp', '--credential', 'registry'] } } }));

    const found = reasons(await checkMemberMcpResolution(path.join(root, '.myco'), process.env));
    expect(found).toContainEqual({ reason: 'mcp_entry_no_credential', symbiont: 'cursor', scope: 'global', status: 'warn' });
    expect(found.every((r) => !(r.symbiont === 'cursor' && r.reason === 'mcp_entry_stdio'))).toBe(true);
  });

  it('does not warn that a symbiont this machine never installed declares no server', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    member(root, path.join(homeDir, '.myco'), 'proj_1');

    expect(reasons(await checkMemberMcpResolution(path.join(root, '.myco'), process.env))
      .filter((r) => r.reason === 'mcp_entry_absent')).toEqual([]);
  });

  it('attributes a missing globally installed MCP entry to the machine', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    member(root, path.join(homeDir, '.myco'), 'proj_1');
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/opt/myco hook session-start --myco-managed' }] }] },
    }));

    expect(reasons(await checkMemberMcpResolution(path.join(root, '.myco'), process.env)))
      .toContainEqual({ reason: 'mcp_entry_absent', symbiont: 'claude-code', scope: 'global', status: 'warn' });
  });

  it('names a symbiont that declares no Myco server, and still names the machine pin a non-default home lacks', async () => {
    const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-other-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-mcp-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    fs.writeFileSync(path.join(root, '.myco', 'runtime.home'), `${mycoHome}\n`, { mode: 0o644 });
    member(root, mycoHome, 'proj_1');

    const checks = await checkMemberMcpResolution(path.join(root, '.myco'), process.env);
    const pin = checks.find((c) => c.reason === 'home_pin_missing');
    // The machine pin is one fact about the machine, named once however many roots ask.
    expect(pin).toMatchObject({ scope: 'global' });
    expect(pin?.root).toBeUndefined();
    expect(reasons(checks).every((r) => r.reason !== 'mcp_entry_http')).toBe(true);
  });

});

describe('checkMemberMcpResolution reading the registry for a report', () => {
  let savedHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    savedHome = process.env.HOME;
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-strict-home-'));
    process.env.HOME = homeDir;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  /** A project whose membership is a v1 entry, written where the registry keeps it. */
  function legacyMember(): { root: string; mycoHome: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-strict-proj-'));
    fs.mkdirSync(path.join(root, '.myco'));
    const mycoHome = path.join(homeDir, '.myco');
    const projects = projectsDir(mycoHome);
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, `${registryKeyFor(root)}.json`), JSON.stringify({
      version: 1, projectId: 'proj_1', serverUrl: 'https://srv.example/', token: 'A'.repeat(43),
      root, machineId: 'm1', joinedAt: 1, updatedAt: 1,
    }), { mode: 0o600 });
    fs.mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { myco: { type: 'stdio', command: '/opt/myco', args: ['mcp', '--credential', 'registry'] } },
    }));
    return { root, mycoHome };
  }

  const version = (mycoHome: string, root: string) =>
    (JSON.parse(fs.readFileSync(path.join(projectsDir(mycoHome), `${registryKeyFor(root)}.json`), 'utf-8')) as { version: number }).version;

  it('reads a v1 membership where it stands, leaving the entry at the version it was written at', async () => {
    const { root, mycoHome } = legacyMember();
    const env = { ...process.env, MYCO_HOME: mycoHome };

    const checks = await checkMemberMcpResolution(path.join(root, '.myco'), env, { registryRead: 'strict' });
    expect(checks.some((c) => c.reason === 'mcp_entry_stdio' && c.symbiont === 'cursor')).toBe(true);
    expect(version(mycoHome, root)).toBe(1);
  });

  it('answers from a registry whose lock cannot be taken, which an upgrading read would wait on', async () => {
    const { root, mycoHome } = legacyMember();
    const env = { ...process.env, MYCO_HOME: mycoHome };
    // A directory where the registry's lock file belongs: nothing can take it.
    const lock = path.join(projectsDir(mycoHome), '.lock');
    fs.rmSync(lock, { force: true });
    fs.mkdirSync(lock);

    const checks = await checkMemberMcpResolution(path.join(root, '.myco'), env, { registryRead: 'strict' });
    expect(checks.some((c) => c.reason === 'mcp_entry_stdio' && c.symbiont === 'cursor')).toBe(true);
    expect(version(mycoHome, root)).toBe(1);
  });
});
