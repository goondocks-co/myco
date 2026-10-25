/** The member MCP handshake shared by the Deployment and roots bootstrap. */
export const SERVER_INSTRUCTIONS = [
  'Myco is this project\'s memory: sessions that happened, spores (durable observations), and plans.',
  '',
  'Tenancy: every tool takes `project`, a project id or the repository\'s git remote. Reads may use the connection\'s default project, when present. Without a default, every call must name a project. Writes always name a project. Undeclared arguments are refused by name.',
  '',
  'Reach for it when you need why rather than what: a prior decision, a gotcha, how a subsystem came to be this way. Search with `myco_search`, then fetch a hit in full by its id with `myco_spores`, `myco_plans` or `myco_sessions`. Record a durable finding with `myco_spores` op "save"; keep plans current with `myco_plans` op "save". Record each pull request, issue, tag, release or deploy you created in this session with `myco_outcomes` op "report".',
  '',
  '`myco_cortex` op "instructions" returns this project\'s standing guidance and its project id.',
].join('\n');

/** The first protocol revision requiring the modern envelope transport. */
export const FIRST_MODERN_REVISION = '2026-07-28';

/** Revisions supported by the per-request JSON transport. */
export const servedMcpVersions = (versions: readonly string[]): string[] => versions.filter(version => version < FIRST_MODERN_REVISION);
