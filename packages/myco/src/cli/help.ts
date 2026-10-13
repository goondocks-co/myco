import { renderTopLevelHelp } from './command-registry.js';
import { legacyMigrationState } from '../member/legacy-migration.js';
import { LEGACY_MIGRATION_GUIDANCE } from '../member/migration-guidance.js';
import { homeOf, type MemberVerbDeps } from './deployment-reader.js';

export function helpText(deps: MemberVerbDeps = {}): string {
  return legacyMigrationState(homeOf(deps)).state === 'unmoved'
    ? `${MEMBER_USAGE}\n${LEGACY_MIGRATION_GUIDANCE}\n` : MEMBER_USAGE;
}

export const MEMBER_USAGE = renderTopLevelHelp();
