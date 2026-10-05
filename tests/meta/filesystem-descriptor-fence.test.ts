import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open as promiseOpen } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { installFilesystemFence } from '../setup/filesystem-fence.js';

const PRIVATE_CONTENT = 'private account configuration';
const PRIVATE_MODE = 0o600;
const UNTRACKED_DESCRIPTOR = -1;

async function withPrivateFile(attempt: (file: string, home: string, scope: ReturnType<typeof installFilesystemFence>) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-descriptor-fence-'));
  const home = path.join(directory, 'home');
  const file = path.join(home, '.codex/config.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PRIVATE_CONTENT, { mode: PRIVATE_MODE });
  const scope = installFilesystemFence(home);
  try {
    await attempt(file, home, scope);
    expect(fs.readFileSync(file, 'utf8')).toBe(PRIVATE_CONTENT);
    expect(fs.statSync(file).mode & 0o777).toBe(PRIVATE_MODE);
  } finally {
    scope.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function inheritedDescriptorProbe(file: string, home: string, body: string): string {
  const childHome = path.join(home, 'child-home');
  fs.mkdirSync(childHome);
  const code = `
    import fs from 'node:fs';
    import { installFilesystemFence } from ${JSON.stringify(path.resolve('tests/setup/filesystem-fence.ts'))};
    installFilesystemFence(${JSON.stringify(home)});
    ${body}
  `;
  const launcher = `
    const fs = require('node:fs');
    const fd = fs.openSync(${JSON.stringify(file)}, 'r');
    const child = require('node:child_process').spawnSync('bun', ['-e', ${JSON.stringify(code)}], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd],
    });
    fs.closeSync(fd);
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    process.exit(child.status ?? 1);
  `;
  const result = spawnSync('node', ['-e', launcher], {
    encoding: 'utf8',
    env: { ...process.env, HOME: childHome, CODEX_HOME: path.join(childHome, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(childHome, '.claude'), MYCO_HOME: path.join(childHome, '.myco') },
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  return result.stdout;
}

const syncMutations: Record<string, (fd: number) => unknown> = {
  fchmodSync: (fd) => fs.fchmodSync(fd, 0o666),
  fchownSync: (fd) => fs.fchownSync(fd, process.getuid?.() ?? 0, process.getgid?.() ?? 0),
  ftruncateSync: (fd) => fs.ftruncateSync(fd, 0),
  futimesSync: (fd) => fs.futimesSync(fd, 1, 1),
  writeSync: (fd) => fs.writeSync(fd, 'overwritten'),
  writevSync: (fd) => fs.writevSync(fd, [Buffer.from('overwritten')]),
  writeFileSync: (fd) => fs.writeFileSync(fd, 'overwritten'),
  appendFileSync: (fd) => fs.appendFileSync(fd, 'overwritten'),
  createWriteStream: (fd) => fs.createWriteStream('unused', { fd }),
  bunFileWrite: (fd) => Bun.file(fd).write('overwritten'),
  bunFileDestination: (fd) => Bun.write(Bun.file(fd), 'overwritten'),
  bunFileWriter: (fd) => Bun.file(fd).writer(),
  bunSlicedFileWrite: (fd) => Bun.file(fd).slice().write('overwritten'),
};
const callbackMutations: Record<string, (fd: number) => unknown> = {
  fchmod: (fd) => fs.fchmod(fd, 0o666, () => {}),
  fchown: (fd) => fs.fchown(fd, process.getuid?.() ?? 0, process.getgid?.() ?? 0, () => {}),
  ftruncate: (fd) => fs.ftruncate(fd, 0, () => {}),
  futimes: (fd) => fs.futimes(fd, 1, 1, () => {}),
  write: (fd) => fs.write(fd, 'overwritten', () => {}),
  writev: (fd) => fs.writev(fd, [Buffer.from('overwritten')], () => {}),
  writeFile: (fd) => fs.writeFile(fd, 'overwritten', () => {}),
  appendFile: (fd) => fs.appendFile(fd, 'overwritten', () => {}),
};
const handleMutations: Record<string, (handle: FileHandle) => unknown> = {
  chmod: (handle) => handle.chmod(0o666),
  chown: (handle) => handle.chown(process.getuid?.() ?? 0, process.getgid?.() ?? 0),
  truncate: (handle) => handle.truncate(0),
  utimes: (handle) => handle.utimes(1, 1),
  write: (handle) => handle.write('overwritten'),
  writev: (handle) => handle.writev([Buffer.from('overwritten')]),
  writeFile: (handle) => handle.writeFile('overwritten'),
  appendFile: (handle) => handle.appendFile('overwritten'),
  createWriteStream: (handle) => handle.createWriteStream(),
  promiseWriteFile: (handle) => fs.promises.writeFile(handle, 'overwritten'),
  promiseAppendFile: (handle) => fs.promises.appendFile(handle, 'overwritten'),
};

describe('filesystem descriptor fence', () => {
  it('refuses mutation when a descriptor has no recorded destination', () => {
    expect(() => fs.fchmodSync(UNTRACKED_DESCRIPTOR, 0o666)).toThrow(/TEST SAFETY.*untracked file descriptor/);
  });
  it('preserves output through anonymous stdout streams without allowing metadata writes', async () => {
    expect(() => fs.writeSync(1, '')).not.toThrow();
    expect(() => Bun.file(1).writer().write('')).not.toThrow();
    expect(await Bun.write(Bun.file(1), '')).toBe(0);
    expect(() => fs.fchmodSync(1, 0o666)).toThrow(/TEST SAFETY.*untracked file descriptor/);
  });
  it('blocks metadata writes through an inherited protected descriptor', () => withPrivateFile(async (file, home) => {
    const output = inheritedDescriptorProbe(file, home, `
      try { fs.fchmodSync(3, 0o666); console.log('mutation permitted'); }
      catch (error) { console.log(error.message); }
    `);
    expect(output).toMatch(/TEST SAFETY.*untracked file descriptor 3/);
  }));

  for (const form of ['read', 'write'] as const) {
    for (const destination of ['protected', 'scratch'] as const) {
      it(`preserves ${form} custom-open ${destination} descriptor ownership`, () => withPrivateFile(async (file, home) => {
        const actual = destination === 'protected' ? file : path.join(home, 'custom-open-scratch');
        const nominal = path.join(home, 'custom-open-nominal');
        if (destination === 'scratch') fs.writeFileSync(actual, 'scratch', { mode: PRIVATE_MODE });
        fs.writeFileSync(nominal, 'nominal');
        let calls = 0;
        const customFs = {
          open(_target: unknown, flags: string | number, _mode: unknown, callback: (error: NodeJS.ErrnoException | null, fd: number) => void) {
            calls++;
            fs.open(actual, destination === 'protected' ? 'r' : flags, callback);
          },
          read: fs.read.bind(fs), write: fs.write.bind(fs), writev: fs.writev.bind(fs), close: fs.close.bind(fs),
        };
        const stream = form === 'read' ? fs.createReadStream(nominal, { fs: customFs })
          : fs.createWriteStream(nominal, { fs: customFs });
        try {
          const fd = await new Promise<number>((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
          expect(calls).toBe(1);
          expect(fs.fstatSync(fd).ino).toBe(fs.statSync(actual).ino);
          if (destination === 'protected') expect(() => fs.fchmodSync(fd, 0o666)).toThrow(/TEST SAFETY/);
          else {
            fs.fchmodSync(fd, 0o666);
            expect(fs.statSync(actual).mode & 0o777).toBe(0o666);
            if (form === 'write') {
              await new Promise<void>((resolve, reject) => {
                stream.once('close', resolve); stream.once('error', reject);
                (stream as fs.WriteStream).end('scratch write');
              });
              expect(fs.readFileSync(actual, 'utf8')).toBe('scratch write');
            }
          }
        } finally {
          if (!stream.closed) await new Promise<void>((resolve, reject) => {
            stream.once('close', resolve); stream.once('error', reject); stream.destroy();
          });
        }
      }));
    }
    it(`refuses mutation through an untracked ${form} custom-open descriptor`, () => withPrivateFile(async (file, home) => {
      const nominal = path.join(home, 'untracked-stream-nominal');
      fs.writeFileSync(nominal, 'nominal');
      const output = inheritedDescriptorProbe(file, home, `
        let calls = 0;
        const customFs = {
          open(_target, _flags, _mode, callback) { calls++; callback(null, 3); },
          read: fs.read.bind(fs), write: fs.write.bind(fs), writev: fs.writev.bind(fs), close: fs.close.bind(fs),
        };
        const stream = fs.${form === 'read' ? 'createReadStream' : 'createWriteStream'}(${JSON.stringify(nominal)}, { fs: customFs });
        const fd = await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
        const protectedInode = fs.fstatSync(fd).ino === fs.statSync(${JSON.stringify(file)}).ino;
        let message = '';
        try { fs.fchmodSync(fd, 0o666); } catch (error) { message = error.message; }
        await new Promise((resolve, reject) => { stream.once('close', resolve); stream.once('error', reject); stream.destroy(); });
        console.log(JSON.stringify({ calls, protectedInode, message }));
      `);
      expect(JSON.parse(output)).toEqual({ calls: 1, protectedInode: true, message: expect.stringMatching(/TEST SAFETY.*untracked file descriptor/) });
    }));
  }
  it('tracks named promise-open handles for protected and scratch files', () => withPrivateFile(async (file, home) => {
    const privateHandle = await promiseOpen(file, 'r');
    try { expect(() => privateHandle.chmod(0o666)).toThrow(/TEST SAFETY/); }
    finally { await privateHandle.close(); }
    const scratchHandle = await promiseOpen(path.join(home, 'named-open-scratch'), 'w+');
    try {
      await scratchHandle.writeFile('scratch');
      await scratchHandle.chmod(PRIVATE_MODE);
      expect(fs.readFileSync(path.join(home, 'named-open-scratch'), 'utf8')).toBe('scratch');
    } finally { await scratchHandle.close(); }
  }));
  for (const [name, mutate] of Object.entries(syncMutations)) {
    it(`blocks ${name} through a read-only descriptor`, () => withPrivateFile(async (file) => {
      const fd = fs.openSync(file, fs.constants.O_RDONLY);
      try {
        expect(fs.readFileSync(fd, 'utf8')).toBe(PRIVATE_CONTENT);
        expect(() => mutate(fd)).toThrow(/TEST SAFETY/);
      } finally { fs.closeSync(fd); }
    }));
  }
  for (const [name, mutate] of Object.entries(callbackMutations)) {
    it(`blocks callback ${name} through a callback-opened descriptor`, () => withPrivateFile(async (file) => {
      const fd = await new Promise<number>((resolve, reject) => fs.open(file, 'r', (error, fd) => error ? reject(error) : resolve(fd)));
      try { expect(() => mutate(fd)).toThrow(/TEST SAFETY/); }
      finally { await new Promise<void>((resolve, reject) => fs.close(fd, (error) => error ? reject(error) : resolve())); }
    }));
  }
  for (const [name, mutate] of Object.entries(handleMutations)) {
    it(`blocks FileHandle ${name} and keeps reads safe`, () => withPrivateFile(async (file) => {
      const handle = await fs.promises.open(file, 'r');
      try {
        expect(await handle.readFile('utf8')).toBe(PRIVATE_CONTENT);
        await expect(Promise.resolve().then(() => mutate(handle))).rejects.toThrow(/TEST SAFETY/);
      } finally { await handle.close(); }
    }));
  }

  it('tracks the protected target when a symlink alias is later removed', () => withPrivateFile(async (file, home, scope) => {
    const alias = path.join(home, 'alias');
    fs.symlinkSync(file, alias);
    const fd = fs.openSync(alias, 'r');
    scope.dispose();
    fs.unlinkSync(alias);
    const replacement = installFilesystemFence(home);
    try { expect(() => fs.fchmodSync(fd, 0o666)).toThrow(/TEST SAFETY/); }
    finally { fs.closeSync(fd); replacement.dispose(); }
  }));

  it('tracks descriptors opened by read streams', () => withPrivateFile(async (file) => {
    const stream = fs.createReadStream(file);
    try {
      const fd = await new Promise<number>((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
      expect(() => fs.fchmodSync(fd, 0o666)).toThrow(/TEST SAFETY/);
    } finally {
      await new Promise<void>((resolve) => { stream.once('close', resolve); stream.destroy(); });
    }
  }));

  it('allows scratch write streams and tracks their descriptor destination', () => withPrivateFile(async (_file, home) => {
    const scratch = path.join(home, 'write-stream-scratch');
    const stream = fs.createWriteStream(scratch);
    const fd = await new Promise<number>((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
    fs.fchmodSync(fd, PRIVATE_MODE);
    await new Promise<void>((resolve, reject) => {
      stream.once('close', resolve);
      stream.once('error', reject);
      stream.end('scratch');
    });
    expect(fs.readFileSync(scratch, 'utf8')).toBe('scratch');
  }));

  it('allows scratch descriptor writes after protected descriptors close', () => withPrivateFile(async (file, home) => {
    const protectedFd = fs.openSync(file, 'r');
    fs.closeSync(protectedFd);
    const scratch = path.join(home, 'scratch');
    const fd = fs.openSync(scratch, 'w+');
    try { fs.writeSync(fd, 'scratch'); fs.fchmodSync(fd, PRIVATE_MODE); fs.ftruncateSync(fd, 3); }
    finally { fs.closeSync(fd); }
    const handle = await fs.promises.open(scratch, 'r+');
    try { await handle.writeFile('allowed'); await handle.chmod(PRIVATE_MODE); }
    finally { await handle.close(); }
    expect(fs.readFileSync(scratch, 'utf8')).toBe('allowed');
  }));
});

describe('recursive copy fence', () => {
  for (const form of ['sync', 'callback', 'promise'] as const) {
    it(`blocks ${form} copying into an ancestor of protected roots`, () => withPrivateFile(async (_file, home) => {
      const source = path.join(path.dirname(home), 'source');
      fs.mkdirSync(path.join(source, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(source, '.codex/config.toml'), 'overwritten');
      const attempt = () => form === 'sync' ? fs.cpSync(source, home, { recursive: true })
        : form === 'callback' ? fs.cp(source, home, { recursive: true }, () => {})
          : fs.promises.cp(source, home, { recursive: true });
      expect(attempt).toThrow(/TEST SAFETY/);
      const destination = path.join(home, `ordinary-copy-${form}`);
      if (form === 'sync') fs.cpSync(source, destination, { recursive: true });
      else if (form === 'callback') await new Promise<void>((resolve, reject) => fs.cp(source, destination, { recursive: true }, (error) => error ? reject(error) : resolve()));
      else await fs.promises.cp(source, destination, { recursive: true });
      expect(fs.readFileSync(path.join(destination, '.codex/config.toml'), 'utf8')).toBe('overwritten');
    }));
  }
});
