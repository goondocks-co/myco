import { afterEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rootTopologyWitnesses, filesystemWitnesses, filesystemWitnessesCurrent } from '@myco/utils/filesystem-proof.js';

const roots: string[] = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-fs-proof-'));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('a parent witness detects a repository entry replaced by an alias', () => {
  const root = fixture();
  const parent = path.join(root, 'parent');
  fs.mkdirSync(parent);
  fs.mkdirSync(path.join(parent, 'repo'));
  const proof = rootTopologyWitnesses([path.join(parent, 'repo'), path.join(parent, 'repo')]);
  expect(proof).toEqual(rootTopologyWitnesses([path.join(parent, 'repo')]));
  expect(filesystemWitnessesCurrent(proof)).toBe(true);
  fs.renameSync(path.join(parent, 'repo'), path.join(parent, 'saved'));
  fs.symlinkSync(path.join(parent, 'saved'), path.join(parent, 'repo'), 'junction');
  expect(filesystemWitnessesCurrent(proof)).toBe(false);
});

it('a parent witness follows and detects an ancestor retarget', () => {
  const root = fixture();
  const original = path.join(root, 'original');
  const replacement = path.join(root, 'replacement');
  for (const dir of [original, replacement]) fs.mkdirSync(path.join(dir, 'parent'), { recursive: true });
  const link = path.join(root, 'link');
  fs.symlinkSync(original, link, 'junction');
  const proof = rootTopologyWitnesses([path.join(link, 'parent')]);
  fs.unlinkSync(link);
  fs.symlinkSync(replacement, link, 'junction');
  expect(filesystemWitnessesCurrent(proof)).toBe(false);
});

it('topology witnesses ignore directory metadata changes that preserve identity', () => {
  const root = fixture();
  const proof = rootTopologyWitnesses([root]);
  fs.writeFileSync(path.join(root, 'new-file'), 'data');
  expect(filesystemWitnessesCurrent(proof)).toBe(true);
});

it('birthtime distinguishes a replaced component with a reused device and inode', () => {
  const root = fixture();
  const lstat = fs.lstatSync;
  let birthtimeNs = 1n;
  const probe = spyOn(fs, 'lstatSync').mockImplementation(((at: fs.PathLike) => {
    const stat = lstat(at, { bigint: true });
    return String(at) === root ? Object.assign(stat, { birthtimeNs }) : stat;
  }) as typeof fs.lstatSync);
  try {
    const proof = rootTopologyWitnesses([root]);
    expect(filesystemWitnessesCurrent(proof)).toBe(true);
    birthtimeNs = 2n;
    expect(filesystemWitnessesCurrent(proof)).toBe(false);
  } finally { probe.mockRestore(); }
});

it('a component without birthtime uses its parent metadata to detect replacement', () => {
  const parent = fixture();
  const root = path.join(parent, 'repo');
  fs.mkdirSync(root);
  const lstat = fs.lstatSync;
  let changed = false;
  const probe = spyOn(fs, 'lstatSync').mockImplementation(((at: fs.PathLike) => {
    const stat = lstat(at, { bigint: true });
    if (String(at) === root) return Object.assign(stat, { birthtimeNs: 0n });
    if (String(at) === parent && changed) return Object.assign(stat, { mtimeNs: stat.mtimeNs + 1n, ctimeNs: stat.ctimeNs + 1n });
    return stat;
  }) as typeof fs.lstatSync);
  try {
    const proof = rootTopologyWitnesses([root]);
    expect(filesystemWitnessesCurrent(proof)).toBe(true);
    changed = true;
    expect(filesystemWitnessesCurrent(proof)).toBe(false);
  } finally { probe.mockRestore(); }
});

it('metadata witnesses reject in-place edits and malformed derived witnesses', () => {
  const root = fixture();
  const file = path.join(root, 'meta.json');
  fs.writeFileSync(file, '{}');
  const proof = filesystemWitnesses([], [file]);
  expect(filesystemWitnessesCurrent(proof)).toBe(true);
  fs.writeFileSync(file, '{"changed":true}');
  expect(filesystemWitnessesCurrent(proof)).toBe(false);
  expect(filesystemWitnessesCurrent([{ at: path.join(root, 'absent'), kind: 'file', stamp: '' }])).toBe(false);
});
