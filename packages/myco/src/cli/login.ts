import { normalizeMemberServerAddress, MEMBER_SERVER_URL_RULE } from '../member/server-url.js';
import { deviceLogin } from './device-login.js';
import { warmProjectContext } from '../member/prefetch.js';
import { seedMachineSettings } from '../member/machine-settings.js';
import { readDefaultDeployment, recordDefaultDeployment } from '../member/default-deployment.js';
import { MACHINE_IDENTITY_NOTE, REJOIN_HINT } from '@goondocks/myco-shared/member-protocol';
import { getMachineId } from '../machine-id.js';
import path from 'node:path';
import { hostname, platform } from 'node:os';
import { memberHomeFor, pinnedHomeLine } from '../member/home-for-folder.js';
import { isSafeProjectRoot } from '../project-root.js';
import { resolveMemberProjectRoot } from '../member/credential.js';
import { runImport } from '../member/import.js';
import { exchangeJoinCode, parseJoinCode, recordJoinAnswer, runtimeLabelOf, JOIN_CODE_REFUSALS } from '../member/join-code.js';
import type { WorkerServiceDeps } from './worker-service.js';
import { drainEntryBacklog } from '../member/backlog.js';
import { deploymentUrl, listRegistryEntries } from '../member/registry.js';
import { detectedProvisionLines, provisionDetectedAgents, recordNoAgents } from './member.js';

export const LOGIN_HELP = `Usage: myco login <server-url-or-invite-link>

Signs this machine in to a Myco deployment. Run:

  myco login myco.example.com
  myco login https://myco.example.com

Open the printed URL on any machine signed in to the dashboard, check the code
and machine details, and approve. This terminal waits for approval. No browser
is needed here, so it works over SSH. Bare addresses default to HTTPS.

An invite link still works:

  myco login https://myco.example.com/join#<key>

The link works once and expires. If yours is refused, ask for a fresh one.

Options:
  --root <dir>   The project to connect, when the invite names one.
                 Defaults to the project you are in.
  --no-agents    Sign in without setting up your agents. Set them up later
                 with \`myco member provision\`.
  --default      Make this deployment the one new repositories join, when
                 this machine is signed in to another already.

Every agent installed on this machine (Claude Code, Codex, Cursor, OpenCode, ...)
is set up to capture. An agent whose settings belong to another Myco
installation is left as it is and named.

If the invite names a project, that project is connected and your agents start
capturing there. Any other git repository under your capture folders (~/Repos
unless you change them in the dashboard) joins the deployment the first time an
agent works in it: the project that already holds its remote, or a new one named
after the folder. A repository you connect elsewhere with \`myco member join\`
stays where you put it.

In a sandbox or a CI job, set MYCO_JOIN_CODE to the same link instead of running
this command. The first agent session redeems it and captures from then on, with
nothing else to configure.
`;

export interface LoginDeps {
  fetch?: typeof fetch;
  now?: () => number;
  cwd?: string;
  mycoHome?: string;
  machineId?: string;
  /** This machine's host name, sent as the name the machine shows under; defaults to `os.hostname()`. */
  hostname?: () => string;
  os?: () => string;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Optional executor adapter; login never installs a service. */
  worker?: WorkerServiceDeps;
  /** The agents installed on this machine; defaults to `detectMachineInstalledSymbionts`. */
  agents?: () => string[];
  /** Where agent hooks are written from; defaults to the real package root. */
  packageRoot?: string;
}

interface LoginArgs {
  url?: string;
  root?: string;
  noAgents?: boolean;
  makeDefault?: boolean;
  error?: string;
}

function parseArgs(args: readonly string[]): LoginArgs {
  const parsed: LoginArgs = {};
  // The first complaint is the one reported, and no message quotes an argument's
  // value: the link IS the secret, and a diagnostic that echoes it leaves it in
  // the terminal scrollback for as long as that window lives.
  const refuse = (message: string): void => { if (parsed.error === undefined) parsed.error = message; };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root') {
      const next = args[++i];
      if (next === undefined || next.startsWith('--')) refuse('--root needs a value');
      else parsed.root = next;
    } else if (arg === '--no-agents') {
      parsed.noAgents = true;
    } else if (arg === '--default') {
      parsed.makeDefault = true;
    } else if (arg.startsWith('-')) {
      refuse(`unknown option ${arg.split('=')[0]}`);
    } else if (parsed.url === undefined) {
      parsed.url = arg;
    } else {
      refuse('login takes one Deployment address or invite link');
    }
  }
  return parsed;
}

/**
 * Sign in through a device approval or invite link, and report whether it worked.
 *
 * The outcome is RETURNED, never written to `process.exitCode` here. A verb that
 * stamps the process it runs in cannot be called twice in one process, and the
 * dispatcher is the one place that knows this invocation is the process's whole
 * purpose. `cli.ts` turns a false here into the exit status.
 */
