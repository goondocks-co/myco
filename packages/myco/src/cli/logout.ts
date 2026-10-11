import path from 'node:path';
import { logoutDeployment, type LogoutRuntimeDeps } from '../symbionts/logout-runtime.js';
import { memberHomeFor, pinnedHomeLine } from '../member/home-for-folder.js';

export const LOGOUT_HELP = `Usage: myco logout <server-url> [--local-only]

Revokes this machine's member credential for one Deployment, removes its local
connections, and reconciles its agent configuration. Captured data is kept.
Other Deployments and runner registrations remain in place.

  --local-only   Remove local state even if the Deployment is unreachable.
                 Its credential may still be valid on the Deployment.
`;

export interface LogoutCliDeps extends LogoutRuntimeDeps {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Present the owning capability's result; the dispatcher owns the exit status. */
export async function run(args: readonly string[], deps: LogoutCliDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const addresses = args.filter((arg) => !arg.startsWith('-'));
  if (addresses.length !== 1 || args.some((arg) => arg.startsWith('-') && arg !== '--local-only')) {
    err(LOGOUT_HELP.trimEnd());
    return false;
  }
  const folder = path.resolve(deps.cwd ?? process.cwd());
  const chosen = deps.mycoHome === undefined ? memberHomeFor(folder) : null;
  const mycoHome = deps.mycoHome ?? chosen!.home;
  try {
    const report = await logoutDeployment(addresses[0], { mode: args.includes('--local-only') ? 'local-only' : 'revoke' }, { ...deps, mycoHome });
    const pinned = chosen === null ? null : pinnedHomeLine(chosen, folder);
    if (pinned !== null) out(pinned);
    out(`Signed out of ${report.serverUrl}.`);
    if (!report.revoked) out(`Credential still valid on the Deployment; stop it on the dashboard: People & machines › ${report.machineId} › Stop.`);
    out(`${report.keptSpool.sessions} undelivered sessions kept at ${report.keptSpool.paths.join(', ')}; \`myco member drain\` after signing in again.`);
    out(`${report.leftRoots.length} repositories won't be captured until you connect them again:`);
    for (const root of report.leftRoots) out(`  ${root}`);
    if (report.leftRoots.length > 0) out('Reconnect these repositories explicitly with `myco member join`.');
    if (report.defaultUrl !== null) out(`New repositories join ${report.defaultUrl}.`);
    else if (report.survivors.length > 1) out('Choose the Deployment new repositories join with `myco login --default <url>`.');
    if (report.runner) out(`This machine is also a runner for ${report.serverUrl}; remove it on the Runners page or \`myco runner uninstall --server ${report.serverUrl}\`.`);
    return true;
  } catch (error) {
    err(`myco logout: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
