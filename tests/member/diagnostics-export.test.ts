/**
 * What `myco member export` may say, and what it must never carry.
 *
 * The report is a fixed field set built from the registry, the spool, the
 * refusal log, the latch and the no-membership record. These gates hold the
 * three properties a person pasting one into an issue depends on: no credential
 * and no captured content leave the machine, a code read back from disk is one
 * of the closed set or nothing, and a damaged record never reads as a healthy
 * zero. The unjoined case is a gate of its own — it is the failure the report
 * most often exists to name, so it must still produce a document.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { MemberSpool, spoolDirFor } from '@myco/member/spool.js';
import { writeRegistryEntry, type RegistryEntry } from '@myco/member/registry.js';
import { recordMissingMembership } from '@myco/member/no-membership.js';
import { mintId, promptEvent, type EnvelopeContext } from '@myco/member/envelope.js';
import { memberDiagnostics, projectDiagnostics, MAX_REFUSALS_REPORTED } from '@myco/member/diagnostics.js';
import { runExport } from '@myco/cli/member.js';
import { tempMycoHome } from './helpers/server.js';

const NOW = 1_800_000_000_000;
const SECRET = 'mt_thisisaverysecrettokenvalue';

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
beforeEach(() => { mycoHome = tempMycoHome(); process.env.MYCO_HOME = mycoHome; });
const temps: string[] = [];
/** A real project directory the report may name, removed with the rest of the fixture. */
function tempProjectRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-project-')));
  execFileSync('git', ['init', '-q'], { cwd: root });
  temps.push(root);
  return root;
}
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  version: 2,
  projectId: 'proj_1',
  serverUrl: 'https://myco.example.com',
  token: SECRET,
  tokenId: 'mt_abc123',
  memberId: 'mem_dev',
  machineId: 'dev-laptop',
  root: '/home/dev/acme-web',
  joinedAt: NOW - 86_400_000,
  updatedAt: NOW - 86_400_000,
  expiresAt: NOW + 86_400_000,
  ...over,
});

/** A refusal log written straight to disk, so a line can be malformed the way a damaged file is. */
function writeRefusedLog(projectId: string, lines: readonly string[]): void {
  const spool = new MemberSpool(projectId, { mycoHome });
  fs.writeFileSync(path.join(spool.dir, 'refused.jsonl'), lines.join('\n') + '\n', { mode: 0o600 });
}

const refusal = (over: Record<string, unknown> = {}) => JSON.stringify({
  eventId: 'ev_1', sessionId: 'sess_1', kind: 'prompt', code: 'clock_skew', reason: 'the server said /Users/dev/secret.env was ahead', at: NOW, ...over,
});

describe('a member report carries no credential and no captured content', () => {
  it('omits the token, and every field that could hold one', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const report = memberDiagnostics({ mycoHome, now: NOW, entries: [e], missedCapture: [], selection: { root: e.root, scope: 'root' } });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('"token"');
    // The id that names the credential is what correlates the two halves, and is kept.
    expect(report.projects[0]!.membership.tokenId).toBe('mt_abc123');
    expect(report.projects[0]!.membership.machineId).toBe('dev-laptop');
  });

  it('keeps a refusal\'s code and drops the sentence the server sent with it', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    writeRefusedLog('proj_1', [refusal()]);
    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.refusals.entries[0]).toEqual({ eventId: 'ev_1', sessionId: 'sess_1', kind: 'prompt', code: 'clock_skew', at: NOW });
    expect(JSON.stringify(facts)).not.toContain('secret.env');
  });

  it('names what it leaves out', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const report = memberDiagnostics({ mycoHome, now: NOW, entries: [e], missedCapture: [], selection: { root: e.root, scope: 'root' } });
    expect(report.omissions.length).toBeGreaterThan(0);
    expect(report.omissions.join(' ')).toContain('credentials');
  });
});

describe('a code read back from disk is checked against the closed set', () => {
  it('reports a code outside the vocabulary as none, and counts it', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    writeRefusedLog('proj_1', [
      refusal({ code: 'clock_skew' }),
      refusal({ eventId: 'ev_2', code: 'something the server made up' }),
    ]);
    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.refusals.entries.map((r) => r.code)).toEqual(['clock_skew', null]);
    expect(facts.refusals.unknownCodes).toBe(1);
    // The arbitrary string never reaches the report.
    expect(JSON.stringify(facts)).not.toContain('made up');
  });
});

