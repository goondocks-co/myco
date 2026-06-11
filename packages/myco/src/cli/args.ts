/**
 * Strict argv parsing for CLI subcommands with destructive surfaces.
 *
 * Each subcommand declares its complete flag vocabulary. Anything outside
 * that vocabulary — an unknown flag, a stray positional, or a value-taking
 * flag with no value — is a usage error (exit code 2) rather than a
 * silently-ignored token. A silently-dropped `--project` on `myco remove`
 * is how a project-scoped removal becomes a machine-wide teardown, and a
 * silently-dropped value on `myco update --project` is how a one-project
 * update fans out to every registered project.
 *
 * Benign read-only commands keep the permissive `parseStringFlag` helper;
 * this module is for commands whose misparse mutates state.
 */

export interface FlagSpec {
  /** Canonical flag name, including leading dashes (e.g. '--project'). */
  name: string;
  /** Alternate spellings that map to the canonical name (e.g. '-h'). */
  aliases?: string[];
  /**
   * Whether the flag consumes the following token as its value.
   *  - 'none' (default): boolean flag.
   *  - 'required': missing value (end of args, or next token is a flag)
   *    is a usage error.
   *  - 'optional': value is taken when the next token is not a flag,
   *    otherwise the flag is treated as bare presence.
   */
  value?: 'none' | 'required' | 'optional';
}

export interface ParsedFlags {
  /** Whether the flag (by canonical name) was present in argv. */
  has(name: string): boolean;
  /** Value for a value-taking flag; undefined when absent or bare. */
  value(name: string): string | undefined;
}

/**
 * Parse argv against a strict flag vocabulary. On any usage error, prints
 * the offending token plus the command's usage text to stderr and exits
 * with code 2.
 */
export function parseStrictFlags(
  command: string,
  args: string[],
  specs: FlagSpec[],
  usage: string,
): ParsedFlags {
  const byToken = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byToken.set(spec.name, spec);
    for (const alias of spec.aliases ?? []) byToken.set(alias, spec);
  }

  const present = new Set<string>();
  const values = new Map<string, string>();

  const fail = (message: string): never => {
    process.stderr.write(`${command}: ${message}\n\n${usage}`);
    return process.exit(2);
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith('-')) {
      fail(`unexpected argument '${token}'`);
    }
    const spec = byToken.get(token);
    if (!spec) {
      fail(`unknown flag '${token}'`);
      continue;
    }
    present.add(spec.name);
    const mode = spec.value ?? 'none';
    if (mode === 'none') continue;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      values.set(spec.name, next);
      i++;
    } else if (mode === 'required') {
      fail(`${token} requires a value`);
    }
  }

  return {
    has: (name) => present.has(name),
    value: (name) => values.get(name),
  };
}
