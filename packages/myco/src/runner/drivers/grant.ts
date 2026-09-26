/**
 * What a run may call, for every driver that answers a harness's permission
 * question.
 *
 * A grant is a list of rules in one vocabulary: a bare tool name allows that
 * tool whole, the run's server rule allows every tool the server serves, and a
 * rule with a specifier, `Bash(git log:*)`, allows only the commands that start
 * with its words. A driver whose harness names tools differently translates a
 * call into this vocabulary and asks the grant, rather than keeping a grant of
 * its own.
 *
 * A source run's Git rules come only with the run's own `git` and the
 * environment that puts it first (`source-git.ts`): a harness matching a rule
 * by its prefix cannot see a command's arguments, and the run's `git` is where
 * they are held to reads of the checkout. Where the harness's shell does not
 * reach the run's `git`, or no such `git` can be written, no Git rule is
 * granted.
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_REPOSITORY_DIR, SOURCE_GIT_READ_COMMANDS } from '@goondocks/myco-shared/repository';
import type { RunSpec } from '../events.js';
import type { Harness } from '../harnesses.js';
import { MCP_SERVER_NAME } from '../mcp-config.js';
import { gitReadRefusal, prepareSourceGit, shellWords, type SourceGit } from './source-git.js';

/** The run's own server, allowed whole. */
export const SERVER_GRANT = `mcp__${MCP_SERVER_NAME}`;

/** The tool a scoped command rule names. */
export const SHELL_TOOL = 'Bash';

/** The command every scoped rule a run is granted names. */
const GIT = 'git';

/** A command that chains, pipes, redirects or substitutes runs more than its prefix names, so no scoped rule allows it. */
const UNSCOPED_COMMAND = /[;&|<>$`\n\r]/;

/** The file tools a source run reads its checkout with. */
const SOURCE_FILE_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];

/** Source runs can inspect files, and repository history where the run's `git` holds it to reads. */
function sourceReadTools(scratchDir: string, git: SourceGit | null): string[] {
  if (git === null) return [...SOURCE_FILE_TOOLS];
  const root = join(scratchDir, RUN_REPOSITORY_DIR);
  const paths = [...new Set([RUN_REPOSITORY_DIR, root, realpathSync(root)])];
  const prefixes = [GIT, ...paths.map((path) => `${GIT} -C ${path}`)];
  return [...SOURCE_FILE_TOOLS, ...prefixes.flatMap((prefix) => SOURCE_GIT_READ_COMMANDS.map((command) => `${SHELL_TOOL}(${prefix} ${command}:*)`))];
}

/** What a run may call, and what a harness's environment needs so its calls are held to it. */
export interface RunGrant {
  rules: readonly string[];
  /** Added to the harness's environment. */
  env: Record<string, string>;
  /** A script a harness's shell sources before each command, or null where the run has none. */
  shellSetup: string | null;
  /** The run's own directory, which no command may be run outside. */
  runDir: string;
}

/**
 * The run's grant on this harness: its own server, and file and history reads
 * for a source run. History reads are granted only on a harness whose shell
 * reaches the run's `git`, and this writes that `git` into the run's scratch
 * directory first, so a grant holding a Git rule always comes with the
 * environment that confines it.
 */
export function runGrant(spec: RunSpec, harness: Pick<Harness, 'sourceGit'>, platform: NodeJS.Platform = process.platform): RunGrant {
  const git = spec.sourceReadOnly === true && harness.sourceGit === 'shim' ? prepareSourceGit(spec.scratchDir, platform) : null;
  return {
    rules: [SERVER_GRANT, ...(spec.sourceReadOnly === true ? sourceReadTools(spec.scratchDir, git) : [])],
    env: git?.env ?? {},
    shellSetup: git?.shellSetup ?? null,
    runDir: spec.scratchDir,
  };
}

/**
 * Whether a grant allows every call of this tool.
 *
 * A bare rule names a whole tool, and the server rule every tool the server
 * serves. A rule with a specifier allows only the calls it matches, so it never
 * grants its tool whole.
 */
export function grantsWhole(grant: readonly string[], tool: string): boolean {
  return grant.some((rule) => rule === tool || (rule === SERVER_GRANT && tool.startsWith(`${SERVER_GRANT}__`)));
}

/** The command words a scoped rule allows for this tool, or null when the rule is not one for it. */
function scopeOf(rule: string, tool: string): string[] | null {
  const open = `${tool}(`;
  const close = ':*)';
  return rule.startsWith(open) && rule.endsWith(close) ? rule.slice(open.length, -close.length).split(' ') : null;
}

/**
 * Whether a grant allows this one call: its tool is granted whole, or its
 * command's words begin with a scoped rule's words and, for Git, its arguments
 * are a read the run may make. A command a shell would expand, chain or
 * redirect is allowed by no scoped rule.
 */
export function grantsCall(grant: readonly string[], tool: string, command: string | null): boolean {
  if (grantsWhole(grant, tool)) return true;
  if (command === null || UNSCOPED_COMMAND.test(command)) return false;
  const words = shellWords(command);
  if (words === null) return false;
  const scoped = grant.some((rule) => {
    const scope = scopeOf(rule, tool);
    return scope !== null && scope.length <= words.length && scope.every((word, at) => words[at] === word);
  });
  return scoped && (words[0] !== GIT || gitReadRefusal(words.slice(1)) === null);
}
