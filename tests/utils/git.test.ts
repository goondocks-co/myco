import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import { findGitBinary, GIT_ANSWER_ATTEMPTS, runGitAnswer, type GitResolveDeps } from '@myco/utils/git.js';

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

describe('runGitAnswer', () => {
  /** A git runner that answers each call from `answers` in turn, counting the calls. */
  const scripted = (answers: Array<string | Error>) => {
    const calls: string[][] = [];
    const run = (args: string[]): string => {
      calls.push(args);
      const next = answers[calls.length - 1] ?? '';
      if (next instanceof Error) throw next;
      return next;
    };
    return { run, calls };
  };

  it('asks again when a successful query reaches it with no answer, and returns the answer', () => {
    const git = scripted(['', '.git']);
    expect(runGitAnswer(['rev-parse', '--git-common-dir'], '/repo', git.run)).toBe('.git');
    expect(git.calls).toHaveLength(2);
  });

  it('throws once every attempt answered nothing, so the caller falls back as it does for git failing', () => {
    const git = scripted([]);
    expect(() => runGitAnswer(['rev-parse', '--git-common-dir'], '/repo', git.run)).toThrow('answered nothing');
    expect(git.calls).toHaveLength(GIT_ANSWER_ATTEMPTS);
  });

  it('does not ask again when git fails', () => {
    const git = scripted([new Error('not a git repository')]);
    expect(() => runGitAnswer(['rev-parse', '--git-common-dir'], '/repo', git.run)).toThrow('not a git repository');
    expect(git.calls).toHaveLength(1);
  });
});
