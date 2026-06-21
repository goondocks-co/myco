import path from 'node:path';
import {
  createGrove,
  deleteGrove,
  findRegisteredProject,
  forceResumeProject,
  getDefaultGroveId,
  listGroves,
  listRegisteredProjects,
  renameGrove,
  resolveGrove,
  setDefaultGrove,
  type ResolvedRegisteredProject,
} from '@myco/grove/registry.js';
import { moveProjectBetweenGroves } from '@myco/grove/move.js';
import { projectUrlSlug } from '@myco/grove/ids.js';
import {
  resolveMycoHome,
  resolveProjectVaultDir,
} from '@myco/grove/paths.js';
import {
  activateProjectMigration,
  completeLegacyArchive,
  summarizeImportedRowCount,
} from '@myco/grove/activation.js';
import { resolveProjectDashboardUrl } from './dashboard-url.js';
import { parseStringFlag } from './shared.js';

const PROJECT_ID_RE = /^proj_[0-9a-f]{32}$/i;

/**
 * Locate a registered project from a CLI reference. Accepts:
 *   - a project id (`proj_<32hex>`) — looked up directly via the registry,
 *   - a project URL slug (`<name>-<id-suffix>`) — matched across Groves,
 *   - a plain project name — matched across Groves.
 */
export function findProjectByRef(
  projectRef: string,
  mycoHome = resolveMycoHome(),
): ResolvedRegisteredProject | null {
  if (PROJECT_ID_RE.test(projectRef)) {
    return findRegisteredProject({ projectId: projectRef }, mycoHome);
  }
  const groves = listGroves(mycoHome);
  let nameMatch: ResolvedRegisteredProject | null = null;
  for (const grove of groves) {
    const projects = listRegisteredProjects(grove.id, mycoHome);
    for (const project of projects) {
      if (projectUrlSlug(project.name, project.project_id) === projectRef) {
        return { grove, project };
      }
      if (project.name === projectRef && !nameMatch) {
        nameMatch = { grove, project };
      }
    }
  }
  return nameMatch;
}

const USAGE = `Usage: myco grove <command>

Commands:
  list                                       List local Groves
  create <name>                              Create a local Grove
  use <name|id>                              Set the default Grove for future init/update
  rename <name|id> <new-name>                Rename a Grove
  delete <name|id> [--force]                 Delete a Grove (use --force to drop a non-empty Grove)
  move <project-id-or-slug> --grove <ref>    Move a registered project into another Grove
  migrate-project [--grove <name|id>]        Import and activate an existing project vault
  archive-legacy [--project <path>]          Move post-activation legacy data into .myco/.archive-<ts>/

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
      console.log(
        `${marker} ${grove.name} (${grove.slug}) ${grove.id} ${grove.mode} ${grove.served_by}`,
      );
    }
    return;
  }

  if (cmd === 'create') {
    const name = rest.join(' ').trim();
    if (!name) throw new Error('Grove name is required');
    const grove = createGrove(name, mycoHome, { servedBy: 'service' });
    console.log(`Created Grove ${grove.name} (${grove.id}) — served_by ${grove.served_by}`);
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
    console.log(`Imported: ${summarizeImportedRowCount(result.import_result)} rows`);
    if (result.dry_run) {
      console.log('No project binding files were written.');
    } else {
      console.log(`Marker:   ${result.marker_path}`);
      const dashboardUrl = resolveProjectDashboardUrl({
        vaultDir: result.project_vault_dir,
        groveSlug: result.grove.slug,
        groveId: result.grove.id,
        projectId: result.project_id,
        projectName: result.project_name,
      });
      if (dashboardUrl) {
        console.log(`Dashboard: ${dashboardUrl}`);
      }
    }
    return;
  }

  if (cmd === 'rename') {
    const ref = rest[0];
    const newName = rest.slice(1).join(' ').trim();
    if (!ref) throw new Error('Grove name or id is required');
    if (!newName) throw new Error('New Grove name is required');
    const grove = resolveGrove(ref, mycoHome);
    const updated = renameGrove(grove.id, newName, mycoHome);
    console.log(`Renamed: ${updated.name} (${updated.slug})`);
    return;
  }

  if (cmd === 'delete') {
    const ref = rest[0];
    if (!ref) throw new Error('Grove name or id is required');
    const force = rest.includes('--force');
    const grove = resolveGrove(ref, mycoHome);
    try {
      deleteGrove(grove.id, { force }, mycoHome);
      console.log(`Deleted Grove ${grove.name} (${grove.slug})`);
    } catch (err) {
      const message = (err as Error).message;
      console.error(message);
      if (/bound project/.test(message)) {
        console.error('Use --force to delete a Grove with bound projects.');
      }
      process.exit(1);
    }
    return;
  }

  if (cmd === 'move') {
    const projectRef = rest[0];
    const groveRef = parseStringFlag(rest, '--grove');
    if (!projectRef) throw new Error('Project id or slug is required');
    if (!groveRef) throw new Error('--grove <name|id> is required');

    const found = findProjectByRef(projectRef, mycoHome);
    if (!found) throw new Error(`Project not found: ${projectRef}`);

    const targetGrove = resolveGrove(groveRef, mycoHome);
    if (found.grove.id === targetGrove.id) {
      console.error(`Project is already in Grove ${targetGrove.name}`);
      process.exit(1);
    }

    console.log(`Moving project ${found.project.name} (${found.project.project_id})`);
    console.log(`  from: ${found.grove.name} (${found.grove.slug})`);
    console.log(`  to:   ${targetGrove.name} (${targetGrove.slug})`);
    const result = moveProjectBetweenGroves(
      found.grove.id,
      targetGrove.id,
      found.project.project_id,
      mycoHome,
    );
    console.log(`Move complete. Snapshot: ${result.snapshot_path}`);
    return;
  }

  if (cmd === 'force-resume-project') {
    const projectRef = rest[0];
    if (!projectRef) throw new Error('Project id or slug is required');
    if (!rest.includes('--force')) {
      throw new Error('force-resume-project is a recovery command. Pass --force to confirm.');
    }
    const found = findProjectByRef(projectRef, mycoHome);
    if (!found) throw new Error(`Project not found: ${projectRef}`);
    forceResumeProject(found.grove.id, found.project.project_id, mycoHome);
    console.log(
      `Force-resumed project ${found.project.name} in Grove ${found.grove.name} (${found.grove.slug})`,
    );
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
