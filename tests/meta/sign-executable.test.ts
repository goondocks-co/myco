import { expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { signExecutable } from '../../packages/myco/scripts/sign-executable.mjs';

it('preserves entitlements while signing, verifies strictly, then runs the Darwin artifact', () => {
  const calls: string[][] = [];
  signExecutable({ target: 'darwin-arm64', platform: 'darwin', outfile: '/fixture/compiled-myco',
    run: (command: string, args: string[]) => { calls.push([command, ...args]); return { status: 0 }; } });
  expect(calls).toEqual([
    ['codesign', '--force', '--sign', '-', '--preserve-metadata=entitlements,identifier', '/fixture/compiled-myco'],
    ['codesign', '--verify', '--strict', '/fixture/compiled-myco'],
    ['/fixture/compiled-myco', '--version'],
  ]);
});

it('refuses a failed signing, verification or execution step', () => {
  for (const [failingCall, step] of [[1, /codesign --force/], [2, /codesign --verify/], [3, /--version/]] as const) {
    let calls = 0;
    expect(() => signExecutable({ target: 'darwin-x64', platform: 'darwin', outfile: '/fixture/compiled-myco',
      run: () => ({ status: ++calls === failingCall ? 1 : 0 }) })).toThrow(step);
    expect(calls).toBe(failingCall);
  }
});

it('bounds every step, so a program that hangs at exec fails the build', () => {
  const timeouts: unknown[] = [];
  signExecutable({ target: 'darwin-arm64', platform: 'darwin', outfile: '/fixture/compiled-myco',
    run: (_command: string, _args: string[], options: { timeout?: number }) => { timeouts.push(options.timeout); return { status: 0 }; } });
  expect(timeouts).toEqual([60_000, 60_000, 60_000]);
});

it('refuses an artifact the kernel kills at exec', () => {
  let calls = 0;
  expect(() => signExecutable({ target: 'darwin-arm64', platform: 'darwin', outfile: '/fixture/compiled-myco',
    run: () => (++calls === 3 ? { status: null, signal: 'SIGKILL' } : { status: 0 }) })).toThrow(/SIGKILL/);
});

it('does not invoke macOS tooling for other targets or cross-build hosts', () => {
  for (const [target, platform] of [['linux-arm64', 'darwin'], ['darwin-arm64', 'linux']]) {
    signExecutable({ target, platform, outfile: '/fixture/compiled-myco', run: () => { throw new Error('unexpected codesign'); } });
  }
});

it('executes in an isolated directory and removes it on success or failure', () => {
  for (const status of [0, 1]) {
    let directory = '';
    const execute = () => signExecutable({ target: 'darwin-arm64', platform: 'darwin', outfile: '/fixture/compiled-myco',
      run: (_command: string, _args: string[], options: { cwd: string }) => {
        directory = options.cwd;
        expect(directory).not.toBe(process.cwd());
        expect(existsSync(directory)).toBe(true);
        return { status };
      } });
    if (status === 0) execute();
    else expect(execute).toThrow();
    expect(directory).not.toBe('');
    expect(existsSync(directory)).toBe(false);
  }
});
