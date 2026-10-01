/**
 * Gate G8 (#1561): a binary replaced under a running process keeps answering from its own code.
 *
 * A binary built with `--splitting` reads a chunk only when an import first reaches it. A long-running verb such as
 * `myco mcp` or `myco worker` can do that minutes after it started, and an update can rename a new binary into its
 * path in between. The process must still load its chunk from the binary it started as: a chunk read from the new
 * file would mix two versions in one process.
 *
 * Two binaries, `a` and `b`, are compiled the way the release is (`--compile --splitting`) from one entry that waits
 * for a line on stdin, then imports a module it has not loaded yet. `a` starts and waits, `b` is renamed over its path
 * (POSIX; on Windows the running file is renamed aside first, the way an update replaces it there), and `a` is told
 * to import. It must answer `a`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-g8-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const EXE = process.platform === 'win32' ? '.exe' : '';

function compile(version: string): string {
  const src = path.join(ROOT, `src-${version}`);
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'late.ts'), `export const VERSION = ${JSON.stringify(version)};\n`);
  // A payload of a few hundred KB, as a real build carries: codesign refuses to sign a binary whose appended payload is
  // only a few hundred bytes ("main executable failed strict validation"), which no release build is.
  fs.writeFileSync(path.join(src, 'pad.ts'), `export const PAD = ${JSON.stringify('x'.repeat(200_000))};\n`);
  fs.writeFileSync(path.join(src, 'entry.ts'), [
    "import { PAD } from './pad.ts';",
    "if (process.argv.includes('--pad')) process.stdout.write(String(PAD.length));",
    "process.stdout.write('ready\\n');",
    "for await (const _ of console) { const { VERSION } = await import('./late.ts'); process.stdout.write(VERSION + '\\n'); break; }",
    '',
  ].join('\n'));
  const out = path.join(ROOT, `myco-${version}${EXE}`);
  const built = spawnSync(process.execPath, ['build', '--compile', '--splitting', '--minify', path.join(src, 'entry.ts'), '--outfile', out], { encoding: 'utf-8' });
  expect({ version, status: built.status, stderr: built.stderr.slice(0, 400) }).toEqual({ version, status: 0, stderr: built.stderr.slice(0, 400) });
  // A darwin build is signed in place before it runs, as placement signs every binary it installs.
  if (process.platform === 'darwin') expect(spawnSync('codesign', ['--force', '--sign', '-', out]).status).toBe(0);
  return out;
}

describe('a binary replaced while it runs', () => {
  it('loads its chunk from the binary it started as', async () => {
    const live = path.join(ROOT, `myco${EXE}`);
    fs.copyFileSync(compile('a'), live);
    if (process.platform !== 'win32') fs.chmodSync(live, 0o755);
    const replacement = compile('b');

    const child = spawn(live, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    const waitFor = async (text: string) => {
      for (let i = 0; i < 200 && !out.includes(text); i++) await new Promise((r) => setTimeout(r, 25));
    };
    await waitFor('ready');
    expect(out).toContain('ready');

    if (process.platform === 'win32') fs.renameSync(live, `${live}.prev`);
    fs.renameSync(replacement, live);

    child.stdin.write('go\n');
    child.stdin.end();
    const code = await exited;
    expect({ code, answered: out.trim().split('\n').at(-1) }).toEqual({ code: 0, answered: 'a' });
  }, 60_000);
});
