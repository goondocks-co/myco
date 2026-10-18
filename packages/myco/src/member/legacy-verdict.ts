/** File-only classification of Myco registrations. */
import path from 'node:path';
import fs from 'node:fs';
import { CREDENTIAL_FLAG } from '@myco/member/constants.js';

export type Verdict = 'member' | 'legacy' | 'foreign' | 'stale';

export const MYCO_PLUGIN_FILE_MARKER = 'myco:plugin-marker';
export const MEMBER_PLUGIN_MARKER = '// myco:member-plugin';

export function commandWords(command: string): { env: Record<string, string>; words: string[] } {
  const words = command.trim().match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^["']|["']$/g, '')) ?? [];
  const env: Record<string, string> = {};
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const [name, ...value] = words.shift()!.split('=');
    env[name] = value.join('=');
  }
  return { env, words };
}

const under = (file: string, home: string): boolean => file === home || file.startsWith(`${home}${path.sep}`);
const MANAGED_BINARY_HOME = /^(.*)[/\\]bin[/\\](?:versions[/\\][^/\\]+[/\\])?myco(?:\.exe)?$/;
const MCP_HEADER_HELPER_KEYS = ['headersHelper', 'http_headers_helper'] as const;

function absent(file: string, home = false): boolean {
  try { (home ? fs.lstatSync : fs.statSync)(file); return false; } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
  }
}

function staleBinary(binary: string | undefined, home?: string): string | undefined {
  if (binary === undefined || !path.isAbsolute(binary)) return;
  const inferred = binary.match(MANAGED_BINARY_HOME)?.[1];
  const homes = [home, inferred].filter((value): value is string => value !== undefined);
  if (homes.length > 0 && homes.every(path.isAbsolute) && absent(binary) && homes.every((home) => absent(home, true))) return binary;
}

export function staleCommandBinary(command: string): string | undefined {
  const { env, words } = commandWords(command);
  return staleBinary(words[0], env.MYCO_HOME);
}

export function mcpCommand(entry: unknown): { binary?: string; home?: string; helper?: string } {
  const record = (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
  const env = [record.env, record.environment].find((v) => v && typeof v === 'object' && !Array.isArray(v)) as Record<string, unknown> | undefined;
  const command = Array.isArray(record.command) ? record.command[0] : record.command;
  const home = typeof env?.MYCO_HOME === 'string' ? env.MYCO_HOME : undefined;
  const helper = MCP_HEADER_HELPER_KEYS.map((key) => record[key]).find((value): value is string => typeof value === 'string');
  return { binary: typeof command === 'string' ? command : undefined, home, helper };
}

export function staleMcpBinary(entry: unknown): string | undefined {
  const { binary, home, helper } = mcpCommand(entry);
  if (binary !== undefined) return staleBinary(binary, home);
  if (helper === undefined) return;
  const parsed = commandWords(helper);
  return staleBinary(parsed.words[0], parsed.env.MYCO_HOME ?? home);
}

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
  if (staleCommandBinary(command) !== undefined) return 'stale';
  if (command.includes(CREDENTIAL_FLAG)) return 'member';
  const { env, words } = commandWords(command);
  return verdictFor(words[0], env.MYCO_HOME, legacyHomes);
}

export function mcpVerdict(entry: unknown, legacyHomes: readonly string[]): Verdict {
  if (staleMcpBinary(entry) !== undefined) return 'stale';
  if ((JSON.stringify(entry) ?? '').includes(CREDENTIAL_FLAG)) return 'member';
  const { binary, home } = mcpCommand(entry);
  return verdictFor(binary, home, legacyHomes);
}

export function pluginBinaries(content: string): string[] {
  return [...content.matchAll(/["'`]([^"'`\r\n]+\/bin\/(?:versions\/[^/"'`]+\/)?myco(?:\.exe)?)["'`]|([^\s"'`=(]+\/bin\/(?:versions\/[^/\s]+\/)?myco(?:\.exe)?)\b/g)].map((m) => m[1] ?? m[2]);
}

function pluginHomes(content: string): string[] {
  return [...content.matchAll(/MYCO_HOME["'`]?\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s"'`,;)]+))/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

function homesNamedIn(content: string): string[] {
  const binaries = pluginBinaries(content).flatMap((binary) => binary.match(MANAGED_BINARY_HOME)?.[1] ?? []);
  return [...binaries, ...pluginHomes(content)].filter((home) => path.isAbsolute(home)).map((home) => path.resolve(home));
}

export function pluginFileVerdict(content: string, legacyHomes: readonly string[], ownHome?: string): Verdict | null {
  if (stalePluginBinary(content) !== undefined) return 'stale';
  const known = new Set([...legacyHomes, ...(ownHome === undefined ? [] : [ownHome])].map((home) => path.resolve(home)));
  if (homesNamedIn(content).some((home) => !known.has(home))) return 'foreign';
  if (content.includes(MEMBER_PLUGIN_MARKER) || content.includes(CREDENTIAL_FLAG)) return 'member';
  const legacy = legacyHomes.map((home) => path.resolve(home));
  if (content.includes(MYCO_PLUGIN_FILE_MARKER) || legacy.some((home) => content.includes(`${home}${path.sep}`))) return 'legacy';
  return null;
}

export function stalePluginBinary(content: string): string | undefined {
  const binaries = pluginBinaries(content);
  const homes = [...homesNamedIn(content), ...pluginHomes(content)];
  return binaries.length > 0 && homes.every(path.isAbsolute) && binaries.every((binary) => staleBinary(binary) !== undefined) && homes.every((home) => absent(home, true)) ? binaries[0] : undefined;
}
