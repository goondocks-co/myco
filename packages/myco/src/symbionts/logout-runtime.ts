import { resolveHomeDir, resolveMycoHome } from '../paths/home.js';
import { readRunnerRecord } from '../runner/runner-registry.js';
import { listWorkerUnits, uninstallWorkerService } from '../runner/service.js';
import { executionDeploymentUrls, executorServiceTarget, type WorkerServiceDeps } from '../cli/worker-service.js';
import {
  logoutDeployment as logoutMemberDeployment,
  type LogoutDeps, type LogoutReport, type LogoutRuntime,
} from '../member/logout.js';
import { loadManifests, resolvePackageRoot } from './detect.js';
import { MemberFileReconciliation, SymbiontInstaller } from './installer.js';
import { readProvisionRecord, reconcileProvisionDeployment } from './member-provision-record.js';

export interface LogoutRuntimeDeps extends Omit<LogoutDeps, 'runtime'> {
  packageRoot?: string;
  worker?: WorkerServiceDeps;
}

/** Supply service and agent configuration operations to the member logout capability. */
export function logoutDeployment(
  input: string,
  opts: { mode: 'revoke' | 'local-only' },
  deps: LogoutRuntimeDeps = {},
): Promise<LogoutReport> {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const home = deps.home ?? resolveHomeDir();
  const worker = { ...deps.worker, mycoHome, home };
  const runtime: LogoutRuntime = {
    aliases: (serverUrl) => executionDeploymentUrls(serverUrl, worker),
    snapshot: (aliases) => {
      const provision = readProvisionRecord(mycoHome);
      const units = listWorkerUnits(home, worker.platform);
      return {
        agents: provision?.agents ?? [],
        workerUrls: units.filter((unit) => unit.mycoHome === mycoHome
          && unit.serverUrl !== null && aliases.includes(unit.serverUrl)).map((unit) => unit.serverUrl!),
        runner: aliases.some((url) => readRunnerRecord(url, mycoHome) !== null),
      };
    },
    removeWorkers: (urls) => {
      for (const url of urls) {
        const units = listWorkerUnits(home, worker.platform);
        if (units.some((unit) => unit.mycoHome === mycoHome && unit.serverUrl === url)) {
          uninstallWorkerService(executorServiceTarget(url, worker), { runner: worker.runner });
        }
      }
    },
    reconcile: (serverUrl, nextDefault, keepHooks) => {
      const packageRoot = deps.packageRoot ?? resolvePackageRoot();
      const reconciliation = new MemberFileReconciliation();
      const { problems } = reconciliation;
      for (const manifest of loadManifests()) {
        const installer = new SymbiontInstaller(manifest, mycoHome, packageRoot, false, mycoHome).withoutProjectRoot();
        reconciliation.attempt(manifest, () => installer.reconcileDeploymentLogout(serverUrl, nextDefault, keepHooks));
      }
      reconcileProvisionDeployment(mycoHome, serverUrl, nextDefault, [...problems.keys()]);
      reconciliation.throwUnexpected();
      return [...problems].map(([agent, reason]) => ({ agent, reason }));
    },
  };
  return logoutMemberDeployment(input, opts, { ...deps, mycoHome, runtime });
}
