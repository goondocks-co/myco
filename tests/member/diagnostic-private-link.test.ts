/**
 * A file entry that is there and leads nowhere is not an absent one.
 *
 * `stat` follows a link, so a dangling one answers ENOENT for its target and a
 * reader that stops there calls the entry missing — a state file that was never
 * written and one pointing at nothing become the same answer. The report's
 * readers turn that into "nothing has happened here" for a machine whose files
 * are broken. `lstat` answers for the entry itself, so the two are told apart.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { readPrivateJson } from '@myco/member/store.js';
import { readRegistryEntryResult, registryEntryPath, writeRegistryEntry, type RegistryEntry } from '@myco/member/registry.js';
import { readSessionStateResultUnlocked, sessionStatePath } from '@myco/member/session-state.js';
import { spoolDirFor } from '@myco/member/spool.js';
import { tempMycoHome } from './helpers/server.js';

const NOW = 1_800_000_000_000;
const ROOT = '/home/dev/acme-web';

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
beforeEach(() => { mycoHome = tempMycoHome(); process.env.MYCO_HOME = mycoHome; });
afterEach(() => {
  if (savedHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedHome;
});

const entry = (): RegistryEntry => ({
  version: 2, projectId: 'proj_1', serverUrl: 'https://deployment.example', token: 'mt_thisisaverysecrettokenvalue',
  tokenId: 'mt_abc123', memberId: 'mem_dev', machineId: 'dev-laptop', root: ROOT, joinedAt: NOW, updatedAt: NOW,
});

/** Replaces `file` with a link to a path that does not exist. */
function danglingLink(file: string): void {
  fs.rmSync(file, { force: true });
  fs.symlinkSync(path.join(path.dirname(file), 'gone.json'), file);
}

describe('readPrivateJson tells an entry that leads nowhere from one that is not there', () => {
  it('reads a file never written as missing', () => {
    expect(readPrivateJson(path.join(mycoHome, 'absent.json'))).toEqual({ ok: false, reason: 'missing' });
  });

  it('reads a whole private file as its value', () => {
    const file = path.join(mycoHome, 'held.json');
    fs.writeFileSync(file, JSON.stringify({ a: 1 }), { mode: 0o600 });

    expect(readPrivateJson(file)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('reads a link to nothing as unreadable, not as missing', () => {
    const file = path.join(mycoHome, 'linked.json');
    danglingLink(file);

    const read = readPrivateJson(file);
    expect(read.ok).toBe(false);
    expect(read).toMatchObject({ reason: 'unreadable' });
  });
});

describe('a report reading a link to nothing', () => {
  it('answers unavailable for a registry entry, rather than one never joined', () => {
    writeRegistryEntry(entry(), { mycoHome });
    danglingLink(registryEntryPath(ROOT, mycoHome));

    expect(readRegistryEntryResult(ROOT, mycoHome)).toEqual({ status: 'unavailable' });
  });

  it('answers unavailable for a session state, rather than one never written', () => {
    const dir = spoolDirFor('proj_1', mycoHome);
    fs.mkdirSync(dir, { recursive: true });
    const file = sessionStatePath(dir, 'sess-a');
    fs.writeFileSync(file, JSON.stringify({ version: 1, highWater: 2, prompts: {} }), { mode: 0o600 });
    danglingLink(file);

    const read = readSessionStateResultUnlocked(dir, 'sess-a');
    expect(read.ok).toBe(false);
    expect(read).toMatchObject({ reason: 'unreadable' });
  });

  it('still reads a state never written as missing', () => {
    const dir = spoolDirFor('proj_1', mycoHome);
    fs.mkdirSync(dir, { recursive: true });

    expect(readSessionStateResultUnlocked(dir, 'sess-a')).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('creates nothing while it reads', () => {
    const file = path.join(mycoHome, 'linked.json');
    danglingLink(file);
    const before = fs.readdirSync(mycoHome).sort();

    readPrivateJson(file);

    expect(fs.readdirSync(mycoHome).sort()).toEqual(before);
    expect(fs.existsSync(path.join(mycoHome, 'gone.json'))).toBe(false);
  });
});
