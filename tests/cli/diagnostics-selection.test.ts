/**
 * What `member export --all` names when a machine holds more than one project,
 * and what `member status` says about a spool it could not read.
 *
 * Both run the real commands over real files: the registry, the symbionts' own
 * MCP configuration, and a spool a member appended to.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { MemberSpool, OFFLINE_LATCH_FILE } from '@myco/member/spool.js';
import { mintId, promptEvent, type EnvelopeContext } from '@myco/member/envelope.js';
import { runExport, runStatus } from '@myco/cli/member.js';
import { CREDENTIAL_FLAG } from '@myco/member/constants.js';

const NOW = 1_800_000_000_000;
const SERVER = 'https://srv.example';

let sandbox: string;
let mycoHome: string;
let home: string;
const saved: Array<[string, string | undefined]> = [];

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-selection-')));
  home = path.join(sandbox, 'home');
  mycoHome = path.join(home, '.myco');
  fs.mkdirSync(mycoHome, { recursive: true });
  for (const key of ['HOME', 'MYCO_SANDBOX_ROOT', 'MYCO_HOME']) saved.push([key, process.env[key]]);
  process.env.HOME = home;
  process.env.MYCO_SANDBOX_ROOT = sandbox;
  delete process.env.MYCO_HOME;
});

afterEach(() => {
  for (const [key, value] of saved.splice(0)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** A registered project on disk: a Git repository this machine is a member of. */
function project(name: string, projectId: string): string {
  const root = path.join(sandbox, name);
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeRegistryEntry({
    version: REGISTRY_VERSION, projectId, serverUrl: `${SERVER}/`, token: 'A'.repeat(43),
    root, machineId: 'm1', joinedAt: 1, updatedAt: 1,
  }, { mycoHome });
  return root;
}

const writeJson = (file: string, body: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body), 'utf-8');
};

/** Cursor takes no headers helper, so its member entry is the stdio bridge carrying the credential flag and the project it starts in. */
const cursorMember = (root: string) => ({ mcpServers: { myco: { type: 'stdio', command: '/opt/myco', args: ['mcp', CREDENTIAL_FLAG, 'registry'], cwd: root } } });
/** A server entry that is not the member's: a URL and none of the headers its credential travels in. */
const notMember = (url: string) => ({ mcpServers: { myco: { type: 'http', url } } });

interface CheckFact { name: string; reason: string | null; symbiont: string | null; scope: string | null; root: string | null; status: string }

async function exportAll(): Promise<{ checks: CheckFact[]; selection: { root: string | null; scope: string } }> {
  const lines: string[] = [];
  await runExport(['--all'], { mycoHome, now: () => NOW, stdout: (l) => lines.push(l), stderr: () => {} });
  return JSON.parse(lines.join('\n')) as { checks: CheckFact[]; selection: { root: string | null; scope: string } };
}

const mcpChecks = (checks: CheckFact[]) => checks.filter((c) => c.name === 'Member MCP resolution');

