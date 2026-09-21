/**
 * `member status` reads the registry the way a report does.
 *
 * Status and export answer the same question about the same files, so both take
 * the same strict selection: a damaged entry is named as one nothing could read,
 * never as a root that never joined. The commands that act keep `entriesFor`,
 * which reads through the runtime path and may migrate. Nothing here writes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runStatus } from '@myco/cli/member.js';
import { registryEntryPath, writeRegistryEntry, type RegistryEntry } from '@myco/member/registry.js';
import { missingMembershipPath, recordMissingMembership } from '@myco/member/no-membership.js';
import { tempMycoHome } from '../member/helpers/server.js';

const NOW = 1_800_000_000_000;

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
const temps: string[] = [];
beforeEach(() => { mycoHome = tempMycoHome(); process.env.MYCO_HOME = mycoHome; });
afterEach(() => {
  if (savedHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedHome;
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempProjectRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-status-')));
  execFileSync('git', ['init', '-q'], { cwd: root });
  temps.push(root);
  return root;
}

const entry = (root: string): RegistryEntry => ({
  version: 2, projectId: 'proj_1', serverUrl: 'https://deployment.example', token: 'mt_thisisaverysecrettokenvalue',
  tokenId: 'mt_abc123', memberId: 'mem_dev', machineId: 'dev-laptop', root, joinedAt: NOW, updatedAt: NOW,
});

/** Runs status over `cwd` and returns what each stream received. */
function status(args: readonly string[], cwd: string): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  runStatus(args, { mycoHome, cwd, now: () => NOW, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { out, err };
}

/** An entry file that is there and holds nothing a read can use. */
const damage = (root: string) => fs.writeFileSync(registryEntryPath(root, mycoHome), '{"nope":1}', { mode: 0o600 });

describe('a registry entry status could not read', () => {
  it('says so rather than that the project never joined', () => {
    const root = tempProjectRoot();
    writeRegistryEntry(entry(root), { mycoHome });
    damage(root);

    const { out, err } = status([], root);
    expect(err.join('\n')).toContain('could not be read');
    expect(err.join('\n')).not.toContain('no registry entry');
    expect(out.join('\n')).not.toContain('project:');
  });

  it('counts what it could not read with --all, and still prints the memberships it could', () => {
    const good = tempProjectRoot();
    const bad = tempProjectRoot();
    writeRegistryEntry(entry(good), { mycoHome });
    writeRegistryEntry({ ...entry(bad), projectId: 'proj_2' }, { mycoHome });
    damage(bad);

    const { out } = status(['--all'], good);
    expect(out.join('\n')).toContain('registry:   1 entry could not be read');
    expect(out.filter((l) => l.startsWith('project:'))).toHaveLength(1);
  });

  it('keeps the message that says what to do when the entry is genuinely absent', () => {
    const root = tempProjectRoot();

    const { err } = status([], root);
    expect(err.join('\n')).toContain('no registry entry');
    expect(err.join('\n')).toContain('myco member join');
  });

  it('names a directory belonging to no project as one', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bare-')));
    temps.push(outside);

    const { err } = status([], outside);
    expect(err.join('\n')).toContain('belongs to no project');
  });

  it('names a registry directory it could not list, not an entry', () => {
    const root = tempProjectRoot();
    writeRegistryEntry(entry(root), { mycoHome });
    // A file where the projects directory belongs: the listing fails for a reason that is not absence.
    const dir = path.dirname(registryEntryPath(root, mycoHome));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'not a directory', { mode: 0o600 });

    const { err } = status(['--all'], root);
    expect(err.join('\n')).toContain('the registry directory could not be read');
    expect(err.join('\n')).not.toContain('null');
  });

  it('writes nothing while it reads', () => {
    const root = tempProjectRoot();
    writeRegistryEntry(entry(root), { mycoHome });
    const file = registryEntryPath(root, mycoHome);
    const before = fs.statSync(file).mtimeMs;

    status([], root);

    expect(fs.statSync(file).mtimeMs).toBe(before);
  });
});

describe('a missed-capture record status could not use', () => {
  /** A record file for `at`, holding whatever is given. */
  function writeRecordAt(at: string, value: unknown): void {
    recordMissingMembership(at, { mycoHome, now: () => NOW, invokedBy: 'hook stop' });
    fs.writeFileSync(missingMembershipPath(at, mycoHome), JSON.stringify(value), { mode: 0o600 });
  }

  it('says unknown rather than printing a count nothing can stand behind', () => {
    const root = tempProjectRoot();
    writeRegistryEntry(entry(root), { mycoHome });
    writeRecordAt(root, { version: 1, root, count: -3, firstAt: NOW, lastAt: NOW });

    const { out } = status([], root);
    expect(out.join('\n')).toContain('unmembered: unknown');
    expect(out.join('\n')).not.toContain('-3 hook invocation');
  });

  it('says unknown rather than dating a record from an instant it cannot render', () => {
    const root = tempProjectRoot();
    writeRegistryEntry(entry(root), { mycoHome });
    writeRecordAt(root, { version: 1, root, count: 2, firstAt: NOW, lastAt: 8.65e15 });

    const { out } = status([], root);
    expect(out.join('\n')).toContain('unmembered: unknown');
    expect(out.join('\n')).not.toContain('Invalid Date');
  });

  it('never names another project, reporting a record keyed to one root and naming another', () => {
    const mine = tempProjectRoot();
    writeRegistryEntry(entry(mine), { mycoHome });
    writeRecordAt(mine, { version: 1, root: '/home/dev/theirs', count: 4, firstAt: NOW, lastAt: NOW });

    const { out } = status([], mine);
    expect(out.join('\n')).toContain('unmembered: unknown');
    expect(out.join('\n')).not.toContain('/home/dev/theirs');
  });

  it('counts what it could not read with --all, and still reports the misses it could', () => {
    const good = tempProjectRoot();
    const bad = tempProjectRoot();
    writeRegistryEntry(entry(good), { mycoHome });
    writeRecordAt(good, { version: 1, root: good, count: 2, firstAt: NOW, lastAt: NOW });
    writeRecordAt(bad, { version: 1, root: bad, count: -1, firstAt: NOW, lastAt: NOW });

    const { out } = status(['--all'], good);
    expect(out.join('\n')).toContain(`2 hook invocation(s) found no registry entry for ${good}`);
    expect(out.join('\n')).toContain('unmembered: 1 record(s) could not be read');
  });

  it('keeps the guidance a whole record carries', () => {
    const root = tempProjectRoot();
    writeRegistryEntry(entry(root), { mycoHome });
    writeRecordAt(root, { version: 1, root, count: 5, firstAt: NOW, lastAt: NOW });

    const { out } = status([], root);
    expect(out.join('\n')).toContain(`5 hook invocation(s) found no registry entry for ${root}`);
    expect(out.join('\n')).not.toContain('unmembered: unknown');
  });

  it('answers for a directory belonging to no project without reading a record', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bare-')));
    temps.push(outside);

    expect(() => status([], outside)).not.toThrow();
  });
});
