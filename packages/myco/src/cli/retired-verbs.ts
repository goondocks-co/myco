/** Commands with no runtime handler in the member binary. */
const RETIRED_VERBS = new Set([
  'grove', 'subsystem', 'service', 'restart', 'join', 'leave', 'attach', 'detach', 'host',
  'verify', 'setup-llm', 'setup-digest', 'detect-providers', 'agent', 'task', '__restore-backup', '__finish-uninstall', 'init',
]);

export const isRetiredVerb = (verb: string): boolean => RETIRED_VERBS.has(verb);
