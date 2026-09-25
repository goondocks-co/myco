/**
 * Where a retained verb runs as a 2.0 member.
 *
 * `runMemberVerb` answers a member verb (`cli/member-verbs.ts`) for a joined
 * project, or a command line that declares a credential source, and answers
 * null for a root with no membership so the dispatcher runs the verb's 1.4
 * handler. `helpText` decides which command list `myco --help` prints.
 *
 * Nothing this module reaches opens a vault, a Grove database or the daemon;
 * `tests/meta/member-read-boundary.test.ts` walks its import closure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listDeploymentMemberships, readRegistryEntryResult } from '../member/registry.js';
import { GROVES_DIRNAME } from '../paths/home.js';
import { homeOf, memberSource, rootOf, type MemberVerbDeps } from './deployment-reader.js';
import { isMemberReadVerb, type MemberVerb } from './member-verbs.js';
import type { WorkerServiceDeps } from './worker-service.js';

export interface MemberDispatchDeps extends MemberVerbDeps {
  /** The worker service probe's own dependencies, for `doctor` and `logs`. */
  worker?: WorkerServiceDeps;
  /** The directory the symbiont templates are read from, for `doctor`. */
  packageRoot?: string;
}

/** Answer `verb` as a member: true or false for the verb's outcome, null when this invocation has no Deployment to ask. */
export async function runMemberVerb(verb: MemberVerb, args: readonly string[], deps: MemberDispatchDeps = {}): Promise<boolean | null> {
  const source = memberSource(args, deps);
  if (source === null) return null;
  if (isMemberReadVerb(verb)) return (await import('./member-reads.js')).run(verb, args, source, deps);
  switch (verb) {
    case 'doctor': return (await import('./member-doctor.js')).run(args, source, deps);
    case 'logs': return (await import('./member-logs.js')).run(args, source, deps);
    case 'config': return (await import('./member-config.js')).run(args, source, deps);
  }
}

/** Whether this home carries a 1.4 install: it holds a Groves directory. */
const hasLegacyInstall = (home: string): boolean => fs.existsSync(path.join(home, GROVES_DIRNAME));

/**
 * The command list `myco --help` prints. The member's when this root is
 * joined, or when the home carries no 1.4 install. On a home with a 1.4
 * install, a root with no membership gets the 1.4 list, followed by the member
 * section when the home holds a Deployment membership; a 1.4-only home gets the
 * 1.4 list alone.
 */
export function helpText(legacyUsage: string, deps: MemberVerbDeps = {}): string {
  const home = homeOf(deps);
  if (readRegistryEntryResult(rootOf(deps), home).status !== 'missing') return MEMBER_USAGE;
  if (!hasLegacyInstall(home)) return MEMBER_USAGE;
  return listDeploymentMemberships(home).length > 0 ? `${legacyUsage}\n${MEMBER_SECTION}` : legacyUsage;
}

/** The member verbs, as a 1.4 list shows them beside its own on a home that holds both. */
export const MEMBER_SECTION = `2.0 member (a project joined with \`myco login\`; run \`myco --help\` from it for the full list):
  login <invite-link>      Redeem an invite link and sign this machine in
  member <op>              join | leave | provision | drain | status | export | refresh | link-github
  worker [options]         Run this machine's harnesses for a Deployment (install|uninstall|status)
  In a joined project, search, vectors, session, stats, doctor, logs and config answer as the member.
`;

export const MEMBER_USAGE = `Usage: myco <command> [args]

Membership:
  login <invite-link>      Redeem an invite link and sign this machine in
  member <op>              join | leave | provision | drain | status | export | refresh | link-github
  import                   Bring this machine's existing agent history to its Deployment
  worker [options]         Run this machine's harnesses for a Deployment (install|uninstall|status)

Project intelligence (answered by the Deployment for this project):
  search <query>           Search spores, sessions, plans and prompts
  vectors <query>          Semantic search with similarity scores
  session [id|latest]      Show a session
  stats                    This project on its Deployment: sessions, activity, agent runs
  tool <list|call>         List or call Myco tools as JSON
  open                     Open the Deployment dashboard in your browser

This machine:
  doctor                   Check membership, capture, spool, MCP, worker and Deployment reachability
  logs [--tail N]          Show the worker's logs and the events the Deployment refused
  config get [<leaf>]      Show Deployment Settings (written in the dashboard)
  settings                 Print harness settings for a sandboxed agent (--harness <name> --project <id>)
  update                   Update Myco's managed files and agent registration
  remove                   Remove Myco from this machine
  version                  Show the installed version

Self-hosting:
  server <subcommand>      Create, run and manage a Deployment on this machine
`;