export async function run(args: readonly string[], deps: LoginDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  const fail = (line: string): boolean => { err(`myco login: ${line}`); return false; };

  const parsed = parseArgs(args);
  if (parsed.error) return fail(parsed.error);
  if (!parsed.url) { err(LOGIN_HELP.trimEnd()); return false; }

  const address = normalizeMemberServerAddress(parsed.url);
  if (address === null) {
    if (parsed.url.includes('#')) {
      const invalidLink = parseJoinCode(parsed.url);
      if ('error' in invalidLink) return fail(JOIN_CODE_REFUSALS[invalidLink.error]);
    }
    return fail(`a Deployment address must be ${MEMBER_SERVER_URL_RULE}, with no account or password`);
  }
  const invite = address.hash !== '' || address.pathname.replace(/\/+$/, '') !== '';
  const code = invite ? parseJoinCode(address.href) : { serverUrl: address.origin };
  if ('error' in code) return fail(JOIN_CODE_REFUSALS[code.error]);
  if (!invite && address.search !== '') return fail('a Deployment address must carry no query');

  const machineId = deps.machineId ?? getMachineId();
  const runtimeLabel = runtimeLabelOf((deps.hostname ?? hostname)());
  const exchange = 'key' in code
    ? await exchangeJoinCode(code, { fetch: deps.fetch, machineId, runtimeKind: 'persistent', runtimeLabel })
    : await deviceLogin(code.serverUrl, { machineId, machineName: (deps.hostname ?? hostname)(), os: (deps.os ?? platform)() },
      { fetch: deps.fetch, stdout: out, sleep: deps.sleep, clock: deps.clock });
  if (!exchange.ok) {
    // This machine's identity is its member's for as long as that member stands, whatever became of its credential.
    if (exchange.code === 'identity_claimed') return fail(`this machine already belongs to a member of ${code.serverUrl} (identity_claimed) — ${REJOIN_HINT}. ${MACHINE_IDENTITY_NOTE}.`);
    return fail(`${exchange.reason} (${exchange.code})`);
  }

  const answer = exchange.answer;
  let root: string | undefined;
  if (answer.projectId !== null) {
    root = parsed.root ?? resolveMemberProjectRoot(deps.cwd);
    if (!isSafeProjectRoot(root)) return fail(`${root} is not a project directory`);
  }

  // The home this folder's capture reads (`memberHomeFor`): signing in anywhere else would leave its hooks with no membership.
  const folder = path.resolve(root ?? parsed.root ?? deps.cwd ?? process.cwd());
  const chosen = deps.mycoHome === undefined ? memberHomeFor(folder) : null;
  const mycoHome = deps.mycoHome ?? chosen!.home;
  recordJoinAnswer(code, answer, { mycoHome, root, now: deps.now?.() ?? Date.now(), machineId });
  const isDefault = recordDefaultDeployment(code.serverUrl, { mycoHome, now: deps.now?.() ?? Date.now(), replace: parsed.makeDefault });
  // The settings the Deployment holds for this machine, cached before the first session reads them.
  await seedMachineSettings({ serverUrl: code.serverUrl, token: answer.token }, { mycoHome, fetch: deps.fetch });
  // And the Project's blocks: the first session in the folder is served them whole.
  if (answer.projectId !== null && root !== undefined) {
    // A warm that fails costs the first session its block, never the sign-in.
    await warmProjectContext({ serverUrl: code.serverUrl, token: answer.token, projectId: answer.projectId }, { mycoHome, fetch: deps.fetch, now: deps.now }).catch(() => 0);
  }

  const pinned = chosen === null ? null : pinnedHomeLine(chosen, folder);
  if (pinned !== null) out(pinned);
  out(`Signed in to ${code.serverUrl} as ${answer.memberLabel ?? answer.memberId} (${answer.owner === true ? 'owner' : answer.role}).`);
  if (root !== undefined) out(`  Connected ${root} to project ${answer.projectId}. Your agents capture there from now on.`);
  else out('  No project yet. A git repository under your capture folders joins the first time an agent works in it, or connect one with `myco member join`.');
  const held = readDefaultDeployment(mycoHome);
  if (!isDefault && held !== null) out(`  New repositories keep joining ${held.serverUrl}; \`myco login --default <invite link>\` makes ${deploymentUrl(code.serverUrl)} the one they join.`);
  // Every agent installed here captures from now on: its hooks and MCP entry are written for this Deployment, and an
  // agent whose entries belong to another installation is left as it is and named.
  if (!parsed.noAgents) {
    const found = provisionDetectedAgents(mycoHome, code.serverUrl, root ?? null, { packageRoot: deps.packageRoot, agents: deps.agents });
    for (const line of detectedProvisionLines(found)) out(`  ${line}`);
  } else recordNoAgents(mycoHome, code.serverUrl);

  // What this machine captured while it could not deliver reaches the
  // Deployment now, for every project bound to it: the new credential is the
  // one every binding on this Deployment reads.
  for (const entry of listRegistryEntries(mycoHome).filter((e) => deploymentUrl(e.serverUrl) === deploymentUrl(code.serverUrl))) {
    try {
      const backlog = await drainEntryBacklog(entry, { mycoHome, fetch: deps.fetch, now: deps.now, machineId });
      const delivered = backlog.sessions.filter((s) => (s.events?.acked ?? 0) > 0 || (typeof s.transcripts === 'object' && s.transcripts.shipped > 0)).length;
      if (delivered > 0) out(`  Delivered ${delivered} session(s) captured in ${entry.root} while this machine could not reach the deployment.`);
      if (backlog.endedBy !== 'done') err(`  Some capture in ${entry.root} is still waiting (${backlog.endedBy}); \`myco member drain\` retries it.`);
    } catch (error) {
      err(`  Could not deliver waiting capture in ${entry.root} (${(error as Error).message}); \`myco member drain\` retries it.`);
    }
  }

  // A machine arrives with history, and the bounded pass over what is already
  // on its disk runs once, here. Only where the invitation named a Project:
  // without one there is nothing to import into. A failed import never fails
  // the sign-in — the machine is signed in, and `myco import` fetches the
  // history whenever the person wants it.
  if (root !== undefined) {
    const report = await runImport({ serverUrl: code.serverUrl }, {
      fetch: deps.fetch, now: deps.now, cwd: deps.cwd, mycoHome, machineId,
    }).catch(() => null);
    const imported = report?.projects.reduce((n, p) => n + p.agents.reduce((m, a) => m + a.imported, 0), 0) ?? 0;
    if (imported > 0) out(`  Imported ${imported} past sessions. Run \`myco import\` to reach further back.`);
  }
  return true;
}
