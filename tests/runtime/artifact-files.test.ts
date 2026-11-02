import { expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materializeArtifact } from '@myco/runtime/artifact-files.js';
import { placeExecutable } from '@myco/install/place-binary.js';

it('refuses untrusted artifacts and atomically repairs incomplete or differing owned bytes before use', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-artifacts-'));
  try {
    const directory = path.join(root, 'native');
    const expected = Buffer.from('embedded native artifact');
    const file = materializeArtifact(directory, 'vec0', expected);
    const originalInode = fs.statSync(file).ino;
    expect(materializeArtifact(directory, 'vec0', expected)).toBe(file);
    expect(fs.statSync(file).ino).toBe(originalInode);
    if (process.platform !== 'win32') expect(fs.statSync(directory).mode & 0o777).toBe(0o700);

    for (const bytes of [expected.subarray(0, 5), Buffer.alloc(expected.length)]) {
      fs.writeFileSync(file, bytes);
      const incompleteInode = fs.statSync(file).ino;
      expect(materializeArtifact(directory, 'vec0', expected)).toBe(file);
      expect(fs.readFileSync(file)).toEqual(expected);
      expect(fs.statSync(file).ino).not.toBe(incompleteInode);
    }

    if (typeof process.getuid === 'function') {
      const lstat = fs.lstatSync;
      const foreign = spyOn(fs, 'lstatSync').mockImplementation(new Proxy(lstat, {
        apply(target, receiver, args) {
          const stat = Reflect.apply(target, receiver, args);
          if (String(args[0]) === file) Object.defineProperty(stat, 'uid', { value: process.getuid!() + 1 });
          return stat;
        },
      }));
      try { expect(() => materializeArtifact(directory, 'vec0', expected)).toThrow('foreign-owned'); }
      finally { foreign.mockRestore(); }
    }

    if (process.platform !== 'win32') {
      const outside = path.join(root, 'outside');
      fs.writeFileSync(outside, 'leave alone');
      fs.unlinkSync(file);
      fs.symlinkSync(outside, file);
      expect(() => materializeArtifact(directory, 'vec0', expected)).toThrow('regular file');
      expect(fs.readFileSync(outside, 'utf8')).toBe('leave alone');
      fs.unlinkSync(file);
      const linkedDirectory = path.join(root, 'linked');
      fs.symlinkSync(directory, linkedDirectory);
      expect(() => materializeArtifact(linkedDirectory, 'vec0', expected)).toThrow('real directory');
    }

    const source = path.join(root, 'source');
    fs.writeFileSync(source, expected);
    placeExecutable(source, file, { ready: staged => {
      expect(fs.readFileSync(staged)).toEqual(expected);
      if (process.platform !== 'win32') expect(fs.statSync(path.dirname(staged)).mode & 0o777).toBe(0o700);
      expect(fs.existsSync(file)).toBe(false);
      return { runs: true };
    } });
    expect(fs.readFileSync(file)).toEqual(expected);
    expect(fs.readdirSync(directory)).toEqual(['vec0']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
