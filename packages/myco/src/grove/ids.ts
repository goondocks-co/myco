import crypto from 'node:crypto';

const RANDOM_BYTES = 16;

export const GROVE_ID_PREFIXES = {
  grove: 'grove',
  project: 'proj',
  grove_binding: 'gbind',
  migration: 'mig',
  migration_mapping: 'mmap',
  session: 'sess',
  prompt_batch: 'pbat',
  activity: 'act',
  plan: 'plan',
  artifact: 'art',
  attachment: 'att',
  spore: 'spore',
  entity: 'ent',
  graph_edge: 'edge',
  resolution_event: 'res',
  digest_extract: 'digest',
  agent_run: 'run',
  agent_report: 'report',
  agent_turn: 'turn',
  agent_task: 'task',
  skill_candidate: 'skcand',
  skill_record: 'skill',
  skill_lineage: 'sklin',
  skill_usage: 'skuse',
  notification: 'notif',
  log_entry: 'log',
  canopy_map: 'cmap',
} as const;

export type GroveIdKind = keyof typeof GROVE_ID_PREFIXES;

const OPAQUE_ID_PATTERN = /^[a-z][a-z0-9]*_[0-9a-f]{32}$/;

export function createGroveEraId(kind: GroveIdKind): string {
  return `${GROVE_ID_PREFIXES[kind]}_${randomOpaqueSuffix()}`;
}

export function createGroveId(): string {
  return createGroveEraId('grove');
}

export function createProjectId(): string {
  return createGroveEraId('project');
}

export function createGroveBindingId(): string {
  return createGroveEraId('grove_binding');
}

export function createMigrationId(): string {
  return createGroveEraId('migration');
}

export function createMigrationMappingId(): string {
  return createGroveEraId('migration_mapping');
}

export function isGroveEraId(value: string, kind?: GroveIdKind): boolean {
  if (!OPAQUE_ID_PATTERN.test(value)) return false;
  if (!kind) return true;
  return value.startsWith(`${GROVE_ID_PREFIXES[kind]}_`);
}

export function assertGroveEraId(value: string, kind?: GroveIdKind): string {
  if (isGroveEraId(value, kind)) return value;
  const expected = kind ? `${GROVE_ID_PREFIXES[kind]}_<32 hex chars>` : '<prefix>_<32 hex chars>';
  throw new Error(`Invalid Grove-era id: expected ${expected}`);
}

export function slugifyGroveName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'default';
}

function randomOpaqueSuffix(): string {
  return crypto.randomBytes(RANDOM_BYTES).toString('hex');
}
