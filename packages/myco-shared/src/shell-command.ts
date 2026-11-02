export type CommandSyntax = 'posix' | 'cmd' | 'systemd';

const BARE_ARGUMENT = /^[A-Za-z0-9_./:@=,+-]+$/;

/** One literal argument for the named command interpreter. */
export function commandArgument(value: string, syntax: CommandSyntax = 'posix', expansions: readonly string[] = []): string {
  if (/[\0\r\n]/.test(value)) throw new Error('A command argument cannot contain a line break or NUL');
  if (syntax === 'cmd') {
    const literal = expansions.reduce((text, name) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid environment expansion');
      return text.replaceAll(`%${name}%`, '');
    }, value);
    if (/[%!"]/.test(literal)) throw new Error('A command argument cannot contain cmd expansion syntax');
    return BARE_ARGUMENT.test(value) ? value : `"${value}"`;
  }
  if (syntax === 'systemd') {
    if (BARE_ARGUMENT.test(value)) return value;
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$')}"`;
  }
  return BARE_ARGUMENT.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
}

/** A command built from literal arguments. */
export function commandLine(argv: readonly string[], syntax: CommandSyntax = 'posix'): string {
  return argv.map(value => commandArgument(value, syntax)).join(' ');
}

/** A host that splits command strings without a shell accepts only bare words. */
export function assertBareCommandArgument(value: string): void {
  if (!BARE_ARGUMENT.test(value)) throw new Error('The command host requires a literal path without whitespace or shell syntax');
}
