/**
 * A project id names one directory under the spool root, never a path.
 *
 * A report builds a spool from whatever id a registry entry carries, and reads
 * it without making its directories — so containment cannot live in the write
 * that creates them. `spoolDirFor` holds it at the path, and the registry's own
 * read refuses an entry whose id is outside the grammar, so a crafted entry
 * neither reads a file outside the member root nor leaves a lock there.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemberSpool, spoolDirFor } from '@myco/member/spool.js';
import { isProjectId } from '@myco/member/constants.js';
import {
  listRegistryEntriesResult, readRegistryEntryResult, registryEntryPath, writeRegistryEntry, type RegistryEntry,
} from '@myco/member/registry.js';
import { tempMycoHome } from './helpers/server.js';

const NOW = 1_800_000_000_000;
const ROOT = '/home/dev/acme-web';

let mycoHome: string;
let outside: string;
const savedHome = process.env.MYCO_HOME;
const temps: string[] = [];
beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-outside-')));
  temps.push(outside);
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedHome;
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (projectId: string): RegistryEntry => ({
  version: 2, projectId, serverUrl: 'https://deployment.example', token: 'mt_thisisaverysecrettokenvalue',
  tokenId: 'mt_abc123', memberId: 'mem_dev', machineId: 'dev-laptop', root: ROOT, joinedAt: NOW, updatedAt: NOW,
});

/** Every path under `dir`, so a read that created one is visible. */
function tree(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    out.push(full);
    if (fs.statSync(full).isDirectory()) out.push(...tree(full));
  }
  return out.sort();
}

describe('an id that is a path, not a project', () => {
  const escapes = ['../../escape', '..', '.', '/etc', 'a/b', '..\\escape'];

  it('is refused by the grammar the spool path holds it to', () => {
    for (const id of escapes) expect(isProjectId(id)).toBe(false);
  });

  it('names no directory, whether or not one would be made', () => {
    for (const id of escapes) {
      expect(() => spoolDirFor(id, mycoHome)).toThrow();
      expect(() => new MemberSpool(id, { mycoHome })).toThrow();
      expect(() => new MemberSpool(id, { mycoHome, initialize: false })).toThrow();
    }
  });

  it('leaves the directory it would have escaped into untouched', () => {
    const marker = path.join(outside, 'keep.txt');
    fs.writeFileSync(marker, 'untouched', 'utf-8');
    const before = tree(outside);

    // The id a crafted entry would carry to reach `outside`.
    const rel = path.relative(path.join(mycoHome, 'member', 'spool'), outside);
    expect(() => new MemberSpool(rel, { mycoHome, initialize: false })).toThrow();

    expect(tree(outside)).toEqual(before);
    expect(fs.readFileSync(marker, 'utf-8')).toBe('untouched');
  });
});

describe('a registry entry carrying such an id', () => {
  /** Writes a well-formed entry, then replaces its project id with `projectId`. */
  function craft(projectId: string): void {
    writeRegistryEntry(entry('proj_1'), { mycoHome });
    const file = registryEntryPath(ROOT, mycoHome);
    const held = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...held, projectId }), { mode: 0o600 });
  }

  it('is unavailable to a report rather than resolved into a path', () => {
    craft('../../escape');

    expect(readRegistryEntryResult(ROOT, mycoHome)).toEqual({ status: 'unavailable' });
    const listed = listRegistryEntriesResult(mycoHome);
    expect(listed.entries).toEqual([]);
    expect(listed).toMatchObject({ readable: true, unavailableEntries: 1 });
  });

  it('creates no lock and no file outside the member root while a report reads', () => {
    const marker = path.join(outside, 'keep.txt');
    fs.writeFileSync(marker, 'untouched', 'utf-8');
    const before = tree(outside);
    craft(path.relative(path.join(mycoHome, 'member', 'spool'), outside));

    readRegistryEntryResult(ROOT, mycoHome);
    listRegistryEntriesResult(mycoHome);

    expect(tree(outside)).toEqual(before);
  });
});

describe('an id a project really carries', () => {
  it('still names its own directory under the spool root, and reads it', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    expect(spool.dir).toBe(path.join(mycoHome, 'member', 'spool', 'proj_1'));
    expect(spool.readSpool()).toEqual({ readable: true, sessions: [] });

    writeRegistryEntry(entry('proj_1'), { mycoHome });
    expect(readRegistryEntryResult(ROOT, mycoHome)).toMatchObject({ status: 'present' });
    expect(listRegistryEntriesResult(mycoHome).entries.map((e) => e.projectId)).toEqual(['proj_1']);
  });

  it('admits the punctuation the grammar allows', () => {
    for (const id of ['proj_1', 'a.b-c_d', 'A'.repeat(64)]) {
      expect(isProjectId(id)).toBe(true);
      expect(spoolDirFor(id, mycoHome)).toBe(path.join(mycoHome, 'member', 'spool', id));
    }
  });
});
