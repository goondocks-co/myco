/**
 * Whose a Myco registration is, judged against the 1.4 homes a cutover
 * replaces: `member` (it names the member credential), `legacy` (no
 * credential, a binary under one of those homes or a bare `myco` resolved on
 * PATH, and no `MYCO_HOME` naming any other home), or `foreign`.
 */
import path from 'node:path';
import { CREDENTIAL_FLAG } from '../member/constants.js';

export type Verdict = 'member' | 'legacy' | 'foreign';

/** The line every plugin file Myco writes carries. */
export const MYCO_PLUGIN_FILE_MARKER = 'myco:plugin-marker';
/** The line a member plugin carries, so a global plugin steps aside for it. */
export const MEMBER_PLUGIN_MARKER = '// myco:member-plugin';

/** The words of a command line, and the `NAME=value` assignments before them. */
function commandWords(command: string): { env: Record<string, string>; words: string[] } {
  const words = command.trim().match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^["']|["']$/g, '')) ?? [];
  const env: Record<string, string> = {};
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const [name, ...value] = words.shift()!.split('=');
    env[name] = value.join('=');
  }
  return { env, words };
}

const under = (file: string, home: string): boolean => file === home || file.startsWith(`${home}${path.sep}`);

/** The verdict on a binary with no member credential, and the home it is told to use. */
function verdictFor(binary: string | undefined, mycoHome: string | undefined, legacyHomes: readonly string[]): Verdict {
  const homes = legacyHomes.map((home) => path.resolve(home));
  if (mycoHome !== undefined && !homes.includes(path.resolve(mycoHome))) return 'foreign';
  if (binary === undefined) return 'foreign';
  if (!binary.includes('/') && !binary.includes('\\')) return /^myco(\.exe)?$/.test(binary) ? 'legacy' : 'foreign';
  return homes.some((home) => under(path.resolve(binary), home)) ? 'legacy' : 'foreign';
}

/** The verdict on a Myco hook command. */
export function commandVerdict(command: string, legacyHomes: readonly string[]): Verdict {
  if (command.includes(CREDENTIAL_FLAG)) return 'member';
  const { env, words } = commandWords(command);
  return verdictFor(words[0], env.MYCO_HOME, legacyHomes);
}

/** The verdict on a `myco` MCP server entry. */
export function mcpVerdict(entry: unknown, legacyHomes: readonly string[]): Verdict {
  if ((JSON.stringify(entry) ?? '').includes(CREDENTIAL_FLAG)) return 'member';
  const record = (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
  const envBlock = [record.env, record.environment].find((v) => v && typeof v === 'object' && !Array.isArray(v)) as Record<string, unknown> | undefined;
  const command = Array.isArray(record.command) ? record.command[0] : record.command;
  const home = envBlock?.MYCO_HOME;
  return verdictFor(typeof command === 'string' ? command : undefined, typeof home === 'string' ? home : undefined, legacyHomes);
}

/** The homes a plugin names: every `<home>/bin/myco` it runs and every `MYCO_HOME` it sets. */
function homesNamedIn(content: string): string[] {
  const binaries = [...content.matchAll(/([^\s"'`=(]+)\/bin\/myco(?:\.exe)?\b/g)].map((m) => m[1]);
  const set = [...content.matchAll(/MYCO_HOME["'`]?\s*[:=]\s*["'`]?([^\s"'`,;)]+)/g)].map((m) => m[1]);
  return [...binaries, ...set].filter((home) => path.isAbsolute(home)).map((home) => path.resolve(home));
}

/**
 * The verdict on a whole plugin file, or null when it is not one Myco wrote.
 * A plugin that names any home other than a 1.4 home being cut over or
 * `ownHome` is `foreign`; one that declares a credential source (or the
 * member line) is `member`; a Myco plugin with neither is `legacy`.
 */
export function pluginFileVerdict(content: string, legacyHomes: readonly string[], ownHome?: string): Verdict | null {
  const known = new Set([...legacyHomes, ...(ownHome === undefined ? [] : [ownHome])].map((home) => path.resolve(home)));
  if (homesNamedIn(content).some((home) => !known.has(home))) return 'foreign';
  if (content.includes(MEMBER_PLUGIN_MARKER) || content.includes(CREDENTIAL_FLAG)) return 'member';
  const legacy = legacyHomes.map((home) => path.resolve(home));
  if (content.includes(MYCO_PLUGIN_FILE_MARKER) || legacy.some((home) => content.includes(`${home}${path.sep}`))) return 'legacy';
  return null;
}