describe('member export --all across two projects', () => {
  it('attributes each project override to its own root and names the shared global entry once', async () => {
    const alpha = project('alpha', 'proj_alpha');
    const beta = project('beta', 'proj_beta');
    // One global entry, reached from either project.
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
      `[mcp_servers.myco]\nurl = "${SERVER}/mcp"\nhttp_headers_helper = "/opt/myco member mcp-headers ${CREDENTIAL_FLAG} registry"\n`, 'utf-8');
    // A project override apiece, each in its own checkout.
    writeJson(path.join(alpha, '.cursor', 'mcp.json'), cursorMember(alpha));
    writeJson(path.join(beta, '.cursor', 'mcp.json'), cursorMember(beta));

    const report = await exportAll();
    expect(report.selection).toMatchObject({ root: null, scope: 'all', membershipPresent: true });

    const overrides = mcpChecks(report.checks).filter((c) => c.scope === 'project' && c.symbiont === 'cursor');
    expect(overrides.map((c) => c.root).sort()).toEqual([alpha, beta].sort());
    expect(overrides.every((c) => c.reason === 'mcp_entry_stdio' && c.status === 'ok')).toBe(true);

    // The global entry is the same fact from both roots, so it is named once
    // and carries no root of its own.
    const global = mcpChecks(report.checks).filter((c) => c.scope === 'global' && c.symbiont === 'codex');
    expect(global).toHaveLength(1);
    expect(global[0]).toMatchObject({ reason: 'mcp_entry_http', root: null, status: 'ok' });
  });

  it('names a project whose override could not be read without hiding the other project\'s', async () => {
    const alpha = project('alpha', 'proj_alpha');
    const beta = project('beta', 'proj_beta');
    writeJson(path.join(alpha, '.cursor', 'mcp.json'), cursorMember(alpha));
    fs.mkdirSync(path.join(beta, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(beta, '.cursor', 'mcp.json'), 'not configuration at all', 'utf-8');

    const found = mcpChecks((await exportAll()).checks).filter((c) => c.symbiont === 'cursor');
    expect(found).toContainEqual(expect.objectContaining({ reason: 'mcp_entry_stdio', root: alpha, status: 'ok' }));
    expect(found).toContainEqual(expect.objectContaining({ reason: 'mcp_target_unreadable', root: beta, status: 'warn' }));
  });
});

describe('a server entry that is not the member\'s', () => {
  it('warns that it carries no credential rather than reporting the membership resolved', async () => {
    const alpha = project('alpha', 'proj_alpha');
    writeJson(path.join(alpha, '.cursor', 'mcp.json'), notMember(`${SERVER}/mcp`));

    const found = mcpChecks((await exportAll()).checks).filter((c) => c.symbiont === 'cursor');
    expect(found).toContainEqual(expect.objectContaining({ reason: 'mcp_entry_no_credential', root: alpha, status: 'warn' }));
    expect(found.some((c) => c.status === 'ok')).toBe(false);
  });
});

describe('member status over a spool it could not read', () => {
  /** A registered project whose session has records, state, and a lock nothing can take. */
  function damaged(): { root: string; spoolDir: string } {
    const root = project('alpha', 'proj_alpha');
    const spool = new MemberSpool('proj_alpha', { mycoHome });
    const ctx: EnvelopeContext = { agent: 'claude-code', sessionId: 'sess-a', stage: spool.stagerFor('sess-a'), version: '2.0.0-test' };
    spool.append('sess-a', promptEvent(ctx, { promptId: mintId(), text: 'a turn' }));
    const lock = path.join(spool.dir, '.sess-a.lock');
    fs.rmSync(lock, { force: true });
    fs.mkdirSync(lock);
    return { root, spoolDir: spool.dir };
  }

  const statusLines = (): string[] => {
    const lines: string[] = [];
    runStatus(['--all'], { mycoHome, now: () => NOW, stdout: (l) => lines.push(l), stderr: () => {} });
    return lines;
  };

  it('says the un-acknowledged count is unknown rather than printing a null or a zero', () => {
    damaged();
    const lines = statusLines();
    expect(lines.some((l) => /^spool: .*sess-a — unknown un-acknowledged/.test(l.replace(/\s+/g, ' ')))).toBe(true);
    expect(lines.some((l) => /unknown un-acknowledged event\(s\)/.test(l))).toBe(true);
    expect(lines.some((l) => /null/.test(l))).toBe(false);
    expect(lines.some((l) => /^last ack: +unknown/.test(l.replace(/ +/g, ' ')))).toBe(true);
  });

  it('says the latch is unknown rather than reporting the member online', () => {
    const { spoolDir } = damaged();
    // A directory where the offline latch belongs: it cannot be read, and an
    // unread latch is not an absent one.
    const latch = path.join(spoolDir, OFFLINE_LATCH_FILE);
    fs.rmSync(latch, { force: true });
    fs.mkdirSync(latch);

    const lines = statusLines();
    expect(lines.some((l) => /^latch: +unknown/.test(l.replace(/ +/g, ' ')))).toBe(true);
    expect(lines.some((l) => /latch: +online/.test(l.replace(/ +/g, ' ')))).toBe(false);
  });
});
