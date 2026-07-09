/**
 * `myco attach <project>` / `myco detach <project>` CLI surface (Task A1).
 *
 * Thin argv parsing + human-readable output over the {@link attachCommand} /
 * {@link detachCommand} residency-mapping orchestration. Sibling to
 * `cli/join.ts`: same flag parser, same print-only responsibility — the real
 * work (identity resolution, error mapping, the registry write) lives in
 * `host/attach-command.ts`.
 */
import { attachCommand, detachCommand } from '../host/attach-command.js';

/** Parse `--flag value` / `--flag=value` / bare `--flag` into a map. Mirrors
 *  `cli/join.ts` exactly so the two member commands parse identically. */
function parseFlags(args: string[]): { positionals: string[]; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq > 2) { flags.set(arg.slice(2, eq), arg.slice(eq + 1)); continue; }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags.set(arg.slice(2), next); i += 1; }
    else flags.set(arg.slice(2), 'true');
  }
  return { positionals, flags };
}

export async function runAttach(args: string[]): Promise<void> {
  const { positionals, flags } = parseFlags(args);
  const result = attachCommand({
    projectPath: positionals[0],
    hostId: flags.get('host'),
    groveId: flags.get('grove'),
    projectId: flags.get('project-id'),
  });

  if (result.alreadyAttached) {
    console.log(`Project ${result.projectId} is already attached to host ${result.hostId} (${result.hostLabel}) — converged.`);
  } else {
    console.log(`Attached ${result.projectId} to Team Host ${result.hostId} (${result.hostLabel}).`);
  }
  console.log(`  Grove:    ${result.groveId}`);
  console.log(`  Checkout: ${result.root}`);
  for (const note of result.notes) console.log(`  NOTE: ${note}`);
}

export async function runDetach(args: string[]): Promise<void> {
  const { positionals, flags } = parseFlags(args);
  const result = detachCommand({
    projectPath: positionals[0],
    projectId: flags.get('project-id'),
  });

  if (!result.detachedFromHostId) {
    console.log(`Project ${result.projectId} is not attached to any host — nothing to detach.`);
    return;
  }
  console.log(`Detached ${result.projectId} from Team Host ${result.detachedFromHostId}.`);
  console.log('  Future requests for this project resolve to a local Grove again.');
}
