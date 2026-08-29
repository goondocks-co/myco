import { openBrowser } from './open-browser.js';
import { resolveGlobalDaemonPort } from '../daemon/service-state.js';
import { probeMycoDaemon } from '../daemon/eviction.js';
import { resolveMemberProjectRoot } from '../member/credential.js';
import { readRegistryEntry } from '../member/registry.js';
import { resolveMycoHome } from '../paths/home.js';

export interface OpenDeps {
  cwd?: string;
  mycoHome?: string;
  openBrowser?: (url: string) => void;
}

/** The dashboard URL for the current root's Deployment, or null when this root has no membership. */
export function deploymentDashboardUrl(deps: OpenDeps = {}): string | null {
  const entry = readRegistryEntry(resolveMemberProjectRoot(deps.cwd), deps.mycoHome ?? resolveMycoHome());
  return entry === null ? null : `${entry.serverUrl.replace(/\/+$/, '')}/`;
}

/**
 * Opens the dashboard. A root that has joined a Deployment opens that
 * Deployment's dashboard; a root without a membership opens the local daemon's
 * dashboard, which remains until the local paths retire.
 */
export async function run(_args: string[], deps: OpenDeps = {}): Promise<void> {
  const open = deps.openBrowser ?? openBrowser;
  const deployment = deploymentDashboardUrl(deps);
  if (deployment !== null) {
    open(deployment);
    console.log(`Opened ${deployment}`);
    return;
  }

  const port = resolveGlobalDaemonPort();

  if (!(await probeMycoDaemon(port))) {
    console.error(
      `No Myco daemon is answering on port ${port}. Install the platform service with: myco service install`,
    );
    process.exit(1);
  }

  const url = `http://localhost:${port}/`;
  open(url);
  console.log(`Opened ${url}`);
}
