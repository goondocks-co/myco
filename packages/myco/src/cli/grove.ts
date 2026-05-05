import {
  createGrove,
  getDefaultGroveId,
  listGroves,
  setDefaultGrove,
} from '@myco/grove/registry.js';
import { resolveMycoHome } from '@myco/grove/paths.js';
import { activateProjectMigration } from '@myco/grove/activation.js';
import { parseStringFlag } from './shared.js';

const USAGE = `Usage: myco grove <command>

Commands:
  list                                  List local Groves
  create <name>                         Create a local Grove
  use <name|id>                         Set the default Grove for future init/update
  migrate-project [--grove <name|id>]   Import and activate an existing project vault

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
