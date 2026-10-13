/** Pure parsers for installed service commands. */
import type { InstalledServiceCommand } from '@myco/member/legacy-service/types.js';
function decodePlistString(value: string): string | null {
  if (/&(?!(?:amp|lt|gt|quot);)/.test(value)) return null;
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

export function parsePlistDocument(plist: string): { [key: string]: PlistValue } | null {
  const xml = plist
    .replace(/^\s*<\?xml[^>]*\?>/, '')
    .replace(/^\s*<!DOCTYPE[^>]*>/, '');
  let index = 0;

  const skipWhitespace = (): void => {
    while (/\s/.test(xml[index] ?? '')) index++;
  };
  const consume = (pattern: RegExp): string | null => {
    skipWhitespace();
    const match = xml.slice(index).match(pattern);
    if (!match || match.index !== 0) return null;
    index += match[0].length;
    return match[0];
  };
  const textElement = (tag: 'key' | 'string'): string | undefined => {
    if (consume(new RegExp(`^<${tag}>`)) === null) return undefined;
    const close = `</${tag}>`;
    const closeIndex = xml.indexOf(close, index);
    if (closeIndex === -1) return undefined;
    const encoded = xml.slice(index, closeIndex);
    if (encoded.includes('<')) return undefined;
    index = closeIndex + close.length;
    return decodePlistString(encoded) ?? undefined;
  };
  const value = (): PlistValue | undefined => {
    skipWhitespace();
    if (xml.startsWith('<string>', index)) return textElement('string');
    if (consume(/^<true\s*\/>/) !== null) return true;
    if (consume(/^<false\s*\/>/) !== null) return false;
    if (consume(/^<integer>/) !== null) {
      const closeIndex = xml.indexOf('</integer>', index);
      if (closeIndex === -1) return undefined;
      const raw = xml.slice(index, closeIndex);
      if (!/^-?\d+$/.test(raw)) return undefined;
      index = closeIndex + '</integer>'.length;
      return parseInt(raw, 10);
    }
    if (consume(/^<array>/) !== null) {
      const result: PlistValue[] = [];
      while (true) {
        skipWhitespace();
        if (consume(/^<\/array>/) !== null) return result;
        const item = value();
        if (item === undefined) return undefined;
        result.push(item);
      }
    }
    if (consume(/^<dict>/) !== null) {
      const result: { [key: string]: PlistValue } = Object.create(null) as { [key: string]: PlistValue };
      while (true) {
        skipWhitespace();
        if (consume(/^<\/dict>/) !== null) return result;
        const key = textElement('key');
        if (key === undefined || Object.hasOwn(result, key)) return undefined;
        const item = value();
        if (item === undefined) return undefined;
        result[key] = item;
      }
    }
    return undefined;
  };

  if (consume(/^<plist(?:\s[^>]*)?>/) === null) return null;
  const root = value();
  if (!root || Array.isArray(root) || typeof root !== 'object') return null;
  if (consume(/^<\/plist>/) === null) return null;
  skipWhitespace();
  return index === xml.length ? root : null;
}
export function parseSystemdCommand(unit: string): InstalledServiceCommand | null {
  const serviceSections = [...unit.matchAll(/^\[Service\]\s*$/gm)];
  if (serviceSections.length !== 1) return null;
  const sectionStart = serviceSections[0].index! + serviceSections[0][0].length;
  const sectionRemainder = unit.slice(sectionStart);
  const nextSection = sectionRemainder.search(/^\[[^\]]+\]\s*$/m);
  const serviceSection = nextSection === -1
    ? sectionRemainder
    : sectionRemainder.slice(0, nextSection);
  const execStartLines = serviceSection
    .split(/\r?\n/)
    .filter((line) => line.startsWith('ExecStart='));
  if (execStartLines.length !== 1) return null;
  const words = parseSystemdQuotedWords(execStartLines[0].slice('ExecStart='.length));
  if (!words || words.length === 0) return null;
  return { executable: words[0], args: words.slice(1) };
}

function parseSystemdQuotedWords(value: string): string[] | null {
  const words: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (value[index] === ' ') index++;
    if (index === value.length) break;
    if (value[index] !== '"') return null;
    index++;
    let word = '';
    let closed = false;
    while (index < value.length) {
      const char = value[index++];
      if (char === '"') {
        closed = true;
        break;
      }
      if (char === '\\') {
        const escaped = value[index++];
        if (escaped !== '\\' && escaped !== '"') return null;
        word += escaped;
      } else {
        word += char;
      }
    }
    if (!closed || (index < value.length && value[index] !== ' ')) return null;
    words.push(word);
  }
  return words;
}

export function parseWindowsLauncherCommand(script: string): InstalledServiceCommand | null {
  const executableAssignments = script
    .split(/\r?\n/)
    .map((line) => line.match(/^\$executable = ('.*')$/))
    .filter((match): match is RegExpMatchArray => match !== null);
  const argumentAssignments = script
    .split(/\r?\n/)
    .map((line) => line.match(/^\$arguments = @\((.*)\)$/))
    .filter((match): match is RegExpMatchArray => match !== null);
  if (executableAssignments.length !== 1 || argumentAssignments.length !== 1) {
    return null;
  }
  const executable = decodePowerShellLiteral(executableAssignments[0][1]);
  const argumentText = argumentAssignments[0][1];
  const argumentLiterals = argumentText === ''
    ? []
    : argumentText.split(', ');
  const args = argumentLiterals.map(decodePowerShellLiteral);
  if (executable === null || args.some((arg) => arg === null)) return null;
  if (argumentLiterals.join(', ') !== argumentText) return null;
  return { executable, args: args as string[] };
}

export function decodePowerShellLiteral(value: string): string | null {
  if (!/^'(?:[^']|'')*'$/.test(value)) return null;
  return value.slice(1, -1).replace(/''/g, "'");
}

/** The home recorded by a PowerShell launcher, with MYCO_HOME taking precedence. */
export function parseWindowsLauncherHome(script: string): string | null {
  const environment = [...script.matchAll(/^\s*\$startInfo\.EnvironmentVariables\['MYCO_HOME'\] = ('.*')\r?$/gm)];
  if (environment.length > 1) return null;
  if (environment.length === 1) return decodePowerShellLiteral(environment[0][1]);
  const directories = [...script.matchAll(/^\$workingDirectory = ('.*')\r?$/gm)];
  return directories.length === 1 ? decodePowerShellLiteral(directories[0][1]) : null;
}
