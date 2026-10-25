/**
 * Argument helpers every verb can import without loading anything else: no
 * daemon client, no vault, no Deployment. The CLI entry reads `--help` with
 * them before it knows which verb runs.
 */
import path from 'node:path';

export const MCP_ROOT_FLAG = '--root';

/** The explicit project directory, or the session directory supplied by the client. */
export function mcpProjectFolder(argv: readonly string[], cwd: string): string {
  const roots = argv.flatMap((word, index) => word === MCP_ROOT_FLAG ? [argv[index + 1]] : word.startsWith(`${MCP_ROOT_FLAG}=`) ? [word.slice(MCP_ROOT_FLAG.length + 1)] : []);
  if (roots.length === 0) return cwd;
  const root = roots[0];
  if (roots.length !== 1 || root === undefined || !path.isAbsolute(root)) throw new Error(`${MCP_ROOT_FLAG} requires one absolute project directory`);
  return root;
}

export function isHelpRequest(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

/**
 * Parse `--flag value` / `--flag=value` / bare `--flag` into positionals plus
 * a flag map, so the verbs that take free-form flags parse them identically.
 */
export function parseFlags(args: string[]): { positionals: string[]; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq > 2) { flags.set(arg.slice(2, eq), arg.slice(eq + 1)); continue; }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags.set(arg.slice(2), next); i += 1; }
    else flags.set(arg.slice(2), 'true');
  }
  return { positionals, flags };
}

export function printHelpIfRequested(args: readonly string[], usage: string): boolean {
  if (!isHelpRequest(args)) return false;
  process.stdout.write(usage);
  return true;
}

/** Every `--harness` given, in order. */
export function harnessesNamed(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--harness' && typeof args[i + 1] === 'string') out.push(args[i + 1]!);
  return out;
}
