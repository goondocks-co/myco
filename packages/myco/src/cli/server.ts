/**
 * `myco server <create|status|destroy>` — argv and human output over
 * `../server/deployment.js`.
 *
 * The orchestration lives there so `myco setup` provisions through the same
 * code path rather than a second one that drifts.
 */
import {
  createDeployment,
  deploymentStatus,
  destroyDeployment,
  removeBundle,
  resolveDeploymentPaths,
  bundleContents,
} from '../server/deployment.js';
import { CommandFailed } from '../server/runner.js';
import { parseFlags } from './shared.js';

export const SERVER_HELP = `Usage: myco server <command>

Commands:
  create [--port <n>] [--version <tag>]   Provision and start the Deployment.
  status                                  Report what is provisioned and running.
  destroy [--data] [--yes]                Stop and remove the stack. --data also removes the volume.

The bundle is ordinary Compose. Everything here is also runnable with
\`docker compose\` from the deployment directory.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export async function run(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(SERVER_HELP);
    process.exit(command === undefined ? 2 : 0);
  }

  const { flags } = parseFlags(rest);

  try {
    if (command === 'create') {
      const portFlag = flags.get('port');
      const port = portFlag === undefined ? undefined : Number(portFlag);
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
        fail(`--port must be a port number, and is ${JSON.stringify(portFlag)}`);
      }
      const created = await createDeployment({ port, version: flags.get('version') });
      console.log('\nDeployment started.');
      console.log(`  Directory:  ${created.root}`);
      console.log(`  Address:    http://127.0.0.1:${created.port}`);
      console.log('\nThe published port is loopback-only. Remote access is a reverse proxy in front of it.');
      return;
    }

    if (command === 'status') {
      const status = await deploymentStatus();
      if (!status.provisioned) {
        console.log('No Deployment provisioned. `myco server create` provisions one.');
        return;
      }
      const paths = resolveDeploymentPaths();
      console.log('\nDeployment');
      console.log(`  Directory:  ${paths.root}`);
      console.log(`  Bundle:     ${bundleContents(paths).join(', ')}`);
      console.log(`  Running:    ${status.running ? status.services.join(', ') : 'no'}`);
      return;
    }

    if (command === 'destroy') {
      const removeData = flags.has('data');
      if (removeData && !flags.has('yes')) {
        fail('--data removes the Deployment volume and everything in it. Re-run with --yes to confirm.');
      }
      await destroyDeployment({ removeData });
      if (removeData) removeBundle(resolveDeploymentPaths());
      console.log(removeData ? 'Deployment and its data removed.' : 'Deployment stopped. Its data is kept.');
      return;
    }

    console.error(`Unknown command: ${command}\n`);
    console.log(SERVER_HELP);
    process.exit(2);
  } catch (err) {
    // A Compose failure is the operator's to read, verbatim.
    if (err instanceof CommandFailed) fail(err.message);
    fail(err instanceof Error ? err.message : String(err));
  }
}
