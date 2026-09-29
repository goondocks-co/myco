/**
 * The credential record a member hook runs under. The SOURCE is declared by
 * the hook command (`--credential registry|env`) and never inferred: the
 * registry source reads the entry for the resolved project root and nothing
 * else. The env source reads what this process's environment carries: the
 * `MYCO_SERVER_URL` + `MYCO_MEMBER_TOKEN` + `MYCO_PROJECT` triplet, all three
 * or none, or — when no part of the triplet is set — a `MYCO_JOIN_CODE`,
 * whose redemption is this machine's own registry membership. Every record's
 * server URL passes the one member rule (`server-url.ts`).
 */
import { resolveProjectRoot, resolveVaultDir } from '../project-root.js';
import { resolveMycoHome } from '../paths/home.js';
import { CREDENTIAL_FLAG, CREDENTIAL_SOURCES, ENV_JOIN_CODE, MEMBER_TOKEN_PATTERN, type CredentialSource, type RefreshTerminalReason } from './constants.js';
import { recordMissingMembership } from './no-membership.js';
import { listRegistryEntries, readRegistryEntry, type RegistryEntry } from './registry.js';
import { isMemberServerUrl, MEMBER_SERVER_URL_RULE } from './server-url.js';

export { CREDENTIAL_FLAG, type CredentialSource };

export interface CredentialRecord {
  serverUrl: string;
  token: string;
  tokenId?: string;
  projectId: string;
  expiresAt?: number;
  refreshAfter?: number;
  refreshTerminal?: boolean;
  refreshTerminalBy?: string;
  refreshTerminalReason?: RefreshTerminalReason;
  refreshRetries?: Record<string, number>;
  nonRotating?: boolean;
  refusedAt?: number | null;
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

export function isMemberTokenShape(value: string): boolean {
  return MEMBER_TOKEN_PATTERN.test(value);
}

/** The worktree-aware project root a hook invocation belongs to. */
export function resolveMemberProjectRoot(cwd: string = process.cwd()): string {
  return resolveProjectRoot(resolveVaultDir(cwd));
}

const stderr = (line: string): void => { process.stderr.write(`[myco] member: ${line}\n`); };

export interface CredentialOptions {
  /** The directory this invocation belongs to: a hook's payload `cwd`, else the process's. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  mycoHome?: string;
  /** What is asking, for the record a missed membership leaves behind (`hook stop`, `mcp`). */
  invokedBy?: string;
}

/**
 * The record for the declared source, or null with one stderr line when the
 * source is missing, the entry is absent, the triplet is partial, or the URL
 * breaks the member rule. Nothing here reads a source the command did not declare.
 *
 * The home is resolved from the SAME directory the project root is resolved
 * from, so a project pinned to a non-default home reads the registry that
 * holds its membership even when nothing set `MYCO_HOME` (see
 * `paths/home.ts`).
 *
 * Synchronous by design: redeeming a join code is a network call, made before
 * this by the one caller that may spend it (`capture.ts`, gated on
 * {@link redeemsJoinCode}); this only reads what that redemption wrote.
 */
export function resolveCredential(
  source: CredentialSource | null,
  opts: CredentialOptions = {},
): CredentialRecord | null {
  if (source === null) {
    stderr(`hook command must declare ${CREDENTIAL_FLAG} registry|env — no capture`);
    return null;
  }
  const env = opts.env ?? process.env;
  if (source === 'env' && !envCarriesJoinCode(env)) return envCredential(env);
  const cwd = opts.cwd ?? process.cwd();
  const root = resolveMemberProjectRoot(cwd);
  const mycoHome = opts.mycoHome ?? resolveMycoHome({ cwd, env: opts.env });
  const entry = readRegistryEntry(root, mycoHome) ?? soleMembershipForMcp(mycoHome, opts.invokedBy);
  if (!entry) {
    if (source === 'env') {
      stderr(`${ENV_JOIN_CODE} has not been redeemed for ${root} — no capture`);
      return null;
    }
    // The hook still exits 0 — a non-zero hook breaks the harness — so the
    // miss is counted under the home this invocation resolved, where
    // `myco member status` reads it back.
    recordMissingMembership(root, { mycoHome, invokedBy: opts.invokedBy });
    stderr(`no registry entry for ${root} — run \`myco member join <server-url> --project <id>\`; no capture`);
    return null;
  }
  if (!isMemberServerUrl(entry.serverUrl)) {
    stderr(`registry entry for ${root} names a server that is not ${MEMBER_SERVER_URL_RULE} — no capture`);
    return null;
  }
  return registryCredential(entry, root);
}

/**
 * Whether the env source takes its credential from a join code: a
 * `MYCO_JOIN_CODE` is set and no part of the triplet is. A triplet the
 * orchestrator handed over wins, and a partial one is refused as partial —
 * neither spends the code.
 *
 * A redeemed code is not an orchestrator's token. `/members/join` mints this
 * machine a rotating credential of its own and it is kept in the registry,
 * under the registry lock, like any other membership; so the record it
 * resolves to is a registry record, which rotates. The non-rotating rule for
 * env credentials covers the triplet only: a token copied into many
 * sandboxes, which no one of them may rotate.
 */
function envCarriesJoinCode(env: NodeJS.ProcessEnv): boolean {
  if (!env[ENV_JOIN_CODE]?.trim()) return false;
  return [ENV_SERVER_URL, ENV_MEMBER_TOKEN, ENV_PROJECT].every((key) => !env[key]?.trim());
}

/**
 * Whether a hook declaring `source` would capture on a credential redeemed
 * from `MYCO_JOIN_CODE`, and so may spend it. A join code is single-use: it is
 * spent only where the resolve that follows reads what it yields, never on a
 * hook with no declared source or one whose env triplet supplies the
 * credential instead.
 */
export function redeemsJoinCode(source: CredentialSource | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env[ENV_JOIN_CODE]?.trim()) return false;
  return source === 'registry' || (source === 'env' && envCarriesJoinCode(env));
}

