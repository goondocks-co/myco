/**
 * The doctor checks and output format both doctors run: the member's
 * (`cli/member-doctor.ts`) and the 1.4 one (`cli/doctor.ts`). Nothing here
 * reaches vault, Grove database or daemon code;
 * `tests/meta/member-read-boundary.test.ts` holds its import closure.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Column width for the check name in output. */
const NAME_COL_WIDTH = 17;

/** Prefix for indented continuation lines (e.g. multi-line agent output). */
const CONTINUATION_INDENT = ' '.repeat(NAME_COL_WIDTH);

// --- Types ---

/** What a check failed on, in a closed vocabulary a report carries where its detail text cannot go. */
export type DoctorReason = 'home_pin_missing' | 'mcp_entry_absent' | 'mcp_target_unreadable' | 'mcp_entry_http' | 'mcp_entry_stdio' | 'mcp_entry_unknown_transport' | 'mcp_entry_no_credential'
  | 'binary_manifest_missing' | 'binary_manifest_unreadable' | 'binary_manifest_unversioned'
  | 'binary_version_skew' | 'binary_version_current'
  | 'mcp_cwd_ambiguous' | 'mcp_cwd_elsewhere' | 'mcp_server_mismatch' | 'mcp_server_stale'
  | 'runtime_pin_refused' | 'runtime_pin_redundant' | 'runtime_pin_target_absent' | 'runtime_pin_override';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
  /** Absent where a check has only one way to fail, which its name already says. */
  reason?: DoctorReason;
  /** The symbiont a check names, where it names one. */
  symbiont?: string;
  /** The configuration scope a check read, where it read one. */
  scope?: 'global' | 'project';
  /** The project root a check is about, where its answer holds for that root alone. */
  root?: string;
  fixable: boolean;
  fixId?: import('./doctor-fixes.js').DoctorFixerId;
  fixData?: Record<string, unknown>;
}

/**
 * The worker login service for each Deployment the member home holds a
 * membership of: installed or not, held by the platform or not, and which
 * process on this machine serves the Deployment. A Deployment with no worker
 * attached anywhere leaves its runs queued, so a missing one warns.
 */
export async function checkWorkerServices(vaultDir: string, deps: import('./worker-service.js').WorkerServiceDeps = {}): Promise<DoctorCheck[]> {
  const { resolveProjectRoot } = await import('../project-root.js');
  const { resolveMycoHome } = await import('../paths/home.js');
  const { deploymentUrl, listDeploymentMemberships } = await import('../member/registry.js');
  const { describeWorkerService, workerServiceWords } = await import('./worker-service.js');
  const mycoHome = deps.mycoHome ?? resolveMycoHome({ cwd: resolveProjectRoot(vaultDir) });
  return listDeploymentMemberships(mycoHome).map((membership) => {
    const url = deploymentUrl(membership.serverUrl);
    const words = workerServiceWords(describeWorkerService(url, { ...deps, mycoHome }));
    return { name: 'Worker service', status: words.status, detail: `${url}: ${words.line}`, fixable: false };
  });
}

/**
 * Whether this project's membership resolves for the symbionts set up on this
 * machine: the machine pin for a non-default home, and the Myco MCP server each
 * symbiont declares.
 *
 * The entry is read where the installer writes it — the symbiont's global
 * targets under the member scope, its project target under an override — and
 * the check reports which scope carries it, over what transport, and whether
 * it is the entry provisioning writes — the one carrying this member's
 * credential — or that a target could not be read. It reports what the
 * configuration declares, never that a server answers or that a credential
 * authenticates.
 */
