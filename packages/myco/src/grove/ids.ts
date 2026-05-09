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

/**
 * Branded `project_id` value. Every writer that touches a `project_id`
 * column must take this type, never a bare `string`. The brand is the
 * structural gate that keeps legacy path strings, NULLs, and other
 * Grove-id prefixes out of the data plane — the only way to obtain a
 * `GroveProjectId` is to pass through `assertGroveProjectId`.
 */
export type GroveProjectId = string & { readonly __brand: 'GroveProjectId' };

/**
 * Validate `value` as a Grove-era project id (`proj_<32 hex chars>`) and
 * return it as a branded `GroveProjectId`. Throws otherwise. This is the
 * single mint site for the brand.
 */
export function assertGroveProjectId(value: unknown): GroveProjectId {
  if (typeof value !== 'string' || !isGroveEraId(value, 'project')) {
    throw new Error(
      `Invalid Grove project id: expected proj_<32 hex chars>, got ${JSON.stringify(value)}`,
    );
  }
  return value as GroveProjectId;
}

/**
 * Read-side scope for queries that filter on `project_id`. Required at
 * every call site so the compiler forces an explicit choice — no more
 * `projectId?: string | null` defaulting silently to `WHERE project_id IS NULL`
 * or to "no filter".
 *
 * - `{ kind: 'project', id }` — filters to a single Grove-era project.
 * - `{ kind: 'global' }` — reads only daemon-wide rows where
 *   `project_id IS NULL` (rare; truly daemon-scoped data only — startup
 *   logs, daemon notifications).
 * - `{ kind: 'all' }` — no `project_id` filter, returns rows across
 *   every project in the scoped Grove DB. Use for admin/aggregation
 *   views; treat as the riskier choice and prefer `project` when in doubt.
 */
export type ProjectScope =
  | { kind: 'project'; id: GroveProjectId }
  | { kind: 'global' }
  | { kind: 'all' };

export function projectScope(id: GroveProjectId): ProjectScope {
  return { kind: 'project', id };
}

export const GLOBAL_SCOPE: ProjectScope = { kind: 'global' };
export const ALL_PROJECTS_SCOPE: ProjectScope = { kind: 'all' };

export function slugifyGroveName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'default';
}

/**
 * URL-stable slug for a project under a Grove. Combines the slugified
 * project name with a 6-hex suffix derived from the project id so two
 * projects with the same name in the same Grove still get distinct URLs.
 *
 * Canonical: every code path that surfaces a project URL — the daemon
 * `/api/groves` response, `myco update`'s post-migration banner, the UI
 * router — must call this function rather than reinventing the formula.
 * Drift between callers will produce dashboard URLs that 404.
 */
export function projectUrlSlug(projectName: string, projectId: string): string {
  const base = slugifyGroveName(projectName);
  const suffix = crypto.createHash('sha1').update(projectId).digest('hex').slice(0, 6);
  return `${base}-${suffix}`;
}

function randomOpaqueSuffix(): string {
  return crypto.randomBytes(RANDOM_BYTES).toString('hex');
}
