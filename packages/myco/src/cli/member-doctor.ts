/**
 * `myco doctor` for a joined project: the member's own wiring and the
 * Deployment it reports to, never a vault, a Grove database or a daemon.
 *
 * Rows, in order: the membership the registry holds; whether the Deployment
 * answers its health route and serves this machine's credential its tools (the
 * authenticated read renews a credential whose window is open, as every member
 * read does); the credential's expiry and renewal state as the registry holds
 * it after that; the spool (undelivered events, the offline latch, refusals);
 * which harnesses capture for the member; each harness's member MCP entry; and
 * the worker login service for each Deployment this home holds.
 *
 * A `fail` row sets a non-zero exit. Nothing here repairs: each row names the
 * command that does.
 */
import path from 'node:path';
import { withoutCredentialFlag } from '../mcp/deployment-upstream.js';
import type { CredentialSource } from '../member/constants.js';
import { REJOIN_HINT } from '../member/delivery-notice.js';
import { projectDiagnostics } from '../member/diagnostics.js';
import { readRegistryEntryResult } from '../member/registry.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { SymbiontInstaller } from '../symbionts/installer.js';
import { checkMemberMcpResolution, checkWorkerServices, formatCheck, type DoctorCheck } from './doctor-member.js';
import { envOf, homeOf, membershipProblem, openDeployment, rootOf, type MemberVerbDeps } from './deployment-reader.js';
import type { WorkerServiceDeps } from './worker-service.js';

export interface MemberDoctorDeps extends MemberVerbDeps {
  /** The worker service probe's own dependencies (service runner, platform). */
  worker?: WorkerServiceDeps;
  /** The directory the symbiont templates are read from. */
  packageRoot?: string;
}

const USAGE = 'Usage: myco doctor [--fix]';

const iso = (ms: number | null | undefined): string => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown');

const row = (name: string, status: DoctorCheck['status'], detail: string): DoctorCheck => ({ name, status, detail, fixable: false });

/** Which harnesses capture for the member, at which scope; a harness with 1.4 capture only is named for provisioning. */
function captureChecks(root: string, mycoHome: string, packageRoot: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  let capturing = 0;
  for (const manifest of loadManifests()) {
    if (!manifest.registration?.hooksTarget && !manifest.registration?.memberHooksTarget) continue;
    const at = (scope: 'member-global' | 'member-project') => new SymbiontInstaller(manifest, root, packageRoot, false, undefined, null, scope, mycoHome);
    const seen = [at('member-global').inspectMemberHooks(), at('member-project').inspectMemberHooks()];
    for (const hooks of seen) {
      if (!hooks.readable) {
        checks.push(row('Capture', 'warn', `${manifest.displayName}'s ${hooks.scope} hooks (${hooks.target}) could not be read, so whether it captures is unknown.`));
      } else if (hooks.member) {
        capturing += 1;
        checks.push(row('Capture', 'ok', `${manifest.displayName} captures for the member from its ${hooks.scope} hooks (${hooks.target}).`));
      } else if (hooks.present) {
        checks.push(row('Capture', 'warn', `${manifest.displayName}'s ${hooks.scope} hooks (${hooks.target}) are Myco's 1.4 capture, not the member's. Run \`myco member provision ${manifest.name}\`.`));
      }
    }
  }
  if (capturing === 0) {
    checks.push(row('Capture', 'fail', 'no harness on this machine captures for the member. Run `myco member provision <agent>` from this project.'));
  }
  return checks;
}

