/**
 * The machine's default Deployment: where a repository this machine meets with no connection of its own joins by
 * itself (#1547). `myco login` records it when none is recorded, and `myco login --default` moves it. A repository
 * connected to another Deployment with `myco member join` keeps that connection: nothing here reads or changes it.
 *
 * One file, `<MYCO_HOME>/member/default.json`, in the member's private store. It names a server URL only; the
 * credential is the membership the registry holds for that URL, so a default whose membership is gone joins nothing.
 */
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { deploymentUrl, readDeploymentMembership, type DeploymentMembership } from './registry.js';
import { ensureMemberDir, memberRoot, readPrivateJson, writePrivateFileAtomic } from './store.js';

export const DEFAULT_DEPLOYMENT_FILE = 'default.json';
export const DEFAULT_DEPLOYMENT_VERSION = 1;

export interface DefaultDeployment {
  version: number;
  serverUrl: string;
  setAt: number;
}

export function defaultDeploymentPath(mycoHome: string = resolveMycoHome()): string {
  return path.join(memberRoot(mycoHome), DEFAULT_DEPLOYMENT_FILE);
}

/** The recorded default, or null when none is recorded or the file holds nothing readable. */
export function readDefaultDeployment(mycoHome: string = resolveMycoHome()): DefaultDeployment | null {
  const read = readPrivateJson<DefaultDeployment>(defaultDeploymentPath(mycoHome));
  if (!read.ok) return null;
  const value = read.value;
  return typeof value?.serverUrl === 'string' && value.serverUrl.length > 0 && value.version === DEFAULT_DEPLOYMENT_VERSION ? value : null;
}

/** Record `serverUrl` as the default: always when `replace`, and without it only where no default is recorded. Whether it is the default now. */
export function recordDefaultDeployment(serverUrl: string, opts: { mycoHome?: string; now?: number; replace?: boolean } = {}): boolean {
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
  const held = readDefaultDeployment(mycoHome);
  if (held !== null && opts.replace !== true) return deploymentUrl(held.serverUrl) === deploymentUrl(serverUrl);
  ensureMemberDir(memberRoot(mycoHome), mycoHome);
  const record: DefaultDeployment = { version: DEFAULT_DEPLOYMENT_VERSION, serverUrl: deploymentUrl(serverUrl), setAt: opts.now ?? Date.now() };
  writePrivateFileAtomic(defaultDeploymentPath(mycoHome), `${JSON.stringify(record, null, 2)}\n`);
  return true;
}

/** The membership a repository with no connection of its own joins through: the default's, when this home still holds it. */
export function defaultMembership(mycoHome: string = resolveMycoHome()): DeploymentMembership | null {
  const held = readDefaultDeployment(mycoHome);
  return held === null ? null : readDeploymentMembership(held.serverUrl, mycoHome);
}
