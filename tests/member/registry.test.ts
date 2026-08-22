/**
 * Registry and member store: 0700 dirs, 0600 files, atomic writes under the
 * registry lock, fail-closed reads (a 0644 entry is skipped by name, malformed
 * JSON is skipped), lookup by the worktree-aware root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { listRegistryEntries, projectsDir, readRegistryEntry, registryEntryPath, registryKeyFor, removeRegistryEntry, writeRegistryEntry, REGISTRY_VERSION, type RegistryEntry } from '@myco/member/registry.js';
import { ensureMemberDir, memberRoot } from '@myco/member/store.js';
import { MemberSpool } from '@myco/member/spool.js';
import { tempMycoHome } from './helpers/server.js';

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
const stderrLines: string[] = [];
const origErr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  stderrLines.length = 0;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = ((c: unknown) => { stderrLines.push(String(c)); return true; }) as never;
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  (process.stderr as unknown as { write: unknown }).write = origErr;
});

const mode = (p: string) => fs.statSync(p).mode & 0o777;
const entryFor = (root: string, over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl: 'https://s.example', token: 'tok', tokenId: 'mt_1', root, machineId: 'm1', joinedAt: 1, updatedAt: 1, ...over,
});

describe('member registry', () => {
  it('writes 0700 directories and a 0600 entry, atomically, keyed by the root hash', () => {
    const root = path.join(mycoHome, 'repo');
    writeRegistryEntry(entryFor(root), { mycoHome });
    expect(mode(memberRoot(mycoHome))).toBe(0o700);
    expect(mode(projectsDir(mycoHome))).toBe(0o700);
    const file = registryEntryPath(root, mycoHome);
    expect(path.basename(file)).toBe(`${registryKeyFor(root)}.json`);
    expect(mode(file)).toBe(0o600);
    expect(mode(path.join(projectsDir(mycoHome), '.lock'))).toBe(0o600);
    expect(fs.readdirSync(projectsDir(mycoHome)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readRegistryEntry(root, mycoHome)).toEqual(entryFor(root));
  });

  it('reads fail closed: a 0644 entry is skipped by name, malformed JSON is skipped, a foreign root is skipped', () => {
    const root = path.join(mycoHome, 'repo');
    writeRegistryEntry(entryFor(root), { mycoHome });
    fs.chmodSync(registryEntryPath(root, mycoHome), 0o644);
    expect(readRegistryEntry(root, mycoHome)).toBeNull();
    expect(stderrLines.join('')).toContain('registry entry skipped (loose-mode: 644)');
    fs.chmodSync(registryEntryPath(root, mycoHome), 0o600);
    fs.writeFileSync(registryEntryPath(root, mycoHome), '{not json', { mode: 0o600 });
    expect(readRegistryEntry(root, mycoHome)).toBeNull();
    expect(stderrLines.join('')).toContain('malformed');
    const other = path.join(mycoHome, 'other');
    writeRegistryEntry(entryFor(other), { mycoHome });
    fs.copyFileSync(registryEntryPath(other, mycoHome), registryEntryPath(root, mycoHome));
    expect(readRegistryEntry(root, mycoHome)).toBeNull();
    expect(stderrLines.join('')).toContain('root mismatch');
    expect(listRegistryEntries(mycoHome).map((e) => e.root)).toEqual([other]);
  });

  it('removes an entry and lists the rest', () => {
    const a = path.join(mycoHome, 'a');
    const b = path.join(mycoHome, 'b');
    writeRegistryEntry(entryFor(a), { mycoHome });
    writeRegistryEntry(entryFor(b, { projectId: 'proj_2' }), { mycoHome });
    expect(listRegistryEntries(mycoHome).map((e) => e.projectId).sort()).toEqual(['proj_1', 'proj_2']);
    expect(removeRegistryEntry(a, mycoHome)).toBe(true);
    expect(removeRegistryEntry(a, mycoHome)).toBe(false);
    expect(listRegistryEntries(mycoHome).map((e) => e.projectId)).toEqual(['proj_2']);
  });

  it('ensureMemberDir refuses a path outside the member root and fixes a loose mode', () => {
    expect(() => ensureMemberDir(path.join(mycoHome, 'elsewhere'), mycoHome)).toThrow('outside the member root');
    const dir = path.join(memberRoot(mycoHome), 'x', 'y');
    ensureMemberDir(dir, mycoHome);
    fs.chmodSync(dir, 0o755);
    ensureMemberDir(dir, mycoHome);
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(memberRoot(mycoHome), 'x'))).toBe(0o700);
  });

  it('the spool creates its dirs 0700 and its files 0600 before any lock or buffer touches them', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    expect(mode(spool.dir)).toBe(0o700);
    expect(mode(spool.blobsDir)).toBe(0o700);
    spool.append('sess-1', { envelope: { eventId: '00000000-0000-7000-8000-000000000001', sessionId: 'sess-1', kind: 'session.end', createdAt: 1, channel: 'cli', producer: { adapter: 'a', version: '1' }, payload: {} } });
    expect(mode(path.join(spool.dir, 'sess-1.jsonl'))).toBe(0o600);
    expect(mode(path.join(spool.dir, '.sess-1.lock'))).toBe(0o600);
    const staged = spool.stagerFor('sess-1')(new Uint8Array([1, 2, 3]), 'application/octet-stream');
    expect(mode(staged.path)).toBe(0o600);
    spool.markOffline(Date.now());
    expect(mode(path.join(spool.dir, 'offline.json'))).toBe(0o600);
    spool.appendRefused({ eventId: 'e', sessionId: 'sess-1', kind: 'k', code: 'refused', reason: 'r', at: 1 });
    expect(mode(path.join(spool.dir, 'refused.jsonl'))).toBe(0o600);
  });
});
