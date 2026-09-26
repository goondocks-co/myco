/**
 * The Git reads a source run may make, and the `git` that holds every Git call
 * in the run to them.
 *
 * A source run is granted scoped Git read commands. Several of Git's read
 * commands take options that write a file (`--output`), run a program
 * (`grep -O`), or read outside the run's checkout (`diff --no-index`), and Git
 * accepts any unambiguous abbreviation of a long option. A harness that matches
 * a grant by command prefix cannot see those arguments, so the rules are
 * enforced where the arguments arrive: a `git` of the run's own, first on the
 * harness's PATH, that refuses what is not a read of the checkout and otherwise
 * runs the machine's Git with the machine's and the user's Git configuration
 * out of reach. A driver that does see each command applies the same rules
 * through `gitReadRefusal` before it allows one.
 *
 * The harness's environment also carries a Git configuration that no Git will
 * parse, which the run's `git` removes: a Git reached any other way, through a
 * PATH the user's shell configuration reordered or an alias, stops before doing
 * anything.
 *
 * The run's `git` is a POSIX shell script. Where the worker runs on Windows no
 * Git command is granted, and a source run reads through its file tools.
 */
import { accessSync, constants, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RUN_REPOSITORY_DIR, SOURCE_GIT_READ_COMMANDS } from '@goondocks/myco-shared/repository';

/**
 * Long options no source run may pass a read command: each writes a file, runs
 * a program, or reads outside the checkout. Git takes any unambiguous
 * abbreviation of a long option, so a name that begins one of these is refused
 * as well.
 */
export const REFUSED_GIT_LONG_OPTIONS = ['output', 'open-files-in-pager', 'no-index', 'ext-diff', 'help'] as const;

/** Short options no source run may pass, matched with or without an attached value: `grep -O<command>` runs a program. */
export const REFUSED_GIT_SHORT_OPTIONS = ['-O'] as const;

/** The options Git may be given before its command: a directory, and turning the pager off. */
const DIRECTORY_OPTION = '-C';
const NO_PAGER_OPTIONS: readonly string[] = ['--no-pager', '-P'];

/**
 * A Git configuration no Git will parse: a count of one entry, with the entry
 * missing. Every Git command that reads configuration stops on it.
 */
export const GIT_TRIPWIRE_ENV: Readonly<Record<string, string>> = { GIT_CONFIG_COUNT: '1' };

/** What the run's `git` sets for the Git it runs, over an environment with every other Git variable removed. */
const SHIM_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_TERMINAL_PROMPT: '0',
};

/** The oldest Git that reads `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_COUNT`, both of which the confinement relies on. */
const MIN_GIT_VERSION: readonly [number, number] = [2, 32];

/** Where the run's `git` lives, and the script a shell sources to put it first. */
const SHIM_DIR = 'bin';
const SHELL_SETUP_FILE = 'shell-env.sh';

/** Why a long option is refused, by the option it names. */
function refusedLong(arg: string): string | null {
  if (!arg.startsWith('--') || arg === '--') return null;
  const name = arg.slice(2).split('=', 1)[0]!;
  const refused = REFUSED_GIT_LONG_OPTIONS.find((option) => option.startsWith(name));
  return refused === undefined ? null : `--${refused} is not allowed in this run`;
}

/**
 * Why these arguments to `git` are not a read this run may make, or null when
 * they are: `-C <dir>` and the pager switch before a granted read command, and
 * no refused option after it. The directory `-C` names is not judged here; the
 * grant names the directories a call may give, and the run's `git` checks where
 * it actually lands.
 */
export function gitReadRefusal(args: readonly string[]): string | null {
  let at = 0;
  while (at < args.length && args[at]!.startsWith('-')) {
    const option = args[at]!;
    if (option === DIRECTORY_OPTION) {
      if (at + 1 >= args.length) return `${DIRECTORY_OPTION} needs a directory`;
      at += 2;
    } else if (NO_PAGER_OPTIONS.includes(option)) {
      at += 1;
    } else {
      return `git ${option} is not allowed in this run`;
    }
  }
  const command = args[at];
  if (command === undefined) return 'a Git read command is required';
  if (!(SOURCE_GIT_READ_COMMANDS as readonly string[]).includes(command)) return `git ${command} is not a read this run may make`;
  for (const arg of args.slice(at + 1)) {
    if (REFUSED_GIT_SHORT_OPTIONS.some((option) => arg.startsWith(option))) return `${arg.slice(0, 2)} is not allowed in this run`;
    const refused = refusedLong(arg);
    if (refused !== null) return refused;
  }
  return null;
}

