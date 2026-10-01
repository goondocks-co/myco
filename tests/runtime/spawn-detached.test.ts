/**
 * A process started apart from this one (#1561): it runs, it outlives the caller's wait, and on Windows its command
 * line reaches it argument for argument. Runs on POSIX and on the Windows runner (`windows-native`), where the start is
 * `CreateProcessW` with `CREATE_BREAKAWAY_FROM_JOB`.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnDetached, windowsArgument } from '@myco/runtime/spawn-detached.js';

describe('a detached start', () => {
  it('runs the command with its arguments in the directory it is given, and answers at once', async () => {
    const dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'myco-detached-'));
    const out = path.join(dir, 'out.json');
    const script = path.join(dir, 'child.ts');
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`);
    const args = [script, 'plain', 'with space', 'with "quote"', 'trailing\\', ''];
    const started = Date.now();
    const answer = spawnDetached(process.execPath, args, { cwd: dir });
    expect(answer.started).toBe(true);
    // Answered before the child could have finished anything: the caller never waits on it.
    expect(Date.now() - started).toBeLessThan(2_000);
    for (let i = 0; i < 200 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    const seen = JSON.parse(fs.readFileSync(out, 'utf-8')) as { argv: string[]; cwd: string };
    expect(seen.argv).toEqual(args.slice(1));
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('answers a command that cannot start as not started, without throwing', () => {
    expect(spawnDetached(path.join(os.tmpdir(), 'no-such-program-myco'), [], { cwd: os.tmpdir() }).started).toBe(false);
  });
});

describe('a Windows command-line argument', () => {
  it('is quoted only where it must be, and keeps its backslashes and quotes as CommandLineToArgvW reads them', () => {
    expect(windowsArgument('plain')).toBe('plain');
    expect(windowsArgument('')).toBe('""');
    expect(windowsArgument('with space')).toBe('"with space"');
    expect(windowsArgument('C:\\Program Files\\myco\\myco.exe')).toBe('"C:\\Program Files\\myco\\myco.exe"');
    expect(windowsArgument('with "quote"')).toBe('"with \\"quote\\""');
    expect(windowsArgument('trailing\\')).toBe('trailing\\');
    expect(windowsArgument('spaced trailing\\')).toBe('"spaced trailing\\\\"');
    expect(windowsArgument('a\\"b c')).toBe('"a\\\\\\"b c"');
  });
});
