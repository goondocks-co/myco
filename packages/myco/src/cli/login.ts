/**
 * `myco login <url>` — redeem an invite link for this machine's membership.
 *
 * The link is the whole credential: its origin names the Deployment and its
 * fragment carries the single-use invitation. Nothing is read from a config
 * file, so this works on a machine that has never seen Myco.
 *
 * The invitation is spent once and cannot be replayed, so every check that can
 * be made on the string alone is made before the request. A mistyped link costs
 * nothing; a spent one is reported as spent rather than as a failure to reach
 * the Deployment.
 *
 * What this writes is the Deployment membership — the credential — and, when the
 * invitation named a Project, the binding for the current project root as well.
 * An invitation that names no Project admits a person to the Deployment; they
 * bind their first project afterwards with `myco member join --project`.
 */
import { getMachineId } from '../machine-id.js';
import { resolveMycoHome } from '../paths/home.js';
import { isSafeProjectRoot } from '../project-root.js';
import { resolveMemberProjectRoot } from '../member/credential.js';
import { exchangeJoinCode, parseJoinCode, recordJoinAnswer, JOIN_CODE_REFUSALS } from '../member/join-code.js';

export const LOGIN_HELP = `Usage: myco login <invite-link>

Signs this machine in to a Myco deployment. Ask an admin on the deployment for
an invite link, then run:

  myco login https://myco.example.com/join#<key>

The link works once and expires. If yours is refused, ask for a fresh one.

Options:
  --root <dir>   The project to connect, when the invite names one.
                 Defaults to the project you are in.

If the invite names a project, that project is connected and your agents start
capturing there. If it does not, you are signed in only — connect your first
project afterwards with \`myco member join\`.

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
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

interface LoginArgs {
  url?: string;
  root?: string;
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
    } else if (arg.startsWith('-')) {
      refuse(`unknown option ${arg.split('=')[0]}`);
    } else if (parsed.url === undefined) {
      parsed.url = arg;
    } else {
      refuse('login takes one invite link');
    }
  }
  return parsed;
}

/**
 * Redeem the link, and report whether it worked.
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

  const code = parseJoinCode(parsed.url);
  if ('error' in code) return fail(JOIN_CODE_REFUSALS[code.error]);

  const machineId = deps.machineId ?? getMachineId();
  const exchange = await exchangeJoinCode(code, { fetch: deps.fetch, machineId, runtimeKind: 'persistent' });
  if (!exchange.ok) return fail(`${exchange.reason} (${exchange.code})`);

  const answer = exchange.answer;
  let root: string | undefined;
  if (answer.projectId !== null) {
    root = parsed.root ?? resolveMemberProjectRoot(deps.cwd);
    if (!isSafeProjectRoot(root)) return fail(`${root} is not a project directory`);
  }

  recordJoinAnswer(code, answer, {
    mycoHome: deps.mycoHome ?? resolveMycoHome(), root, now: deps.now?.() ?? Date.now(), machineId,
  });

  out(`Signed in to ${code.serverUrl} as ${answer.memberId} (${answer.role}).`);
  if (root !== undefined) out(`  Connected ${root} to project ${answer.projectId}. Your agents capture there from now on.`);
  else out('  No project yet — connect your first one with `myco member join`.');
  return true;
}
