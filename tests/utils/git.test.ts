import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import { findGitBinary, type GitResolveDeps } from '@myco/utils/git.js';

function deps(over: Partial<GitResolveDeps> & { present?: string[] }): GitResolveDeps {
  const present = new Set(over.present ?? []);
  return {
    platform: over.platform ?? 'linux',
    env: over.env ?? {},
    existsFile: over.existsFile ?? ((p) => present.has(p)),
  };
}

describe('findGitBinary', () => {
  it('Windows: resolves git.exe from a well-known install dir when PATH is stripped', () => {
    // The capture-loss case: a GUI-launched agent inherits no PATH.
    const gitExe = path.win32.join('C:\\Program Files', 'Git', 'cmd', 'git.exe');
    expect(findGitBinary(deps({
      platform: 'win32',
      env: { PATH: '', ProgramFiles: 'C:\\Program Files' },
      present: [gitExe],
    }))).toBe(gitExe);
  });

  it('Windows: PATH wins over the well-known dirs when git.exe is on PATH', () => {
    const onPath = path.win32.join('C:\\tools\\git\\bin', 'git.exe');
    const wellKnown = path.win32.join('C:\\Program Files', 'Git', 'cmd', 'git.exe');
    expect(findGitBinary(deps({
      platform: 'win32',
      env: { PATH: 'C:\\tools\\git\\bin', ProgramFiles: 'C:\\Program Files' },
      present: [onPath, wellKnown],
    }))).toBe(onPath);
  });

  it('Windows: honors LOCALAPPDATA user-scoped Git install', () => {
    const userGit = path.win32.join('C:\\Users\\x\\AppData\\Local', 'Programs', 'Git', 'cmd', 'git.exe');
    expect(findGitBinary(deps({
      platform: 'win32',
      env: { PATH: '', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      present: [userGit],
    }))).toBe(userGit);
  });

  it('Windows: falls back to bare git.exe when nothing is found', () => {
    expect(findGitBinary(deps({ platform: 'win32', env: { PATH: '' }, present: [] }))).toBe('git.exe');
  });

  it('POSIX: resolves from a well-known dir (Homebrew) when PATH is stripped', () => {
    expect(findGitBinary(deps({
      platform: 'darwin',
      env: { PATH: '' },
      present: ['/opt/homebrew/bin/git'],
    }))).toBe('/opt/homebrew/bin/git');
  });

  it('POSIX: PATH wins; falls back to bare git when nothing found', () => {
    const onPath = '/custom/bin/git';
    expect(findGitBinary(deps({ platform: 'linux', env: { PATH: '/custom/bin' }, present: [onPath] }))).toBe(onPath);
    expect(findGitBinary(deps({ platform: 'linux', env: { PATH: '' }, present: [] }))).toBe('git');
  });
});
