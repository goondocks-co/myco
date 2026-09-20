import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listRegistryEntriesResult, readRegistryEntryResult, registryEntryPath, writeRegistryEntry } from '@myco/member/registry.js';
import { listMissingMembershipsResult, readMissingMembershipResult, missingMembershipPath, recordMissingMembership } from '@myco/member/no-membership.js';

const roots: string[] = [];
const projectRoot = '/diagnostic-project';
function fixture(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-diagnostic-directories-'));
  roots.push(home);
  fs.mkdirSync(path.join(home, 'member'), { mode: 0o700 });
  return home;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('diagnostic directory availability', () => {
  it('reports directories never created as readable and empty', () => {
    const home = fixture();
    expect(listRegistryEntriesResult(home)).toEqual({ readable: true, entries: [], unavailableEntries: 0 });
    expect(listMissingMembershipsResult(home)).toEqual({ readable: true, records: [], unavailableRecords: 0 });
  });

  it('reports dangling directory entries as unavailable without creating their targets', () => {
    const home = fixture();
    for (const name of ['projects', 'unmembered']) {
      const target = path.join(home, `absent-${name}`);
      fs.symlinkSync(target, path.join(home, 'member', name));
    }
    expect(listRegistryEntriesResult(home).readable).toBe(false);
    expect(listMissingMembershipsResult(home).readable).toBe(false);
    expect(readRegistryEntryResult(projectRoot, home).status).toBe('unavailable');
    expect(readMissingMembershipResult(projectRoot, home).status).toBe('unavailable');
    expect(fs.readdirSync(home).sort()).toEqual(['member']);
  });

  it('refuses listed files linked outside the member directory', () => {
    const home = fixture();
    const now = Date.now();
    writeRegistryEntry({ version: 2, projectId: 'proj_1', serverUrl: 'https://diagnostic.example', token: 'synthetic-token', tokenId: 'token_1', memberId: 'member_1', machineId: 'machine_1', root: projectRoot, joinedAt: now, updatedAt: now }, { mycoHome: home });
    recordMissingMembership(projectRoot, { mycoHome: home, now: () => now, invokedBy: 'test' });
    const files = [registryEntryPath(projectRoot, home), missingMembershipPath(projectRoot, home)];
    for (const [index, file] of files.entries()) {
      const target = path.join(home, `external-${index}.json`);
      fs.renameSync(file, target);
      fs.symlinkSync(target, file);
    }
    const before = fs.readdirSync(home).sort();
    expect(listRegistryEntriesResult(home)).toMatchObject({ readable: true, entries: [], unavailableEntries: 1 });
    expect(listMissingMembershipsResult(home)).toMatchObject({ readable: true, records: [], unavailableRecords: 1 });
    expect(readRegistryEntryResult(projectRoot, home).status).toBe('unavailable');
    expect(readMissingMembershipResult(projectRoot, home).status).toBe('unavailable');
    expect(fs.readdirSync(home).sort()).toEqual(before);
  });
});
