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
import { MemberSpool } from '@myco/member/spool.js';
import { writeRegistryEntry, type RegistryEntry } from '@myco/member/registry.js';
import { recordMissingMembership } from '@myco/member/no-membership.js';
import { memberDiagnostics, projectDiagnostics, MAX_REFUSALS_REPORTED } from '@myco/member/diagnostics.js';
import { runExport } from '@myco/cli/member.js';
import { tempMycoHome } from './helpers/server.js';

const NOW = 1_800_000_000_000;
const SECRET = 'mt_thisisaverysecrettokenvalue';

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
beforeEach(() => { mycoHome = tempMycoHome(); process.env.MYCO_HOME = mycoHome; });
afterEach(() => { process.env.MYCO_HOME = savedHome; });

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
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-unjoined-')));
    execFileSync('git', ['init', '-q'], { cwd: project });
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
