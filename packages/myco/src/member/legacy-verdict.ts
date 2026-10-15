/** File-only classification of Myco registrations. */
import path from 'node:path';
import { CREDENTIAL_FLAG } from '@myco/member/constants.js';

export type Verdict = 'member' | 'legacy' | 'foreign';

export const MYCO_PLUGIN_FILE_MARKER = 'myco:plugin-marker';
export const MEMBER_PLUGIN_MARKER = '// myco:member-plugin';

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

function verdictFor(binary: string | undefined, mycoHome: string | undefined, legacyHomes: readonly string[]): Verdict {
  const homes = legacyHomes.map((home) => path.resolve(home));
  if (mycoHome !== undefined && !homes.includes(path.resolve(mycoHome))) return 'foreign';
  if (binary === undefined) return 'foreign';
  if (!binary.includes('/') && !binary.includes('\\')) return /^myco(\.exe)?$/.test(binary) ? 'legacy' : 'foreign';
  return homes.some((home) => under(path.resolve(binary), home)) ? 'legacy' : 'foreign';
}

/** Capture status recognizes legacy Myco hooks independently of their unmanaged home. */
export function isLegacyMycoHook(command: string): boolean {
  if (command.includes(CREDENTIAL_FLAG)) return false;
  const { words } = commandWords(command);
  return /^myco(\.exe)?$/.test(path.basename(words[0] ?? '')) && words[1] === 'hook';
}

export function commandVerdict(command: string, legacyHomes: readonly string[]): Verdict {
  if (command.includes(CREDENTIAL_FLAG)) return 'member';
  const { env, words } = commandWords(command);
  return verdictFor(words[0], env.MYCO_HOME, legacyHomes);
}

export function mcpVerdict(entry: unknown, legacyHomes: readonly string[]): Verdict {
  if ((JSON.stringify(entry) ?? '').includes(CREDENTIAL_FLAG)) return 'member';
  const record = (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
  const envBlock = [record.env, record.environment].find((v) => v && typeof v === 'object' && !Array.isArray(v)) as Record<string, unknown> | undefined;
  const command = Array.isArray(record.command) ? record.command[0] : record.command;
  const home = envBlock?.MYCO_HOME;
  return verdictFor(typeof command === 'string' ? command : undefined, typeof home === 'string' ? home : undefined, legacyHomes);
}

function homesNamedIn(content: string): string[] {
  const binaries = [...content.matchAll(/([^\s"'`=(]+)\/bin\/myco(?:\.exe)?\b/g)].map((m) => m[1]);
  const set = [...content.matchAll(/MYCO_HOME["'`]?\s*[:=]\s*["'`]?([^\s"'`,;)]+)/g)].map((m) => m[1]);
  return [...binaries, ...set].filter((home) => path.isAbsolute(home)).map((home) => path.resolve(home));
}

export function pluginFileVerdict(content: string, legacyHomes: readonly string[], ownHome?: string): Verdict | null {
  const known = new Set([...legacyHomes, ...(ownHome === undefined ? [] : [ownHome])].map((home) => path.resolve(home)));
  if (homesNamedIn(content).some((home) => !known.has(home))) return 'foreign';
  if (content.includes(MEMBER_PLUGIN_MARKER) || content.includes(CREDENTIAL_FLAG)) return 'member';
  const legacy = legacyHomes.map((home) => path.resolve(home));
  if (content.includes(MYCO_PLUGIN_FILE_MARKER) || legacy.some((home) => content.includes(`${home}${path.sep}`))) return 'legacy';
  return null;
}