/** The credential a registry entry holds, for the project root it is keyed on. */
export function registryCredential(entry: RegistryEntry, root: string): CredentialRecord {
  return {
    serverUrl: entry.serverUrl, token: entry.token, tokenId: entry.tokenId, projectId: entry.projectId,
    expiresAt: entry.expiresAt, refreshAfter: entry.refreshAfter, refreshTerminal: entry.refreshTerminal, refreshTerminalBy: entry.refreshTerminalBy,
    refreshTerminalReason: entry.refreshTerminalReason, refreshRetries: entry.refreshRetries, nonRotating: entry.nonRotating, refusedAt: entry.refusedAt, source: 'registry', root,
  };
}

/**
 * The one membership a home holds, for an MCP bridge whose harness started it
 * somewhere other than the project.
 *
 * A harness that spawns its stdio server at `/` or at the user's home hands the
 * bridge no project to look up, and the bridge resolves no credential however
 * correct the install. Tenancy on the tool surface is a tool parameter, and a
 * read defaults to the caller's bound Projects, so on a machine that holds one
 * membership the membership is not in doubt. Two memberships are: the bridge
 * then says which project it needs to be started in. A hook never takes this
 * path — a hook that fires in an unjoined project must find no membership, or
 * one project's sessions land in another's.
 */
function soleMembershipForMcp(mycoHome: string, invokedBy: string | undefined): RegistryEntry | null {
  if (invokedBy !== 'mcp') return null;
  const entries = listRegistryEntries(mycoHome);
  if (entries.length !== 1) {
    if (entries.length > 1) stderr(`this directory is in none of the ${entries.length} joined projects — start the MCP server inside the project it should serve`);
    return null;
  }
  stderr(`this directory is not a joined project; serving the one membership this machine holds (${entries[0].root})`);
  return entries[0];
}

function envCredential(env: NodeJS.ProcessEnv): CredentialRecord | null {
  const serverUrl = env[ENV_SERVER_URL]?.trim() || undefined;
  const token = env[ENV_MEMBER_TOKEN]?.trim() || undefined;
  const projectId = env[ENV_PROJECT]?.trim() || undefined;
  const present = [serverUrl, token, projectId].filter((v) => v !== undefined).length;
  if (present === 0) {
    stderr(`${ENV_SERVER_URL}, ${ENV_MEMBER_TOKEN}, ${ENV_PROJECT} are not set, and neither is ${ENV_JOIN_CODE} — no capture`);
    return null;
  }
  if (present < 3) {
    stderr(`${ENV_SERVER_URL} + ${ENV_MEMBER_TOKEN} + ${ENV_PROJECT} must all be set (all three or none) — no capture`);
    return null;
  }
  if (!isMemberServerUrl(serverUrl!)) {
    stderr(`${ENV_SERVER_URL} must be ${MEMBER_SERVER_URL_RULE} — no capture`);
    return null;
  }
  return { serverUrl: serverUrl!, token: token!, projectId: projectId!, source: 'env' };
}
