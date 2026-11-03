export type CommandSyntax = 'posix' | 'cmd' | 'portable' | 'systemd' | 'systemd-environment';

const BARE_METACHARACTERS = /[\s\p{Cc}\\'"`$%!^&|;()<>{}\[\]*?]/u;
const isBareArgument = (value: string): boolean => value.length > 0 && !BARE_METACHARACTERS.test(value) && !/^[~#]/.test(value);

/** One literal argument for the named command interpreter. */
export function commandArgument(value: string, syntax: CommandSyntax = 'posix', expansions: readonly string[] = []): string {
  if (/[\0\r\n]/.test(value)) throw new Error('A command argument cannot contain a line break or NUL');
  if (syntax === 'portable') {
    if (/[$`%!"\\]/.test(value)) throw new Error('A portable command argument cannot contain shell expansion syntax');
    return isBareArgument(value) ? value : `"${value}"`;
  }
  if (syntax === 'cmd') {
    const literal = expansions.reduce((text, name) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid environment expansion');
      return text.replaceAll(`%${name}%`, '');
    }, value);
    if (/[%!"]/.test(literal)) throw new Error('A command argument cannot contain cmd expansion syntax');
    return isBareArgument(value) ? value : `"${value}"`;
  }
  if (syntax === 'systemd' || syntax === 'systemd-environment') {
    if (isBareArgument(value)) return value;
    const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
    return `"${syntax === 'systemd' ? escaped.replaceAll('$', () => '$$') : escaped}"`;
  }
  return isBareArgument(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
}

/** A command built from literal arguments. */
export function commandLine(argv: readonly string[], syntax: CommandSyntax = 'posix'): string {
  return argv.map(value => commandArgument(value, syntax)).join(' ');
}

/** A host that splits command strings without a shell accepts only bare words. */
export function assertBareCommandArgument(value: string): void {
  if (!isBareArgument(value)) throw new Error('The command host requires a literal path without whitespace or shell syntax');
}

/** Literal words emitted into a systemd unit; unresolved expansions cannot identify an installed target. */
export function systemdWords(value: string, syntax: 'systemd' | 'systemd-environment' = 'systemd'): string[] | null {
  const words: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (/\s/.test(char) && quote === '') {
      if (started) words.push(word);
      word = ''; started = false;
      continue;
    }
    started = true;
    if (char === '"' || char === "'") {
      if (quote === '') { quote = char; continue; }
      if (quote === char) { quote = ''; continue; }
    }
    if (char === '\\') {
      const escaped = value[++i];
      const escapes: Record<string, string> = { '\\': '\\', '"': '"', "'": "'", s: ' ', n: '\n', r: '\r', t: '\t' };
      if (escaped === undefined || escapes[escaped] === undefined) return null;
      word += escapes[escaped];
    } else if (char === '%' || (char === '$' && syntax === 'systemd')) {
      if (value[++i] !== char) return null;
      word += char;
    } else word += char;
  }
  if (quote !== '') return null;
  if (started) words.push(word);
  return words;
}

/** The effective literal environment of a systemd unit, or null for unresolved syntax. */
export function systemdEnvironment(unit: string): Record<string, string> | null {
  let environment: Record<string, string> = {};
  for (const match of unit.matchAll(/^Environment=(.*)$/gm)) {
    const words = systemdWords(match[1]!, 'systemd-environment');
    if (words === null) return null;
    if (words.length === 0) environment = {};
    for (const word of words) {
      const equals = word.indexOf('=');
      if (equals <= 0) return null;
      environment[word.slice(0, equals)] = word.slice(equals + 1);
    }
  }
  return environment;
}
