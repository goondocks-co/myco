import { describe, expect, it, spyOn } from 'bun:test';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allocateOwnedFixture } from '../support/owned-fixtures.js';
import { runPermissionFixture, setFixturePermissions } from '../helpers/permission-fixture.js';
import { installFilesystemFence } from '../setup/filesystem-fence.js';

type Helper = 'chmod' | 'secret-file' | 'secret-directory';
const helpers: Helper[] = ['chmod', 'secret-file', 'secret-directory'];
function invoke(helper: Helper, directory: string): void {
  if (helper === 'chmod') setFixturePermissions(path.join(directory, 'config.toml'), 0o600);
  else runPermissionFixture(helper, directory);
}
function snapshot(directory: string): unknown[] {
  return fs.readdirSync(directory).sort().flatMap((name) => {
    const full = path.join(directory, name);
    const stat = fs.lstatSync(full);
    return [{ name, mode: stat.mode, data: stat.isSymbolicLink() ? fs.readlinkSync(full)
      : stat.isDirectory() ? snapshot(full) : fs.readFileSync(full).toString('hex') }];
  });
}
function refusesBeforeSpawn(attempt: () => void, message: RegExp): void {
  const spawn = spyOn(childProcess, 'spawnSync');
  try {
    expect(attempt).toThrow(message);
    expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); }
}