/** A character a shell passes through unchanged outside quotes. Anything else outside quotes is expanded, redirected or chained by some shell. */
const PLAIN = /[A-Za-z0-9_\-./:=@%+,]/;

/**
 * The words a POSIX shell makes of a command, or null when the command holds
 * anything a shell would expand or interpret: an unquoted glob, brace, tilde,
 * parenthesis or other active character, or an unterminated quote. Single
 * quotes are literal; inside double quotes a backslash escapes `"` and `\`.
 * A command carrying `$` or a backquote anywhere is refused before it reaches
 * this, so double quotes hold no expansion.
 */
export function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  let at = 0;
  while (at < command.length) {
    const char = command[at]!;
    if (char === ' ' || char === '\t') {
      if (word !== null) words.push(word);
      word = null;
      at += 1;
    } else if (char === '\'') {
      const end = command.indexOf('\'', at + 1);
      if (end < 0) return null;
      word = (word ?? '') + command.slice(at + 1, end);
      at = end + 1;
    } else if (char === '"') {
      let text = '';
      at += 1;
      while (at < command.length && command[at] !== '"') {
        if (command[at] === '\\' && (command[at + 1] === '"' || command[at + 1] === '\\')) at += 1;
        text += command[at];
        at += 1;
      }
      if (at >= command.length) return null;
      word = (word ?? '') + text;
      at += 1;
    } else if (char === '\\') {
      if (at + 1 >= command.length) return null;
      word = (word ?? '') + command[at + 1];
      at += 2;
    } else if (PLAIN.test(char)) {
      word = (word ?? '') + char;
      at += 1;
    } else {
      return null;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** A value as one single-quoted shell word. */
const quoted = (value: string): string => `'${value.replaceAll('\'', '\'\\\'\'')}'`;

/**
 * The run's `git`: the rules of `gitReadRefusal`, stated from the same lists,
 * and the checkout as the only place Git may run.
 *
 * Each `-C` is applied by changing directory, so where Git runs is the
 * physical directory the shell lands in, a symbolic link in the checkout
 * followed; the checkout must contain it. Every Git variable is then removed,
 * the tripwire among them, and Git runs with neither the system's nor the
 * user's configuration.
 */
export function gitShimScript(realGit: string, repository: string): string {
  const commands = SOURCE_GIT_READ_COMMANDS.join('|');
  const env = Object.entries(SHIM_GIT_ENV).map(([name, value]) => `${name}=${quoted(value)}`).join(' ');
  return [
    '#!/bin/sh',
    '# This run\'s git: read commands only, inside the run\'s checkout.',
    `repo=${quoted(repository)}`,
    `git=${quoted(realGit)}`,
    'refuse() { printf \'git: %s\\n\' "$1" >&2; exit 1; }',
    'unset CDPATH',
    'while [ "$#" -gt 0 ]; do',
    '  case $1 in',
    `    ${DIRECTORY_OPTION})`,
    `      [ "$#" -ge 2 ] || refuse '${DIRECTORY_OPTION} needs a directory'`,
    '      case $2 in /*) dir=$2 ;; *) dir=./$2 ;; esac',
    '      cd -- "$dir" 2>/dev/null || refuse "cannot change to $2"',
    '      shift 2 ;;',
    `    ${NO_PAGER_OPTIONS.join('|')}) shift ;;`,
    '    -*) refuse "git $1 is not allowed in this run" ;;',
    '    *) break ;;',
    '  esac',
    'done',
    '[ "$#" -gt 0 ] || refuse \'a Git read command is required\'',
    'case $1 in',
    `  ${commands}) ;;`,
    '  *) refuse "git $1 is not a read this run may make" ;;',
    'esac',
    'here=$(pwd -P) || refuse \'cannot read the current directory\'',
    'case $here/ in',
    '  "$repo"/*) ;;',
    '  *) refuse "git runs only inside this run\'s checkout, not in $here" ;;',
    'esac',
    'read=$1',
    'shift',
    'for arg in "$@"; do',
    '  case $arg in',
    ...REFUSED_GIT_SHORT_OPTIONS.map((option) => `    ${option}*) refuse "${option} is not allowed in this run" ;;`),
    '    --) ;;',
    '    --*)',
    '      name=${arg#--}',
    '      name=${name%%=*}',
    `      for refused in ${REFUSED_GIT_LONG_OPTIONS.join(' ')}; do`,
    '        case $refused in "$name"*) refuse "--$refused is not allowed in this run" ;; esac',
    '      done ;;',
    '  esac',
    'done',
    'unset $(command -p env | command -p sed -n \'s/^\\(GIT_[A-Za-z0-9_]*\\)=.*/\\1/p\')',
    `${env}`,
    `export ${Object.keys(SHIM_GIT_ENV).join(' ')}`,
    `GIT_CEILING_DIRECTORIES=${quoted(dirname(repository))}`,
    'export GIT_CEILING_DIRECTORIES',
    'exec "$git" --no-pager "$read" "$@"',
    '',
  ].join('\n');
}

/**
 * What a shell sources before each command so the run's `git` is the one a
 * command reaches, whatever the user's shell configuration put first.
 */
export function shellSetupScript(shimDir: string): string {
  return [
    'unalias git 2>/dev/null',
    'unset -f git 2>/dev/null',
    `PATH=${quoted(shimDir)}:"$PATH"`,
    'export PATH',
    'hash -r 2>/dev/null',
    ':',
    '',
  ].join('\n');
}

/** Whether this file is an executable regular file. */
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The machine's Git: the first executable `git` on the worker's PATH that reads the configuration the confinement relies on. */
function machineGit(path: string | undefined): string | null {
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, 'git');
    if (!executable(candidate)) continue;
    let version: string;
    try {
      version = execFileSync(candidate, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { PATH: path ?? '' } });
    } catch {
      return null;
    }
    const [major, minor] = (/(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
    if (major === undefined || minor === undefined) return null;
    const [needMajor, needMinor] = MIN_GIT_VERSION;
    return major > needMajor || (major === needMajor && minor >= needMinor) ? candidate : null;
  }
  return null;
}

/** The run's `git`, where it can hold a run's Git calls to reads of the checkout. */
export interface SourceGit {
  /** The directory holding the run's `git`, to put first on a harness's PATH. */
  shimDir: string;
  /** A script a shell sources before each command to put the run's `git` first again. */
  shellSetup: string;
  /** The harness's environment: the run's `git` first on PATH, and the tripwire for any other Git. */
  env: Record<string, string>;
}

/**
 * Write the run's `git` into its scratch directory, or answer null where it
 * cannot confine one: on Windows, or with no Git on PATH that reads the
 * configuration it relies on. A run answered null is granted no Git command.
 */
export function prepareSourceGit(scratchDir: string, platform: NodeJS.Platform = process.platform, path = process.env.PATH): SourceGit | null {
  if (platform === 'win32') return null;
  const realGit = machineGit(path);
  if (realGit === null) return null;
  const repository = realpathSync(join(scratchDir, RUN_REPOSITORY_DIR));
  const shimDir = join(scratchDir, SHIM_DIR);
  mkdirSync(shimDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(shimDir, 'git'), gitShimScript(realGit, repository), { mode: 0o700 });
  const shellSetup = join(scratchDir, SHELL_SETUP_FILE);
  writeFileSync(shellSetup, shellSetupScript(shimDir), { mode: 0o600 });
  return { shimDir, shellSetup, env: { ...GIT_TRIPWIRE_ENV, PATH: `${shimDir}${delimiter}${path ?? ''}` } };
}

