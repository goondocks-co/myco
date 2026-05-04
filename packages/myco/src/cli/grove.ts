import {
  createGrove,
  getDefaultGroveId,
  listGroves,
  setDefaultGrove,
} from '@myco/grove/registry.js';
import { resolveMycoHome } from '@myco/grove/paths.js';

const USAGE = `Usage: myco grove <command>

Commands:
  list                 List local Groves
  create <name>        Create a local Grove
  use <name|id>        Set the default Grove for future init/update
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

  throw new Error(`Unknown grove command: ${cmd}`);
}