describe('a damaged record is not a healthy zero', () => {
  it('counts the lines it could not read, and still reports the ones it could', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    writeRefusedLog('proj_1', ['{not json', refusal(), 'also not json']);
    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.refusals.loggedSinceLastReset).toBe(1);
    expect(facts.refusals.unreadableLines).toBe(2);
  });

  it('reports no refusals and nothing unreadable when the log does not exist', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.refusals).toMatchObject({ loggedSinceLastReset: 0, unreadableLines: 0, unknownCodes: 0, truncated: false });
  });

  it('says when the log holds more than the report lists', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    writeRefusedLog('proj_1', Array.from({ length: MAX_REFUSALS_REPORTED + 5 }, (_, i) => refusal({ eventId: `ev_${i}` })));
    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.refusals.entries).toHaveLength(MAX_REFUSALS_REPORTED);
    expect(facts.refusals.truncated).toBe(true);
    expect(facts.refusals.loggedSinceLastReset).toBe(MAX_REFUSALS_REPORTED + 5);
  });
});

describe('the latch is reported by its own three fields', () => {
  it('carries only since, nextProbeAt and backoffMs', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    spool.markOffline(NOW);
    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(Object.keys(facts.latch ?? {}).sort()).toEqual(['backoffMs', 'nextProbeAt', 'since']);
  });

  it('reports no latch while the spool is online', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    expect(projectDiagnostics(e, mycoHome, NOW).latch).toBeNull();
  });
});

describe('the report names the roots the caller asked about, and no others', () => {
  it('leaves another project\'s lost capture out of a single-project report', async () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    recordMissingMembership('/home/dev/unrelated-repo', { mycoHome, now: () => NOW, invokedBy: 'hook stop' });
    const lines: string[] = [];
    await runExport([], { mycoHome, now: () => NOW, cwd: e.root, stdout: (l) => lines.push(l), stderr: () => {} });
    const report = JSON.parse(lines.join('\n')) as { missedCapture: { root: string }[] };
    expect(report.missedCapture).toEqual([]);
  });

  it('carries every root with --all', async () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    recordMissingMembership('/home/dev/unrelated-repo', { mycoHome, now: () => NOW, invokedBy: 'hook stop' });
    const lines: string[] = [];
    await runExport(['--all'], { mycoHome, now: () => NOW, cwd: e.root, stdout: (l) => lines.push(l), stderr: () => {} });
    const report = JSON.parse(lines.join('\n')) as { missedCapture: { root: string }[]; selection: { scope: string } };
    expect(report.selection.scope).toBe('all');
    expect(report.missedCapture.map((r) => r.root)).toContain('/home/dev/unrelated-repo');
  });
});

describe('an unjoined project still produces a report', () => {
  it('writes a document naming the root it looked for, with the membership absent', async () => {
    // A real project directory: the export names a root only where one could
    // hold a project, so a path that is only a string is no root at all.
    const project = tempProjectRoot();
    recordMissingMembership(project, { mycoHome, now: () => NOW, invokedBy: 'hook stop' });
    const lines: string[] = [];
    const stderr: string[] = [];
    await runExport([], { mycoHome, now: () => NOW, cwd: project, stdout: (l) => lines.push(l), stderr: (l) => stderr.push(l) });
    const raw = lines.join('\n');
    // Stdout is the document and nothing else: a reader pipes it straight into a file.
    const report = JSON.parse(raw) as {
      bundle: string; buildVersion: string; selection: { root: string | null; scope: string; membershipPresent: boolean };
      projects: unknown[]; missedCapture: { root: string; count: number }[];
    };
    expect(report.bundle).toBe('myco.member.diagnostics');
    expect(report.selection).toMatchObject({ membershipPresent: false, scope: 'root' });
    expect(report.projects).toEqual([]);
    expect(report.missedCapture[0]).toMatchObject({ root: project, count: 1 });
    expect(report.buildVersion.length).toBeGreaterThan(0);
  });
});

it('exports the MCP configuration of the selected project', async () => {
  const project = tempProjectRoot();
  writeRegistryEntry(entry({ root: project }), { mycoHome });
  fs.mkdirSync(path.join(project, '.codex'));
  fs.writeFileSync(path.join(project, '.codex', 'config.toml'), '[mcp_servers.myco]\nurl = "https://myco.example.com/mcp"\n');
  const lines: string[] = [];
  await runExport([], { mycoHome, cwd: project, stdout: (line) => lines.push(line) });
  const report = JSON.parse(lines.join('\n'));
  expect(report.checks).toContainEqual(expect.objectContaining({ symbiont: 'codex', scope: 'project', reason: 'mcp_entry_http' }));
});

