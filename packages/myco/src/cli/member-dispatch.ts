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
