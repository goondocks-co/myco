/**
 * A `git` that loses its stdout on demand, the way Bun's `execFileSync` drops a
 * child's stdout under heavy load (oven-sh/bun#34069): the real git runs,
 * prints, and exits with its own status, and the caller receives nothing. The
 * loss is all or nothing, as the real one is.
 *
 * `loseNext(times, match)` arms it: the next `times` invocations whose
 * arguments contain `match` (every invocation when `match` is empty) lose
 * their stdout; `loseNext(0)` disarms it. Every other invocation is the real
 * git, untouched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __resetGitBinaryCacheForTest, findGitBinary } from '@myco/utils/git.js';
import { removeWhenTestsEnd } from '../../support/remove-when-tests-end.js';

export interface LostGit {
  /** The real git, for setting fixtures up. */
  realGit: string;
  loseNext: (times: number, match?: string) => void;
  /** How many armed losses are still to come. */
  armsLeft: () => number;
  /** Put PATH back and forget the resolved git. */
  restore: () => void;
}

export function installLostGit(): LostGit {
  const realGit = findGitBinary();
  const bin = removeWhenTestsEnd(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-lost-git-'))));
  const armFile = path.join(bin, 'armed');
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    `ARM='${armFile}'`,
    'if [ -s "$ARM" ]; then',
    '  n=$(cut -f1 "$ARM"); pat=$(cut -f2- "$ARM")',
    '  case " $* " in',
    '    *"$pat"*)',
    '      if [ "$n" -gt 1 ]; then printf \'%s\\t%s\\n\' $((n - 1)) "$pat" > "$ARM"; else rm -f "$ARM"; fi',
    `      '${realGit}' "$@" > /dev/null`,
    '      exit $?',
    '      ;;',
    '  esac',
    'fi',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
  __resetGitBinaryCacheForTest();
  return {
    realGit,
    loseNext: (times, match = '') => {
      if (times > 0) fs.writeFileSync(armFile, `${times}\t${match}\n`); else fs.rmSync(armFile, { force: true });
    },
    armsLeft: () => (fs.existsSync(armFile) ? Number(fs.readFileSync(armFile, 'utf-8').split('\t')[0]) : 0),
    restore: () => {
      process.env.PATH = savedPath;
      __resetGitBinaryCacheForTest();
    },
  };
}
