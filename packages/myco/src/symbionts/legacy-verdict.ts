/**
 * Whose a Myco registration is, judged against the 1.4 homes a cutover
 * replaces: `member` (it names the member credential), `legacy` (no
 * credential, a binary under one of those homes or a bare `myco` resolved on
 * PATH, and no `MYCO_HOME` naming any other home), or `foreign`.
 */
import path from 'node:path';
import { CREDENTIAL_FLAG } from '../member/constants.js';

export type Verdict = 'member' | 'legacy' | 'foreign';

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
