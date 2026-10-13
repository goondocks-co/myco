/** Member commands never fall through to a local runtime. */
import { legacyMigrationState } from '../member/legacy-migration.js';
import { LEGACY_MIGRATION_GUIDANCE } from '../member/migration-guidance.js';
import { homeOf, memberSource, type MemberVerbDeps } from './deployment-reader.js';
import { isMemberReadVerb, type MemberVerb } from './member-verbs.js';
import type { WorkerServiceDeps } from './worker-service.js';

export interface MemberDispatchDeps extends MemberVerbDeps {
  worker?: WorkerServiceDeps;
  packageRoot?: string;
}

export async function runMemberVerb(verb: MemberVerb, args: readonly string[], deps: MemberDispatchDeps = {}): Promise<boolean> {
  const source = memberSource(args, deps);
  if (source === null && legacyMigrationState(homeOf(deps)).state === 'unmoved') {
    (deps.stderr ?? console.error)(LEGACY_MIGRATION_GUIDANCE);
    return false;
  }
  const credential = source ?? 'registry';
  if (verb === 'doctor') return (await import('./member-doctor.js')).run(args, credential, deps);
  if (isMemberReadVerb(verb)) return (await import('./member-reads.js')).run(verb, args, credential, deps);
  switch (verb) {
    case 'logs': return (await import('./member-logs.js')).run(args, credential, deps);
    case 'config': return (await import('./member-config.js')).run(args, credential, deps);
  }
}

export function helpText(deps: MemberVerbDeps = {}): string {
  return legacyMigrationState(homeOf(deps)).state === 'unmoved'
    ? `${MEMBER_USAGE}\n${LEGACY_MIGRATION_GUIDANCE}\n` : MEMBER_USAGE;
}

export const MEMBER_USAGE = `Usage: myco <command> [args]

Membership:
  setup [options]         Guide sign-in and runner enrollment; --status reads only
  logout <address>        Sign this machine out of a Deployment
  cutover                 Move Myco 1.4 data to a Deployment (--dry-run first)
  login <address>          Sign this machine in through your Myco dashboard
  member <op>              join | leave | provision | drain | status | export | refresh | link-github | raw-claims | ownership | role
  import                   Bring this machine's existing agent history to its Deployment
  runner <verb>            Register, run or update this machine’s runner (register|run|update|status)
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
  update (alias: upgrade)  Update Myco within its recorded channel; refresh member agents
  remove                   Remove Myco from this machine
  version                  Show the installed version

Self-hosting:
  server <subcommand>      Create, run and manage a Deployment on this machine
`;
