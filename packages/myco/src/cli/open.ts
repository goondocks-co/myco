import { openBrowser } from './open-browser.js';
import { resolveMemberProjectRoot } from '../member/credential.js';
import { defaultMembership } from '../member/default-deployment.js';
import { JOIN_A_DEPLOYMENT } from '../member/join-guidance.js';
import { readRegistryEntry } from '../member/registry.js';
import { resolveMycoHome } from '../paths/home.js';

export interface OpenDeps {
  cwd?: string;
  mycoHome?: string;
  openBrowser?: (url: string) => void;
  stderr?: (line: string) => void;
}

/**
 * The dashboard URL to open: the Deployment the current root has joined, else this machine's default Deployment, or
 * null when this machine holds neither.
 */
export function deploymentDashboardUrl(deps: OpenDeps = {}): string | null {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const entry = readRegistryEntry(resolveMemberProjectRoot(deps.cwd), mycoHome);
  const serverUrl = entry?.serverUrl ?? defaultMembership(mycoHome)?.serverUrl;
  return serverUrl === undefined ? null : `${serverUrl.replace(/\/+$/, '')}/`;
}

/** Opens the Deployment's dashboard, and whether it did. With no Deployment to open, prints how to join one and opens nothing. */
export async function run(_args: string[], deps: OpenDeps = {}): Promise<boolean> {
  const url = deploymentDashboardUrl(deps);
  if (url === null) {
    (deps.stderr ?? ((line: string) => console.error(line)))(`This machine has not joined a Deployment, so there is no dashboard to open. ${JOIN_A_DEPLOYMENT}`);
    return false;
  }
  (deps.openBrowser ?? openBrowser)(url);
  console.log(`Opened ${url}`);
  return true;
}