export async function checkMemberMcpResolution(
  vaultDir: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { registryRead?: 'migrate' | 'strict' } = {},
): Promise<DoctorCheck[]> {
  const { resolveProjectRoot } = await import('../project-root.js');
  const { resolveMycoHome, defaultMycoHome, readMachineHomePin } = await import('../paths/home.js');
  const { readRegistryEntry, readRegistryEntryResult, listRegistryEntriesResult, deploymentUrl } = await import('../member/registry.js');
  const { loadManifests } = await import('../symbionts/detect.js');
  const root = resolveProjectRoot(vaultDir);
  const home = resolveMycoHome({ cwd: root, env });
  // Strict reads leave legacy entries unchanged and acquire no write lock.
  const strict = opts.registryRead === 'strict' ? readRegistryEntryResult(root, home) : null;
  const membership = strict !== null
    ? (strict.status === 'present' ? strict.entry : null)
    : readRegistryEntry(root, home);
  if (membership === null) return [];
  // The Deployment this project is a member of; every entry must name it.
  const selectedDeployment = deploymentUrl(membership.serverUrl);
  const checks: DoctorCheck[] = [];
  const homeDir = env.HOME && env.HOME.length > 0 ? env.HOME : undefined;
  const nonDefaultHome = path.resolve(home) !== path.resolve(defaultMycoHome(homeDir));
  if (nonDefaultHome && readMachineHomePin({ env: {}, homeDir })?.home !== path.resolve(home)) {
    checks.push({
      name: 'Member MCP resolution',
      status: 'warn',
      detail: `this project's membership lives in ${home}, but the machine pin (${path.join(defaultMycoHome(homeDir), 'runtime.home')}) does not name it; an MCP server started outside ${root} resolves the default home and finds no membership. Run \`MYCO_HOME=${home} myco member join\` again to pin the machine.`,
      reason: 'home_pin_missing',
      scope: 'global',
      fixable: false,
    });
  }
  // The member's MCP entry lives where the installer writes it: the symbiont's
  // global targets under the member scope, its project target under an
  // override. Every scope a target was read at is reported on its own; which
  // one a given host prefers is not decided here.
  const { SymbiontInstaller } = await import('../symbionts/installer.js');
  // Counted as a report reads it: no migration, and an entry it could not read is not one it can claim resolves.
  const readable = listRegistryEntriesResult(home);
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const TRANSPORT_REASON = { http: 'mcp_entry_http', stdio: 'mcp_entry_stdio' } as const;
  for (const manifest of loadManifests()) {
    if (!manifest.registration) continue;
    const at = (scope: 'member-global' | 'member-project') => new SymbiontInstaller(manifest, root, packageRoot, false, undefined, null, scope, home);
    const global = at('member-global');
    const seen = [...global.inspectMemberMcp(selectedDeployment), ...at('member-project').inspectMemberMcp(selectedDeployment)];
    if (seen.length === 0) continue;

    for (const target of seen.filter((t) => t.present)) {
      // An entry that does not carry this member's credential cannot
      // authenticate or resolve the membership, whatever it routes over.
      if (!target.carriesCredential) {
        checks.push({
          name: 'Member MCP resolution',
          status: 'warn',
          detail: `${manifest.displayName}'s ${target.scope} configuration declares a Myco MCP server that carries no member credential, so it resolves no membership. Run \`myco member join --provision ${manifest.name}\`.`,
          reason: 'mcp_entry_no_credential',
          scope: target.scope,
          symbiont: manifest.name,
          fixable: false,
        });
        continue;
      }
      // A launcher resolves this project only from an absolute directory that is
      // its root, or from any directory where the machine holds one membership.
      if (target.transport === 'stdio') {
        const cwd = target.declaredCwd !== null && path.isAbsolute(target.declaredCwd) ? target.declaredCwd : null;
        const resolves = cwd === null
          ? readable.readable && readable.unavailableEntries === 0 && readable.entries.length === 1
          : path.resolve(cwd) === path.resolve(root);
        if (!resolves) {
          checks.push({
            name: 'Member MCP resolution',
            status: 'warn',
            detail: cwd === null
              ? `${manifest.displayName} starts its MCP server in a directory of its own choosing and its ${target.scope} entry names no absolute one, so it resolves this project's membership only where this machine holds exactly one readable one.`
              : `${manifest.displayName}'s ${target.scope} entry starts its MCP server in a directory that is not ${root}, so it resolves another project's membership or none.`,
            reason: cwd === null ? 'mcp_cwd_ambiguous' : 'mcp_cwd_elsewhere',
            scope: target.scope,
            root: cwd === null ? undefined : root,
            symbiont: manifest.name,
            fixable: false,
          });
          continue;
        }
      }
      // Headers are minted for the Deployment the helper names and sent to the
      // one the URL names. Whether those two agree is true of the entry itself;
      // whether they name this project's Deployment is true of this project.
      if (target.deploymentsAgree === false) {
        checks.push({
          name: 'Member MCP resolution',
          status: 'warn',
          detail: `${manifest.displayName}'s ${target.scope} entry sends its headers to a Deployment its helper does not mint them for.`,
          reason: 'mcp_server_mismatch',
          scope: target.scope,
          symbiont: manifest.name,
          fixable: false,
        });
        continue;
      }
      if (target.namesExpectedDeployment === false) {
        checks.push({
          name: 'Member MCP resolution',
          status: 'warn',
          detail: `${manifest.displayName}'s ${target.scope} entry names a Deployment this project is not a member of, so it resolves no membership for it.`,
          reason: 'mcp_server_stale',
          scope: target.scope,
          root,
          symbiont: manifest.name,
          fixable: false,
        });
        continue;
      }
      // A member entry is on disk; whether the server answers is not read here.
      // One that names no transport cannot be dialed, so it is a warning that
      // keeps its own reason.
      checks.push({
        name: 'Member MCP resolution',
        status: target.transport === null ? 'warn' : 'ok',
        detail: target.transport === null
          ? `${manifest.displayName}'s ${target.scope} configuration declares a member entry that names neither a URL nor a launcher, so nothing can reach it.`
          : `${manifest.displayName} declares a member entry in its ${target.scope} configuration over ${target.transport} transport.`,
        reason: target.transport === null ? 'mcp_entry_unknown_transport' : TRANSPORT_REASON[target.transport],
        scope: target.scope,
        symbiont: manifest.name,
        fixable: false,
      });
    }
    for (const target of seen.filter((t) => !t.readable)) {
      checks.push({
        name: 'Member MCP resolution',
        status: 'warn',
        detail: `${manifest.displayName}'s ${target.scope} MCP configuration could not be read, so whether the member's server is declared there is unknown.`,
        reason: 'mcp_target_unreadable',
        scope: target.scope,
        symbiont: manifest.name,
        fixable: false,
      });
    }
    // A symbiont this machine never installed resolves targets all the same, so
    // an absent entry is a finding only where the hooks say it was installed.
    // That gate decides nothing about a target already reported above.
    const quiet = seen.every((target) => !target.present && target.readable);
    if (quiet && global.isConfigured()) {
      checks.push({
        name: 'Member MCP resolution',
        status: 'warn',
        detail: `${manifest.displayName} is set up for capture but declares no Myco MCP server, so it reads no project intelligence. Run \`myco member join --provision ${manifest.name}\`.`,
        reason: 'mcp_entry_absent',
        scope: 'global',
        symbiont: manifest.name,
        fixable: false,
      });
    }
  }
  return checks;
}

// --- Output formatting ---

/** Status label width (visible characters). */
const STATUS_COL_WIDTH = 6;

const STATUS_LABELS: Record<DoctorCheck['status'], { text: string; color: string }> = {
  ok: { text: 'ok', color: '\x1b[32m' },
  fail: { text: 'FAIL', color: '\x1b[31m' },
  warn: { text: '!!', color: '\x1b[33m' },
};

export function formatCheck(check: DoctorCheck): string {
  const name = check.name ? check.name.padEnd(NAME_COL_WIDTH) : CONTINUATION_INDENT;
  const { text, color } = STATUS_LABELS[check.status];
  const paddedText = text.padEnd(STATUS_COL_WIDTH);
  return `  ${name}${color}${paddedText}\x1b[0m${check.detail}`;
}
