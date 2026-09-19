import { expect, it } from 'bun:test';
import { signExecutable } from '../../packages/myco/scripts/sign-executable.mjs';

it('preserves entitlements while signing, then verifies the Darwin artifact', () => {
  const calls: string[][] = [];
  signExecutable({ target: 'darwin-arm64', platform: 'darwin', outfile: '/tmp/compiled-myco',
    run: (command: string, args: string[]) => { calls.push([command, ...args]); return { status: 0 }; } });
  expect(calls).toEqual([
    ['codesign', '--force', '--sign', '-', '--preserve-metadata=entitlements', '/tmp/compiled-myco'],
    ['codesign', '--verify', '/tmp/compiled-myco'],
  ]);
});

it('refuses a failed signing or verification step', () => {
  for (const failingCall of [1, 2]) {
    let calls = 0;
    expect(() => signExecutable({ target: 'darwin-x64', platform: 'darwin', outfile: '/tmp/compiled-myco',
      run: () => ({ status: ++calls === failingCall ? 1 : 0 }) })).toThrow(/signing failed/);
    expect(calls).toBe(failingCall);
  }
});

it('does not invoke macOS tooling for other targets or cross-build hosts', () => {
  for (const [target, platform] of [['linux-arm64', 'darwin'], ['darwin-arm64', 'linux']]) {
    signExecutable({ target, platform, outfile: '/tmp/compiled-myco', run: () => { throw new Error('unexpected codesign'); } });
  }
});