/** Run the member checks for this joined project and print them. True when no row failed. */
export async function run(args: readonly string[], source: CredentialSource, deps: MemberDoctorDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const flags = withoutCredentialFlag(args);
  const unknown = flags.filter((flag) => flag !== '--fix');
  if (unknown.length > 0) { err(`${USAGE}\nmyco doctor: unknown option ${unknown[0]}`); return false; }

  const root = rootOf(deps);
  const mycoHome = homeOf(deps);
  const now = (deps.now ?? Date.now)();
  const checks: DoctorCheck[] = [];

  const read = source === 'registry' ? readRegistryEntryResult(root, mycoHome) : null;
  const problem = source === 'registry' ? membershipProblem(deps) : null;
  if (problem !== null) checks.push(row('Membership', 'fail', problem));

  const deployment = problem === null ? await openDeployment(source, deps) : null;
  if (deployment === null && problem === null) {
    checks.push(row('Deployment', 'fail', `no member credential resolves for this project (--credential ${source}).`));
  } else if (deployment !== null) {
    if (read?.status === 'present') {
      checks.push(row('Membership', 'ok', `project ${deployment.projectId} on ${deployment.serverUrl} (machine ${read.entry.machineId}, joined ${iso(read.entry.joinedAt)}).`));
    }
    if (!(await deployment.healthy())) {
      checks.push(row('Deployment', 'fail', `${deployment.serverUrl} did not answer its health route from this machine.`));
    } else {
      const tools = await deployment.listTools();
      checks.push(tools.ok
        ? row('Deployment', 'ok', `${deployment.serverUrl} answers, and serves this machine's credential ${tools.value.length} tools.`)
        : row('Deployment', 'fail', `${deployment.serverUrl} answers its health route and refused this machine's tool list (${tools.error.code}): ${tools.error.message}`));
    }
  }

  // Read after the Deployment was asked: its read renews a credential whose window is open.
  const after = source === 'registry' ? readRegistryEntryResult(root, mycoHome) : null;
  if (after?.status === 'present') {
    const facts = projectDiagnostics(after.entry, mycoHome, now);
    const { membership, spool, latch, refusals } = facts;
    if (membership.refreshTerminal === true) {
      checks.push(row('Credential', 'fail', `the Deployment will not renew this credential — ${REJOIN_HINT}.`));
    } else if (membership.expired === true) {
      checks.push(row('Credential', 'warn', `expired at ${iso(membership.expiresAt)}; the next hook or member read renews it while its lineage is live.`));
    } else {
      checks.push(row('Credential', 'ok', `expires ${iso(membership.expiresAt)}; ${membership.refreshAfter === null ? 'the renewal window is not announced yet' : `renews after ${iso(membership.refreshAfter)}`}.`));
    }

    if (!spool.readable || spool.unacknowledgedTotal === null) {
      checks.push(row('Spool', 'warn', 'the spool could not be read, so what is waiting to deliver is unknown.'));
    } else if (spool.unacknowledgedTotal > 0) {
      checks.push(row('Spool', 'warn', `${spool.unacknowledgedTotal} event(s) in ${spool.sessionFiles} session file(s) are waiting to deliver; the next hook drains them, or run \`myco member drain\`.`));
    } else {
      checks.push(row('Spool', 'ok', `nothing waiting to deliver (last acknowledged ${spool.lastAckAt === null ? 'never' : iso(spool.lastAckAt)}).`));
    }
    if (!facts.latchReadable) checks.push(row('Spool', 'warn', 'the offline latch could not be read, so whether capture is holding off is unknown.'));
    else if (latch !== null) checks.push(row('Spool', 'warn', `capture has held off the Deployment since ${iso(latch.since)}; next probe ${iso(latch.nextProbeAt)}.`));
    if (!refusals.logReadable) checks.push(row('Refusals', 'warn', 'the refusal log could not be read.'));
    else if (refusals.loggedSinceLastReset > 0) {
      checks.push(row('Refusals', 'warn', `the Deployment refused ${refusals.loggedSinceLastReset} event(s); \`myco logs\` lists them.`));
    }
  }

  const packageRoot = deps.packageRoot ?? resolvePackageRoot();
  checks.push(...captureChecks(root, mycoHome, packageRoot));
  const vaultDir = path.join(root, '.myco');
  checks.push(...await checkMemberMcpResolution(vaultDir, { ...envOf(deps), MYCO_HOME: mycoHome }, { registryRead: 'strict' }));
  checks.push(...await checkWorkerServices(vaultDir, { ...deps.worker, mycoHome }));

  out('\nmyco doctor (member)\n');
  for (const check of checks) out(formatCheck(check));
  const failed = checks.filter((check) => check.status === 'fail');
  const warned = checks.filter((check) => check.status === 'warn');
  out('');
  out(failed.length + warned.length === 0 ? '  All checks passed.' : `  ${failed.length} failed, ${warned.length} warning(s).`);
  if (flags.includes('--fix') && failed.length + warned.length > 0) out('  Nothing here repairs automatically; each row names the command that does.');
  out('');
  return failed.length === 0;
}
