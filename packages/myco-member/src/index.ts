/**
 * The member-only entry point, compiled to measure what a split would cost.
 *
 * Everything reachable from here is the §4 allowlist closure — the hooks,
 * `src/member/`, the generated hook config, the transcript parser — so the
 * compiled size is the size of a binary that captures and delivers and does
 * nothing else. Imports are relative into `packages/myco/src` because that is
 * what an extraction would start from; nothing here is published.
 *
 * `settings` renders its block from the generated hook config rather than the
 * symbiont's hook template: the templates are bundled through the installer's
 * `templates.generated.ts`, which is outside the closure. A real split has to
 * carry a member-only slice of the templates across — that cost is recorded
 * with the numbers, not hidden by leaving the command out.
 */
import { main as errorOccurred } from '../../myco/src/hooks/error-occurred.js';
import { main as notification } from '../../myco/src/hooks/notification.js';
import { main as postCompact } from '../../myco/src/hooks/post-compact.js';
import { main as postToolUse } from '../../myco/src/hooks/post-tool-use.js';
import { main as postToolUseFailure } from '../../myco/src/hooks/post-tool-use-failure.js';
import { main as preCompact } from '../../myco/src/hooks/pre-compact.js';
import { main as preToolUse } from '../../myco/src/hooks/pre-tool-use.js';
import { main as sessionEnd } from '../../myco/src/hooks/session-end.js';
import { main as sessionStart } from '../../myco/src/hooks/session-start.js';
import { main as stop } from '../../myco/src/hooks/stop.js';
import { main as stopFailure } from '../../myco/src/hooks/stop-failure.js';
import { main as subagentStart } from '../../myco/src/hooks/subagent-start.js';
import { main as subagentStop } from '../../myco/src/hooks/subagent-stop.js';
import { main as taskCompleted } from '../../myco/src/hooks/task-completed.js';
import { main as userPromptSubmit } from '../../myco/src/hooks/user-prompt-submit.js';
import { HOOK_CONFIG } from '../../myco/src/hooks/hook-config.generated.js';
import { unboundedBudget } from '../../myco/src/member/budget.js';
import { CREDENTIAL_FLAG, NEVER_DRAINS_HOOK } from '../../myco/src/member/constants.js';
import { parseCredentialFlag, resolveMemberProjectRoot } from '../../myco/src/member/credential.js';
import { refreshMemberCredential } from '../../myco/src/member/refresh.js';
import { listRegistryEntries, readRegistryEntry, type RegistryEntry } from '../../myco/src/member/registry.js';
import { applySpoolRetention } from '../../myco/src/member/retention.js';
import { MemberSpool } from '../../myco/src/member/spool.js';
import { ServerClient } from '../../myco/src/member/transport.js';

type HookMain = (opts?: { credential?: 'registry' | 'env' | null }) => Promise<void>;

const HOOKS: Record<string, HookMain> = {
  'error-occurred': errorOccurred,
  notification,
  'post-compact': postCompact,
  'post-tool-use': postToolUse,
  'post-tool-use-failure': postToolUseFailure,
  'pre-compact': preCompact,
  'pre-tool-use': preToolUse,
  'session-end': sessionEnd,
  'session-start': sessionStart,
  stop,
  'stop-failure': stopFailure,
  'subagent-start': subagentStart,
  'subagent-stop': subagentStop,
  'task-completed': taskCompleted,
  'user-prompt-submit': userPromptSubmit,
};

const out = (line: string): void => { process.stdout.write(`${line}\n`); };
const die = (line: string): never => { process.stderr.write(`myco-member: ${line}\n`); process.exit(2); };

function entriesFor(args: readonly string[]): RegistryEntry[] {
  if (args.includes('--all')) return listRegistryEntries();
  const entry = readRegistryEntry(resolveMemberProjectRoot());
  return entry ? [entry] : die(`no membership recorded for ${resolveMemberProjectRoot()}`);
}

async function member(args: readonly string[]): Promise<void> {
  const [op, ...rest] = args;
  for (const entry of entriesFor(rest)) {
    const spool = new MemberSpool(entry.projectId);
    switch (op) {
      case 'drain': {
        applySpoolRetention(spool);
        for (const result of await spool.drainAll(new ServerClient(entry), unboundedBudget(), { force: true })) {
          out(`${entry.projectId} ${result.sessionId}: sent ${result.sent}, acked ${result.acked}, remaining ${result.remaining}`);
        }
        break;
      }
      case 'status':
        out(`${entry.projectId} ${entry.root}: ${spool.sessionIds().reduce((n, id) => n + spool.depth(id), 0)} un-acknowledged`);
        break;
      case 'refresh':
        out(`${entry.projectId}: ${(await refreshMemberCredential(entry.root, { budget: unboundedBudget() })).status}`);
        break;
      default:
        die(`unknown member op "${op ?? ''}"`);
    }
  }
}

/** The sandbox settings block, keyed by each harness event the generated config wires. */
function settings(args: readonly string[]): void {
  const harness = args[args.indexOf('--harness') + 1];
  const config = HOOK_CONFIG[harness];
  if (!config) die(`unknown agent "${harness ?? ''}"`);
  const hooks: Record<string, unknown> = {};
  for (const [event, entry] of Object.entries(config.hookEvents)) {
    if (entry.hook === NEVER_DRAINS_HOOK) continue;
    hooks[event] = [{
      matcher: '',
      hooks: [{ type: 'command', command: `${process.execPath} hook ${entry.hook} --symbiont ${harness} ${CREDENTIAL_FLAG} env`, ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }) }],
    }];
  }
  out(JSON.stringify({ hooks }, null, 2));
}

const [, , command, ...rest] = process.argv;
switch (command) {
  case 'hook': {
    const hook = HOOKS[rest[0] ?? ''];
    if (!hook) die(`unknown hook "${rest[0] ?? ''}"`);
    await hook({ credential: parseCredentialFlag(rest) });
    break;
  }
  case 'member':
    await member(rest);
    break;
  case 'settings':
    settings(rest);
    break;
  default:
    die('usage: myco-member hook <name> | member <op> | settings --harness <name>');
}