describe('permission fixture authorization', () => {
  for (const helper of helpers) {
    for (const layout of ['direct root', 'canonical backing', 'directory alias', 'ancestor alias'] as const) {
      it(`${helper}: refuses a protected ${layout} without changing bytes or modes`, () => {
        const root = allocateOwnedFixture('myco-permission-scope-');
        const home = path.join(root, 'account');
        fs.mkdirSync(home);
        fs.mkdirSync(path.join(root, 'container'));
        const storage = layout === 'direct root' ? path.join(home, '.myco') : path.join(root, 'container', 'storage');
        fs.mkdirSync(storage);
        fs.writeFileSync(path.join(root, 'private'), 'preserved bytes', { mode: 0o600 });
        if (helper === 'chmod') fs.writeFileSync(path.join(storage, 'config.toml'), 'protected bytes', { mode: 0o644 });
        if (layout !== 'direct root') fs.symlinkSync(storage, path.join(home, '.myco'), 'dir');
        let supplied = storage;
        if (layout === 'directory alias') {
          supplied = path.join(root, 'alias');
          fs.symlinkSync(storage, supplied, 'dir');
        } else if (layout === 'ancestor alias') {
          fs.symlinkSync(path.dirname(storage), path.join(root, 'ancestor'), 'dir');
          supplied = path.join(root, 'ancestor', 'storage');
        }
        const before = { mode: fs.statSync(root).mode, tree: snapshot(root) };
        const fence = installFilesystemFence(home);
        try {
          refusesBeforeSpawn(() => invoke(helper, supplied),
            layout.endsWith('alias') ? /TEST SAFETY:.*symbolic link/ : /TEST SAFETY:.*live config/);
          expect({ mode: fs.statSync(root).mode, tree: snapshot(root) }).toEqual(before);
        } finally {
          fence.dispose();
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
    it(`${helper}: refuses an unowned temp directory`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-unowned-permission-'));
      if (helper === 'chmod') fs.writeFileSync(path.join(root, 'config.toml'), 'unowned bytes', { mode: 0o644 });
      const before = { mode: fs.statSync(root).mode, tree: snapshot(root) };
      try {
        refusesBeforeSpawn(() => invoke(helper, root), /owned fixture allocation/);
        expect({ mode: fs.statSync(root).mode, tree: snapshot(root) }).toEqual(before);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
    it(`${helper}: refuses a replaced allocation`, () => {
      const root = allocateOwnedFixture('myco-replaced-permission-');
      const retired = `${root}-retired`;
      fs.renameSync(root, retired);
      fs.mkdirSync(root);
      if (helper === 'chmod') fs.writeFileSync(path.join(root, 'config.toml'), 'replacement bytes', { mode: 0o644 });
      const before = { mode: fs.statSync(root).mode, tree: snapshot(root) };
      try {
        refusesBeforeSpawn(() => invoke(helper, root), /allocation identity changed/);
        expect({ mode: fs.statSync(root).mode, tree: snapshot(root) }).toEqual(before);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(retired, { recursive: true, force: true });
      }
    });
    for (const alias of ['directory', 'ancestor'] as const) {
      it(`${helper}: refuses an unprotected ${alias} symlink before canonicalizing`, () => {
        const root = allocateOwnedFixture('myco-permission-alias-');
        const storage = path.join(root, 'container', 'storage');
        fs.mkdirSync(storage, { recursive: true });
        if (helper === 'chmod') fs.writeFileSync(path.join(storage, 'config.toml'), 'fixture bytes', { mode: 0o644 });
        const link = path.join(root, 'alias');
        fs.symlinkSync(alias === 'directory' ? storage : path.dirname(storage), link, 'dir');
        const before = { mode: fs.statSync(root).mode, tree: snapshot(root) };
        try {
          refusesBeforeSpawn(() => invoke(helper, alias === 'directory' ? link : path.join(link, 'storage')),
            /TEST SAFETY:.*symbolic link/);
          expect({ mode: fs.statSync(root).mode, tree: snapshot(root) }).toEqual(before);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
      });
    }
    it(`${helper}: refuses a non-normalized supplied path`, () => {
      const root = allocateOwnedFixture('myco-permission-spelling-');
      const storage = path.join(root, 'storage');
      fs.mkdirSync(storage);
      if (helper === 'chmod') fs.writeFileSync(path.join(storage, 'config.toml'), 'fixture bytes', { mode: 0o644 });
      const before = snapshot(root);
      try {
        const supplied = `${root}${path.sep}.${path.sep}storage`;
        refusesBeforeSpawn(() => helper === 'chmod'
          ? setFixturePermissions(`${supplied}${path.sep}config.toml`, 0o600)
          : runPermissionFixture(helper, supplied), /normalized absolute path/);
        expect(snapshot(root)).toEqual(before);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
    it(`${helper}: refuses a directory containing an active protected root`, () => {
      const root = allocateOwnedFixture('myco-permission-parent-');
      fs.mkdirSync(path.join(root, '.myco'));
      fs.writeFileSync(path.join(root, '.myco', 'private'), 'protected bytes');
      const before = { mode: fs.statSync(root).mode, tree: snapshot(root) };
      const fence = installFilesystemFence(root);
      try {
        refusesBeforeSpawn(() => helper === 'chmod' ? setFixturePermissions(root, 0o700) : runPermissionFixture(helper, root), /TEST SAFETY:.*live config/);
        expect({ mode: fs.statSync(root).mode, tree: snapshot(root) }).toEqual(before);
      } finally {
        fence.dispose();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
  it('refuses a hard-linked protected file in an owned allocation', () => {
    const root = allocateOwnedFixture('myco-permission-hardlink-');
    const home = path.join(root, 'account');
    const file = path.join(home, '.myco', 'private');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'protected bytes', { mode: 0o644 });
    fs.linkSync(file, alias);
    const before = snapshot(root);
    const fence = installFilesystemFence(home);
    try {
      refusesBeforeSpawn(() => setFixturePermissions(alias, 0o600), /hard-linked file/);
      expect(snapshot(root)).toEqual(before);
    } finally {
      fence.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses unsupported runtime permission values without launching a child', () => {
    const root = allocateOwnedFixture('myco-permission-mode-');
    const file = path.join(root, 'config.toml');
    fs.writeFileSync(file, 'fixture bytes', { mode: 0o644 });
    const before = snapshot(root);
    try {
      for (const mode of [0o777, '0o600); process.exit(0); //']) {
        refusesBeforeSpawn(() => Reflect.apply(setFixturePermissions, undefined, [file, mode]), /unsupported fixture permission mode/);
      }
      expect(snapshot(root)).toEqual(before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === 'win32')('permits mode-000 repair only for an owned unprotected file and directory', () => {
    const root = allocateOwnedFixture('myco-owned-permission-');
    const file = path.join(root, 'config.toml');
    const directory = path.join(root, 'directory');
    fs.writeFileSync(file, 'owned bytes', { mode: 0o600 });
    fs.mkdirSync(directory);
    try {
      for (const target of [file, directory]) {
        fs.chmodSync(target, 0o000);
        setFixturePermissions(target, target === file ? 0o600 : 0o700);
        expect(fs.statSync(target).mode & 0o777).toBe(target === file ? 0o600 : 0o700);
      }
      expect(fs.readFileSync(file, 'utf8')).toBe('owned bytes');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
