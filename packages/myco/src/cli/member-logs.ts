/**
 * `myco logs` for a joined project: the member's own logs on this machine.
 *
 * The worker login service for this project's Deployment writes its output and
 * its errors under `<MYCO_HOME>/logs/` (`runner/service.ts`); the spool keeps a
 * log of the events the Deployment refused. Both are shown here, the newest
 * lines last. The 1.4 daemon log is not a member's, and the Deployment's own
 * logs are the dashboard's.
 */
import fs from 'node:fs';
import { withoutCredentialFlag } from '../mcp/deployment-upstream.js';
import type { CredentialSource } from '../member/constants.js';
import { projectDiagnostics } from '../member/diagnostics.js';
import { deploymentUrl, readRegistryEntryResult } from '../member/registry.js';
import { homeOf, rootOf, type MemberVerbDeps } from './deployment-reader.js';
import { describeWorkerService, type WorkerServiceDeps } from './worker-service.js';

/** Lines of each log shown when `--tail` is not given. */
export const DEFAULT_MEMBER_LOG_TAIL = 50;

const USAGE = 'Usage: myco logs [--tail|-n <lines>]';

export interface MemberLogsDeps extends MemberVerbDeps {
  worker?: WorkerServiceDeps;
}

const iso = (ms: number | null): string => (ms === null ? 'unknown time' : new Date(ms).toISOString());

/** The last `n` lines of a file, or null when it does not exist. */
function tail(file: string, n: number): string[] | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n);
}

function parseTail(flags: readonly string[]): number | null | 'invalid' {
  if (flags.length === 0) return null;
  if (flags.length !== 2 || (flags[0] !== '--tail' && flags[0] !== '-n')) return 'invalid';
  const n = Number(flags[1]);
  return Number.isInteger(n) && n > 0 ? n : 'invalid';
}

/** Print the member's logs for this joined project. True when they were read. */
export async function run(args: readonly string[], source: CredentialSource, deps: MemberLogsDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const parsed = parseTail(withoutCredentialFlag(args));
  if (parsed === 'invalid') { err(USAGE); return false; }
  const lines = parsed ?? DEFAULT_MEMBER_LOG_TAIL;
  if (source !== 'registry') {
    err('myco logs: an env-sourced credential keeps no member logs on this machine');
    return false;
  }
  const root = rootOf(deps);
  const mycoHome = homeOf(deps);
  const read = readRegistryEntryResult(root, mycoHome);
  if (read.status !== 'present') {
    err(`myco logs: the registry entry for ${root} ${read.status === 'unavailable' ? 'could not be read' : 'is absent'}`);
    return false;
  }
  const entry = read.entry;
  const url = deploymentUrl(entry.serverUrl);

  const status = describeWorkerService(url, { ...deps.worker, mycoHome });
  if (status === null) {
    out(`=== worker (${url}) ===`);
    out('  this platform has no login service for a worker, so there is no worker log');
  } else {
    for (const [label, file] of [['output', status.outLog], ['errors', status.errLog]] as const) {
      out(`=== worker ${label} (${url}): ${file} ===`);
      const shown = tail(file, lines);
      if (shown === null) out('  (no log yet)');
      else if (shown.length === 0) out('  (empty)');
      else for (const line of shown) out(line);
    }
  }

  const { refusals } = projectDiagnostics(entry, mycoHome, (deps.now ?? Date.now)());
  out(`=== refused events (${entry.projectId}) ===`);
  if (!refusals.logReadable) out('  the refusal log could not be read');
  else if (refusals.entries.length === 0) out('  (none)');
  else {
    for (const r of refusals.entries.slice(-lines)) {
      out(`${iso(r.at)} ${r.kind ?? 'unknown kind'} ${r.eventId ?? 'unknown event'} session ${r.sessionId ?? 'unknown'}: ${r.code ?? 'code not recognised'}`);
    }
    if (refusals.unreadableLines > 0) out(`  ${refusals.unreadableLines} line(s) of the log could not be read`);
  }
  return true;
}
