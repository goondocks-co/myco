import { MEMBER_SERVER_URL_RULE, normalizeMemberServerAddress } from '../member/server-url.js';

/** What the runner verbs take from their caller; each defaults to the real process. */
export interface RunnerCliDeps {
  fetch?: typeof fetch;
  mycoHome?: string;
  machineId?: string;
  hostname?: () => string;
  os?: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** The names a Deployment accepts for a runner. */
export const RUNNER_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const RUNNER_NAME_MAX_CHARS = 64;
const FALLBACK_RUNNER_NAME = 'runner';

/** The words a refused address is given. */
export const RUNNER_ADDRESS_RULE = `a Deployment address must be ${MEMBER_SERVER_URL_RULE}, with no account, password, path or query`;

/** The Deployment origin an address names, or null where the address is not one a runner may dial. */
export function runnerServerUrl(address: string): string | null {
  const url = normalizeMemberServerAddress(address);
  if (url === null || url.search !== '' || url.hash !== '' || url.pathname.replace(/\/+$/, '') !== '') return null;
  return url.origin;
}

/** A host name reduced to the characters a runner name allows. */
export function defaultRunnerName(hostname: string): string {
  const name = hostname.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, RUNNER_NAME_MAX_CHARS);
  return name === '' ? FALLBACK_RUNNER_NAME : name;
}
