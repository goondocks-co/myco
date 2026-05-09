import path from 'node:path';
import {
  createGrove,
  getDefaultGroveId,
  listGroves,
  listRegisteredProjects,
  setDefaultGrove,
} from '@myco/grove/registry.js';
import { resolveMycoHome, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { projectUrlSlug } from '@myco/grove/ids.js';
import { activateProjectMigration, completeLegacyArchive } from '@myco/grove/activation.js';
import {
  readDaemonState,
  resolveDaemonServiceState,
} from '@myco/daemon/service-state.js';
import { parseStringFlag } from './shared.js';

const USAGE = `Usage: myco grove <command>

Commands:
  list                                  List local Groves
  create <name>                         Create a local Grove
  use <name|id>                         Set the default Grove for future init/update
  migrate-project [--grove <name|id>]   Import and activate an existing project vault
  archive-legacy [--project <path>]     Move post-activation legacy data into .myco/.archive-<ts>/

Migration options:
  --project <path>                      Project root to migrate (default: cwd)
  --grove <name|id>                     Target Grove (default: machine default Grove)
  --dry-run                             Validate import without writing project binding files
  --json                                Print machine-readable result
`;

export async function run(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  const mycoHome = resolveMycoHome();

  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === 'list') {
    const groves = listGroves(mycoHome);
    const defaultId = getDefaultGroveId(mycoHome);
    if (groves.length === 0) {
      console.log('No Groves found.');
      return;
    }
    for (const grove of groves) {
      const marker = grove.id === defaultId ? '*' : ' ';
      console.log(`${marker} ${grove.name} (${grove.slug}) ${grove.id} ${grove.mode}`);
    }
    return;
  }

  if (cmd === 'create') {
    const name = rest.join(' ').trim();
    const grove = createGrove(name, mycoHome);
    console.log(`Created Grove ${grove.name} (${grove.id})`);
    return;
  }

  if (cmd === 'use') {
    const ref = rest[0];
    if (!ref) throw new Error('Grove name or id is required');
    const grove = setDefaultGrove(ref, mycoHome);
    console.log(`Default Grove: ${grove.name} (${grove.id})`);
    return;
  }

  if (cmd === 'migrate-project' || cmd === 'activate-project') {
    const groveRef = parseStringFlag(rest, '--grove');
    const projectRoot = parseStringFlag(rest, '--project') ?? process.cwd();
    const dryRun = rest.includes('--dry-run');
    const json = rest.includes('--json');
    const result = activateProjectMigration({
      projectRoot,
      groveRef,
      dryRun,
      mycoHome,
    });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.already_activated) {
      console.log(`Project already activated in Grove ${result.grove.name} (${result.grove.slug})`);
      return;
    }

    const mode = result.dry_run ? 'Dry-run validated' : 'Activated';
    console.log(`${mode} project ${result.project_name}`);
    console.log(`Project:  ${result.project_id}`);
    console.log(`Grove:    ${result.grove.name} (${result.grove.slug})`);
    console.log(`Imported: ${summarizeImportedRows(result.import_result)}`);
    if (result.dry_run) {
      console.log('No project binding files were written.');
    } else {
      console.log(`Marker:   ${result.marker_path}`);
      const dashboardUrl = resolveDashboardUrl(
        result.project_vault_dir,
        result.grove.slug,
        result.project_id,
        result.project_name,
        result.grove.id,
      );
      if (dashboardUrl) {
        console.log(`Dashboard: ${dashboardUrl}`);
      }
    }
    return;
  }

  if (cmd === 'archive-legacy') {
    const projectRoot = path.resolve(parseStringFlag(rest, '--project') ?? process.cwd());
    const vaultDir = resolveProjectVaultDir(projectRoot);
    const result = completeLegacyArchive(vaultDir);
    if (rest.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (!result.archived_dir && result.already_complete) {
      console.log('Legacy archive already complete; nothing to move.');
    } else if (!result.archived_dir) {
      console.log('No Grove activation marker found — run `myco grove migrate-project` first.');
    } else {
      console.log(`Archived legacy vault data to ${result.archived_dir}`);
    }
    return;
  }

  throw new Error(`Unknown grove command: ${cmd}`);
}

function summarizeImportedRows(result: ReturnType<typeof activateProjectMigration>['import_result']): string {
  if (!result) return '0 rows';
  const total = Object.entries(result)
    .filter(([key]) => !key.startsWith('skipped_'))
    .reduce((sum, [, value]) => sum + Number(value), 0);
  return `${total} rows`;
}

/**
 * Build the dashboard URL pointing at the freshly-activated project,
 * for the daemon currently bound on the local host. Returns null when
 * the daemon isn't reachable yet — printing nothing in that case is
 * less misleading than printing a URL that 404s.
 */
function resolveDashboardUrl(
  vaultDir: string,
  groveSlug: string,
  projectId: string,
  projectName: string,
  groveId: string,
): string | null {
  const port = readDaemonState(resolveDaemonServiceState(vaultDir, { env: process.env }).statePath)?.port;
  if (typeof port !== 'number') return null;
  const projects = listRegisteredProjects(groveId);
  const registered = projects.find((p) => p.project_id === projectId);
  const slug = projectUrlSlug(registered?.name ?? projectName, projectId);
  return `http://localhost:${port}/g/${groveSlug}/p/${slug}`;
}