describe('a log that could not be read is not an empty one', () => {
  it('says so, rather than reporting no refusals', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    // A directory in place of the log: the read fails for a reason that is not absence.
    fs.mkdirSync(path.join(spool.dir, 'refused.jsonl'));
    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.refusals.logReadable).toBe(false);
    expect(facts.refusals.loggedSinceLastReset).toBe(0);
  });

  it('reads an absent log as no refusals, which it is', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    expect(projectDiagnostics(e, mycoHome, NOW).refusals).toMatchObject({ logReadable: true, loggedSinceLastReset: 0 });
  });

  it('counts a line that parses to something other than an object', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    writeRefusedLog('proj_1', ['null', '"a string"', '[1,2]', '42', refusal()]);
    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.refusals).toMatchObject({ logReadable: true, loggedSinceLastReset: 1, unreadableLines: 4 });
    expect(facts.refusals.entries[0]!.code).toBe('clock_skew');
  });
});

describe('a directory in no project still produces a report', () => {
  it('names every membership with --all and no root', async () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const lines: string[] = [];
    await runExport(['--all'], { mycoHome, now: () => NOW, cwd: '/', stdout: (l) => lines.push(l), stderr: () => {} });
    const report = JSON.parse(lines.join('\n')) as { selection: { root: string | null; scope: string; membershipPresent: boolean }; projects: unknown[] };
    expect(report.selection).toEqual({ root: null, scope: 'all', membershipPresent: true });
    expect(report.projects).toHaveLength(1);
  });

  it('writes a document with no membership for a bare call in no project', async () => {
    const lines: string[] = [];
    await runExport([], { mycoHome, now: () => NOW, cwd: '/', stdout: (l) => lines.push(l), stderr: () => {} });
    const report = JSON.parse(lines.join('\n')) as { bundle: string; selection: { root: string | null; membershipPresent: boolean }; projects: unknown[]; missedCapture: unknown[] };
    expect(report.bundle).toBe('myco.member.diagnostics');
    expect(report.selection.membershipPresent).toBe(false);
    expect(report.projects).toEqual([]);
    expect(report.missedCapture).toEqual([]);
  });

  it('names every membership with --all when the registry holds none', async () => {
    const lines: string[] = [];
    await runExport(['--all'], { mycoHome, now: () => NOW, cwd: '/', stdout: (l) => lines.push(l), stderr: () => {} });
    const report = JSON.parse(lines.join('\n')) as { selection: { scope: string; membershipPresent: boolean }; projects: unknown[]; checks: unknown[] };
    expect(report.selection).toMatchObject({ scope: 'all', membershipPresent: false });
    expect(report.projects).toEqual([]);
    // The checks that describe the machine are still answered.
    expect(Array.isArray(report.checks)).toBe(true);
  });
});

describe('the report states the build it came from', () => {
  it('carries the binary version beside the member protocol', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const report = memberDiagnostics({ mycoHome, now: NOW, entries: [e], missedCapture: [], selection: { root: e.root, scope: 'root' } });
    expect(report.buildVersion.length).toBeGreaterThan(0);
    expect(report.memberProtocol).toBeGreaterThan(0);
  });
});

describe('a spool a report could not read', () => {
  it('reports a session whose own file is unreadable as unknown, not as nothing pending', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    fs.mkdirSync(spool.dir, { recursive: true });
    // A directory where the session's records belong: the read fails for a reason that is not absence.
    fs.mkdirSync(path.join(spool.dir, 'sess-a.jsonl'));

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.spool.readable).toBe(true);
    expect(facts.spool.sessions).toEqual([{ sessionId: 'sess-a', unacknowledged: null, stateReadable: true, lastAckAt: null }]);
    expect(facts.spool.unacknowledgedTotal).toBeNull();
  });

  it('reports a session whose lock path it could not take as unknown, through the export a caller runs', async () => {
    const root = tempProjectRoot();
    const e = entry({ root });
    writeRegistryEntry(e, { mycoHome });
    // A real append: it writes the records AND the session state the report
    // reads the acknowledgement from, both under the same lock.
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx: EnvelopeContext = { agent: 'claude-code', sessionId: 'sess-a', stage: spool.stagerFor('sess-a'), version: '2.0.0-test' };
    spool.append('sess-a', promptEvent(ctx, { promptId: mintId(), text: 'a turn' }));
    expect(fs.existsSync(path.join(spool.dir, 'sess-a.state.json'))).toBe(true);

    // A directory where that lock belongs: every read under it fails.
    const lock = path.join(spool.dir, '.sess-a.lock');
    fs.rmSync(lock, { force: true });
    fs.mkdirSync(lock);

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.spool.readable).toBe(true);
    expect(facts.spool.stateReadable).toBe(false);
    expect(facts.spool.sessions).toEqual([{ sessionId: 'sess-a', unacknowledged: null, stateReadable: false, lastAckAt: null }]);
    expect(facts.spool.unacknowledgedTotal).toBeNull();

    // And the export a person runs answers rather than crashing.
    const lines: string[] = [];
    await runExport([], { mycoHome, now: () => NOW, cwd: root, stdout: (l) => lines.push(l), stderr: () => {} });
    const report = JSON.parse(lines.join('\n')) as { projects: Array<{ spool: { readable: boolean; stateReadable: boolean; unacknowledgedTotal: number | null } }> };
    expect(report.projects[0]!.spool).toMatchObject({ readable: true, stateReadable: false, unacknowledgedTotal: null });
  });

  it('reports a spool directory it could not read as unknown, leaving the layout as it found it', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const broken = spoolDirFor('proj_1', mycoHome);
    fs.rmSync(broken, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    // A file where the spool directory belongs: listing it fails with ENOTDIR.
    fs.writeFileSync(broken, 'not a directory', 'utf-8');

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.spool.readable).toBe(false);
    expect(facts.spool.sessionFiles).toBe(0);
    expect(facts.spool.unacknowledgedTotal).toBeNull();
    // The report read the layout and did not repair it.
    expect(fs.statSync(broken).isFile()).toBe(true);
    expect(fs.readFileSync(broken, 'utf-8')).toBe('not a directory');
  });

  it('reads an absent spool directory as the empty one it is', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    fs.rmSync(spoolDirFor('proj_1', mycoHome), { recursive: true, force: true });

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.spool).toMatchObject({ readable: true, sessionFiles: 0, unacknowledgedTotal: 0 });
  });
});

