/**
 * `myco attach <project>` / `myco detach <project>` CLI surface (Task A1;
 * consolidation Task D-2: fallback posture).
 *
 * Thin argv parsing + human-readable output over the daemon API
 * (`POST /api/host-membership/attach|detach`, `daemon/api/host-membership.ts`),
 * which itself wraps {@link attachCommand}/{@link detachCommand}
 * (`host/attach-command.ts`). Chris's PR #667 review direction: membership
 * "should frankly be only the UI and API, with the CLI being a secondary
 * fallback" — this file used to call the orchestration functions in-process;
 * it now drives the SAME daemon route the Team page's attach control posts
 * to. Sibling to `cli/join.ts`: same flag parser (shared via
 * `cli/shared.ts#parseFlags`), same print-only responsibility.
 */
import path from 'node:path';
import { connectToGlobalDaemon, daemonErrorMessage, parseFlags } from './shared.js';

const ATTACH_TIMEOUT_MS = 10_000;
const DETACH_TIMEOUT_MS = 10_000;

interface AttachResponseBody {
  project_id: string;
  grove_id: string;
  host_id: string;
  host_label: string;
  root: string;
  already_attached: boolean;
  notes: string[];
}

interface DetachResponseBody {
  project_id: string;
  detached_from_host_id: string | null;
}

export async function runAttach(args: string[], vaultDir: string): Promise<void> {
  const { positionals, flags } = parseFlags(args);
  const projectRoot = path.resolve(positionals[0] ?? '.');

  const client = await connectToGlobalDaemon(vaultDir);
  const result = await client.post('/api/host-membership/attach', {
    project_root: projectRoot,
    host_id: flags.get('host'),
    grove_id: flags.get('grove'),
    project_id: flags.get('project-id'),
  }, { timeoutMs: ATTACH_TIMEOUT_MS });

  if (!result.ok) {
    console.error(`attach failed: ${daemonErrorMessage(result.data) ?? 'the daemon did not respond'}`);
    process.exit(1);
  }

  const body = result.data as AttachResponseBody;
  if (body.already_attached) {
    console.log(`Project ${body.project_id} is already attached to host ${body.host_id} (${body.host_label}) — converged.`);
  } else {
    console.log(`Attached ${body.project_id} to Team Host ${body.host_id} (${body.host_label}).`);
  }
  console.log(`  Grove:    ${body.grove_id}`);
  console.log(`  Checkout: ${body.root}`);
  for (const note of body.notes) console.log(`  NOTE: ${note}`);
}

export async function runDetach(args: string[], vaultDir: string): Promise<void> {
  const { positionals, flags } = parseFlags(args);
  const projectRoot = path.resolve(positionals[0] ?? '.');

  const client = await connectToGlobalDaemon(vaultDir);
  const result = await client.post('/api/host-membership/detach', {
    project_root: projectRoot,
    project_id: flags.get('project-id'),
  }, { timeoutMs: DETACH_TIMEOUT_MS });

  if (!result.ok) {
    console.error(`detach failed: ${daemonErrorMessage(result.data) ?? 'the daemon did not respond'}`);
    process.exit(1);
  }

  const body = result.data as DetachResponseBody;
  if (!body.detached_from_host_id) {
    console.log(`Project ${body.project_id} is not attached to any host — nothing to detach.`);
    return;
  }
  console.log(`Detached ${body.project_id} from Team Host ${body.detached_from_host_id}.`);
  console.log('  Future requests for this project resolve to a local Grove again.');
}
