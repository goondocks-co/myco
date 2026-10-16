import { afterEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { directoryWitnesses, filesystemWitnesses, filesystemWitnessesCurrent } from '@myco/utils/filesystem-proof.js';

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
  const proof = directoryWitnesses([parent, parent]);
  expect(proof).toHaveLength(1);
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
  const proof = directoryWitnesses([path.join(link, 'parent')]);
  fs.unlinkSync(link);
  fs.symlinkSync(replacement, link, 'junction');
  expect(filesystemWitnessesCurrent(proof)).toBe(false);
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