describe('a refusal record short of a field it is read by', () => {
  it('counts it unreadable rather than reporting a blank id at the epoch', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    fs.mkdirSync(spool.dir, { recursive: true });
    const whole = { eventId: 'ev-1', sessionId: 'sess-a', kind: 'prompt', code: 'refused', reason: 'no', at: NOW };
    fs.writeFileSync(path.join(spool.dir, 'refused.jsonl'), [
      JSON.stringify(whole),
      '{}',
      JSON.stringify({ ...whole, at: 'bad' }),
      JSON.stringify({ ...whole, sessionId: '' }),
    ].join('\n'), 'utf-8');

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.refusals.logReadable).toBe(true);
    expect(facts.refusals.loggedSinceLastReset).toBe(1);
    expect(facts.refusals.unreadableLines).toBe(3);
  });
});

describe('a refusal the drain raised against an unparsable spool line', () => {
  it('reaches the report naming no event and no kind, rather than counting as a damaged line', async () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    fs.writeFileSync(path.join(spool.dir, 'sess-a.jsonl'), 'not json\n', 'utf-8');
    // The record never parses, so the drain refuses it without reaching a server.
    const client = { send: () => { throw new Error('a line that cannot be parsed reaches no server'); } };
    const budget = { deadline: NOW + 60_000, connectTimeoutMs: 1_000, drains: true } as never;
    const result = await spool.drainSession('sess-a', client as never, budget, { now: () => NOW });
    expect(result.refused).toBe(1);

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.refusals.unreadableLines).toBe(0);
    expect(facts.refusals.entries).toEqual([{ eventId: null, sessionId: 'sess-a', kind: null, code: 'refused', at: NOW }]);
  });
});

describe('a session state the report could not use', () => {
  it('reports the acknowledgement unknown, and withholds a spool total that would read as the whole', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    fs.writeFileSync(path.join(spool.dir, 'sess-a.jsonl'), '', 'utf-8');
    // Parsable JSON that is not a state: the file is there and holds nothing the report can read.
    fs.writeFileSync(path.join(spool.dir, 'sess-a.state.json'), JSON.stringify({ version: 'wrong' }), { mode: 0o600 });

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.spool.readable).toBe(true);
    expect(facts.spool.stateReadable).toBe(false);
    expect(facts.spool.lastAckAt).toBeNull();
    expect(facts.spool.sessions).toEqual([{ sessionId: 'sess-a', unacknowledged: null, stateReadable: false, lastAckAt: null }]);
  });
});

describe('an offline latch the report could not use', () => {
  it('says whether this member is holding off is unknown, rather than reporting it online', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    fs.writeFileSync(path.join(spool.dir, 'offline.json'), JSON.stringify({ since: 'soon' }), { mode: 0o600 });

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.latchReadable).toBe(false);
    expect(facts.latch).toBeNull();
  });

  it('says unknown for a latch file holding null, rather than throwing on its fields', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    fs.writeFileSync(path.join(spool.dir, 'offline.json'), 'null', { mode: 0o600 });

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.latchReadable).toBe(false);
    expect(facts.latch).toBeNull();
  });

  it('reads an absent latch as the member being online, which it is', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    new MemberSpool('proj_1', { mycoHome });

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.latchReadable).toBe(true);
    expect(facts.latch).toBeNull();
  });
});

