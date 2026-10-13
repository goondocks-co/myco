/** Commands with no runtime handler in the member binary. */
const RETIRED_VERBS = new Set([
  'grove', 'subsystem', 'service', 'restart', 'join', 'leave', 'attach', 'detach', 'host',
  'verify', 'setup-llm', 'setup-digest', 'detect-providers', 'agent', 'task', '__restore-backup', '__finish-uninstall', 'init',
]);

export const isRetiredVerb = (verb: string): boolean => RETIRED_VERBS.has(verb);


/** Retirement guidance follows the observed migration state of this machine. */
export async function retiredVerbMessage(verb: string): Promise<string> {
  const { resolveMycoHome } = await import('../paths/home.js');
  const { legacyMigrationState } = await import('../member/legacy-migration.js');
  const { LEGACY_MIGRATION_GUIDANCE } = await import('../member/migration-guidance.js');
  const successors: Readonly<Record<string, string>> = { verify: 'myco doctor', init: 'myco login', join: 'myco member join', leave: 'myco member leave', '__restore-backup': 'myco server restore' };
  const successor = successors[verb];
  const retired = `myco ${verb} is retired in Myco 2.0; run \`myco --help\`.` + (successor ? ` Use \`${successor}\`.` : '');
  return retired + (legacyMigrationState(resolveMycoHome()).state === 'unmoved' ? ` ${LEGACY_MIGRATION_GUIDANCE}` : '');
}
