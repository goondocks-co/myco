/**
 * What a run may call, for every driver that answers a harness's permission
 * question.
 *
 * A grant is a list of rules in one vocabulary: a bare tool name allows that
 * tool whole, the run's server rule allows every tool the server serves, and a
 * rule with a specifier, `Bash(git log:*)`, allows only the commands that start
 * with its prefix. A driver whose harness names tools differently translates a
 * call into this vocabulary and asks the grant, rather than keeping a grant of
 * its own.
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_REPOSITORY_DIR, SOURCE_GIT_READ_COMMANDS } from '@goondocks/myco-shared/repository';
import type { RunSpec } from '../events.js';
import { MCP_SERVER_NAME } from '../mcp-config.js';

/** The run's own server, allowed whole. */
export const SERVER_GRANT = `mcp__${MCP_SERVER_NAME}`;

/** The tool a scoped command rule names. */
export const SHELL_TOOL = 'Bash';

/** A command that chains, pipes, redirects or substitutes runs more than its prefix names, so no scoped rule allows it. */
const UNSCOPED_COMMAND = /[;&|<>$`\n\r]/;

/** Source runs can inspect files and repository history without approving writes. */
function sourceReadTools(scratchDir: string): string[] {
  const root = join(scratchDir, RUN_REPOSITORY_DIR);
  const paths = [...new Set([RUN_REPOSITORY_DIR, root, realpathSync(root)])];
  const prefixes = ['git', ...paths.map((path) => `git -C ${path}`)];
  return ['Read', 'Glob', 'Grep', ...prefixes.flatMap((prefix) => SOURCE_GIT_READ_COMMANDS.map((command) => `${SHELL_TOOL}(${prefix} ${command}:*)`))];
}

/** The rules a run is granted: its own server, and file and history reads for a source run. */
export function grantOf(spec: RunSpec): string[] {
  return [SERVER_GRANT, ...(spec.sourceReadOnly === true ? sourceReadTools(spec.scratchDir) : [])];
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

/** The command prefix a scoped rule allows for this tool, or null when the rule is not one for it. */
function scopeOf(rule: string, tool: string): string | null {
  const open = `${tool}(`;
  const close = ':*)';
  return rule.startsWith(open) && rule.endsWith(close) ? rule.slice(open.length, -close.length) : null;
}

/**
 * Whether a grant allows this one call: its tool is granted whole, or its
 * command is a scoped rule's prefix, alone or followed by arguments.
 */
export function grantsCall(grant: readonly string[], tool: string, command: string | null): boolean {
  if (grantsWhole(grant, tool)) return true;
  if (command === null || UNSCOPED_COMMAND.test(command)) return false;
  return grant.some((rule) => {
    const scope = scopeOf(rule, tool);
    return scope !== null && (command === scope || command.startsWith(`${scope} `));
  });
}