describe('a state file the report can reach but cannot trust', () => {
  it('leaves the pending count unknown rather than counting every record as un-acknowledged', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    fs.writeFileSync(path.join(spool.dir, 'sess-a.jsonl'), ['{"a":1}', '{"a":2}'].join('\n') + '\n', 'utf-8');
    // A state whose acknowledged mark is unusable: counting from zero here would
    // report two records pending on a session that may have shipped both.
    fs.writeFileSync(path.join(spool.dir, 'sess-a.state.json'), JSON.stringify({ version: 1, highWater: 'two', prompts: {} }), { mode: 0o600 });

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.spool.sessions).toEqual([{ sessionId: 'sess-a', unacknowledged: null, stateReadable: false, lastAckAt: null }]);
    expect(facts.spool.unacknowledgedTotal).toBeNull();
    expect(facts.spool.stateReadable).toBe(false);
  });

  it('refuses a state whose acknowledgement is not an instant, so no surface renders it', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    fs.writeFileSync(path.join(spool.dir, 'sess-a.jsonl'), '', 'utf-8');
    fs.writeFileSync(path.join(spool.dir, 'sess-a.state.json'), JSON.stringify({ version: 1, highWater: 0, prompts: {}, lastAckAt: 'yesterday' }), { mode: 0o600 });

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.spool.stateReadable).toBe(false);
    expect(facts.spool.lastAckAt).toBeNull();
    expect(facts.spool.sessions[0]!.lastAckAt).toBeNull();
  });
});

describe('a private file that is there and cannot be opened', () => {
  it('reads as unreadable rather than as absent', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    fs.writeFileSync(path.join(spool.dir, 'sess-a.jsonl'), '', 'utf-8');
    // A directory where the state file belongs: stat succeeds, the open does not.
    fs.mkdirSync(path.join(spool.dir, 'sess-a.state.json'));

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.spool.stateReadable).toBe(false);
    expect(facts.spool.sessions[0]!.stateReadable).toBe(false);
  });
});

describe('a directory belonging to no project', () => {
  it('names no root, so a bare export does not report the directory it was run from', async () => {
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bare-')));
    temps.push(bare);
    const lines: string[] = [];
    await runExport([], { mycoHome, now: () => NOW, cwd: bare, stdout: (l) => lines.push(l), stderr: () => {} });
    const report = JSON.parse(lines.join('\n')) as { selection: { root: string | null; membershipPresent: boolean } };
    expect(report.selection).toMatchObject({ root: null, membershipPresent: false });
  });
});

describe('a check the report cannot tell apart from another', () => {
  it('carries the reason, the symbiont and the scope it read, and none of its sentence', () => {
    const facts = memberDiagnostics({
      mycoHome, now: NOW, entries: [], missedCapture: [],
      selection: { root: null, scope: 'root' },
      checks: [
        { name: 'Member MCP resolution', status: 'warn', reason: 'home_pin_missing', symbiont: null, scope: null, fixable: false, fixId: null },
        { name: 'Member MCP resolution', status: 'ok', reason: 'mcp_entry_http', symbiont: 'claude-code', scope: 'global', fixable: false, fixId: null },
        { name: 'Member MCP resolution', status: 'ok', reason: 'mcp_entry_http', symbiont: 'claude-code', scope: 'project', fixable: false, fixId: null },
        { name: 'Member MCP resolution', status: 'warn', reason: 'mcp_target_unreadable', symbiont: 'cursor', scope: 'global', fixable: false, fixId: null },
      ],
    });

    // Each scope stays its own line: a reader sees where the entry was found,
    // and the export decides no precedence between them.
    expect(facts.checks).toEqual([
      { name: 'Member MCP resolution', status: 'warn', reason: 'home_pin_missing', symbiont: null, scope: null, fixable: false, fixId: null },
      { name: 'Member MCP resolution', status: 'ok', reason: 'mcp_entry_http', symbiont: 'claude-code', scope: 'global', fixable: false, fixId: null },
      { name: 'Member MCP resolution', status: 'ok', reason: 'mcp_entry_http', symbiont: 'claude-code', scope: 'project', fixable: false, fixId: null },
      { name: 'Member MCP resolution', status: 'warn', reason: 'mcp_target_unreadable', symbiont: 'cursor', scope: 'global', fixable: false, fixId: null },
    ]);
  });
});
