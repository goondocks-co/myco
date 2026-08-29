/**
 * The credential record a member hook runs under. The SOURCE is declared by
 * the hook command (`--credential registry|env`) and never inferred: the
 * registry source reads the entry for the resolved project root and nothing
 * else; the env source reads the `MYCO_SERVER_URL` + `MYCO_MEMBER_TOKEN` +
 * `MYCO_PROJECT` triplet, all three or none. Every record's server URL must
 * be `https:`.
 */
import { resolveProjectRoot, resolveVaultDir } from '../project-root.js';
import { resolveMycoHome } from '../paths/home.js';
import { CREDENTIAL_FLAG, CREDENTIAL_SOURCES, MEMBER_TOKEN_PATTERN, type CredentialSource } from './constants.js';
import { readRegistryEntry } from './registry.js';

export { CREDENTIAL_FLAG, type CredentialSource };

export interface CredentialRecord {
  serverUrl: string;
  token: string;
  tokenId?: string;
  projectId: string;
  expiresAt?: number;
  refreshAfter?: number;
  refreshTerminal?: boolean;
  source: CredentialSource;
  /** The project root the registry entry is keyed on; absent for env-sourced records. */
  root?: string;
}

export const ENV_SERVER_URL = 'MYCO_SERVER_URL';
export const ENV_MEMBER_TOKEN = 'MYCO_MEMBER_TOKEN';
export const ENV_PROJECT = 'MYCO_PROJECT';

/** The declared source on a hook command line (`--credential registry`, `--credential=env`), or null when absent or not a known source. */
export function parseCredentialFlag(argv: readonly string[]): CredentialSource | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let value: string | undefined;
    if (arg === CREDENTIAL_FLAG) value = argv[i + 1];
    else if (arg.startsWith(`${CREDENTIAL_FLAG}=`)) value = arg.slice(CREDENTIAL_FLAG.length + 1);
    if (value !== undefined) return (CREDENTIAL_SOURCES as readonly string[]).includes(value) ? (value as CredentialSource) : null;
  }
  return null;
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** A host on this machine's own loopback, where the self-hosted C-local transport listens: the IPv4 loopback block, the IPv6 loopback, or its name. */
const isLoopbackHost = (hostname: string): boolean => hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);

/** True for `http://` on a loopback host — the one plain-http shape an injected credential may name; a registry entry never does. */
export function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

export function isMemberTokenShape(value: string): boolean {
  return MEMBER_TOKEN_PATTERN.test(value);
}

/** The worktree-aware project root a hook invocation belongs to. */
export function resolveMemberProjectRoot(cwd: string = process.cwd()): string {
  return resolveProjectRoot(resolveVaultDir(cwd));
}

const stderr = (line: string): void => { process.stderr.write(`[myco] member: ${line}\n`); };

/**
 * The record for the declared source, or null with one stderr line when the
 * source is missing, the entry is absent, the triplet is partial, or the URL
 * is not https. Nothing here reads a source the command did not declare.
 */
export function resolveCredential(
  source: CredentialSource | null,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; mycoHome?: string } = {},
): CredentialRecord | null {
  if (source === null) {
    stderr(`hook command must declare ${CREDENTIAL_FLAG} registry|env — no capture`);
    return null;
  }
  if (source === 'env') return envCredential(opts.env ?? process.env);
  const root = resolveMemberProjectRoot(opts.cwd);
  const entry = readRegistryEntry(root, opts.mycoHome ?? resolveMycoHome());
  if (!entry) {
    stderr(`no registry entry for ${root} — run \`myco member join <server-url> --project <id>\`; no capture`);
    return null;
  }
  if (!isHttpsUrl(entry.serverUrl)) {
    stderr(`registry entry for ${root} names a non-https server — no capture`);
    return null;
  }
  return {
    serverUrl: entry.serverUrl, token: entry.token, tokenId: entry.tokenId, projectId: entry.projectId,
    expiresAt: entry.expiresAt, refreshAfter: entry.refreshAfter, refreshTerminal: entry.refreshTerminal, source: 'registry', root,
  };
}

function envCredential(env: NodeJS.ProcessEnv): CredentialRecord | null {
  const serverUrl = env[ENV_SERVER_URL]?.trim() || undefined;
  const token = env[ENV_MEMBER_TOKEN]?.trim() || undefined;
  const projectId = env[ENV_PROJECT]?.trim() || undefined;
  const present = [serverUrl, token, projectId].filter((v) => v !== undefined).length;
  if (present === 0) {
    stderr(`${ENV_SERVER_URL}, ${ENV_MEMBER_TOKEN}, ${ENV_PROJECT} are not set — no capture`);
    return null;
  }
  if (present < 3) {
    stderr(`${ENV_SERVER_URL} + ${ENV_MEMBER_TOKEN} + ${ENV_PROJECT} must all be set (all three or none) — no capture`);
    return null;
  }
  if (!isHttpsUrl(serverUrl!) && !isLoopbackHttpUrl(serverUrl!)) {
    stderr(`${ENV_SERVER_URL} must be https, or http on this machine's loopback — no capture`);
    return null;
  }
  return { serverUrl: serverUrl!, token: token!, projectId: projectId!, source: 'env' };
}
