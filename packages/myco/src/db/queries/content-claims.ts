/**
 * Content claim system query helpers (Team Host WS2).
 *
 * `content_claims` is the publication lock over a DB-resident skill artifact;
 * `content_publications` is the durable "what was last published" marker.
 * Both are grove-resident and deliberately NOT team-sync tables (the
 * `routed_event_dedup` posture) — see `schema-ddl.ts`.
 *
 * A pre-retirement `okf_page` claim row can still be present in a real DB
 * (data preservation — never rewritten); every read/release path below stays
 * kind-agnostic (`string`, not `ContentClaimArtifactKind`) so such a row
 * keeps reading and releasing safely. Only `ContentClaimInsert` — new claim
 * creation — is narrowed to the current kind set.
 *
 * All SQL for these two tables lives here. Upper layers (the daemon API,
 * the expiry power job) call these functions and never prepare SQL inline.
 *
 * Claim creation is a constraint-based INSERT: the ACTIVE-partial unique
 * index on `(artifact_kind, artifact_id)` is the serialization guarantee, so
 * `insertContentClaim` attempts the insert and catches the unique-constraint
 * violation rather than checking-then-inserting (TOCTOU).
 */

import { getDatabase, isUniqueConstraintError } from '@myco/db/client.js';
import { appendProjectCondition, type ProjectScope } from '@myco/db/queries/project-scope.js';
import { createGroveEraId } from '@myco/grove/ids.js';
import { epochSeconds } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContentClaimArtifactKind = 'skill';
export type ContentClaimState = 'active' | 'released' | 'published' | 'expired';

export interface ContentClaimRow {
  id: string;
  artifact_kind: string;
  artifact_id: string;
  generation: number;
  project_id: string;
  claimed_by: string;
  claimed_at: number;
  expires_at: number;
  state: string;
  released_at: number | null;
  published_at: number | null;
  machine_id: string;
}

export interface ContentClaimInsert {
  artifactKind: ContentClaimArtifactKind;
  artifactId: string;
  generation: number;
  projectId: string;
  claimedBy: string;
  claimedAt: number;
  expiresAt: number;
  machineId: string;
}

export type InsertContentClaimResult =
  | { ok: true; row: ContentClaimRow }
  | { ok: false; holder: ContentClaimRow | null };

export interface ContentPublicationRow {
  artifact_kind: string;
  artifact_id: string;
  published_generation: number;
  published_at: number;
  published_by: string;
  machine_id: string;
}

// ---------------------------------------------------------------------------
// Column lists
// ---------------------------------------------------------------------------

const CLAIM_COLUMNS = [
  'id',
  'artifact_kind',
  'artifact_id',
  'generation',
  'project_id',
  'claimed_by',
  'claimed_at',
  'expires_at',
  'state',
  'released_at',
  'published_at',
  'machine_id',
].join(', ');

const PUBLICATION_COLUMNS = [
  'artifact_kind',
  'artifact_id',
  'published_generation',
  'published_at',
  'published_by',
  'machine_id',
].join(', ');

// ---------------------------------------------------------------------------
// content_claims — reads
// ---------------------------------------------------------------------------

/** Unscoped internal re-select after an insert/update — the caller already
 *  knows the id (it minted it or looked it up under its own scope). */
function selectClaimById(id: string): ContentClaimRow | null {
  const db = getDatabase();
  return (db.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM content_claims WHERE id = ?`,
  ).get(id) as ContentClaimRow | undefined) ?? null;
}

/** Scoped claim lookup by id — the daemon API's pre-check read before a
 *  refresh/release/published mutation. Scoped so a caller in one project can
 *  never address another project's claim row by guessing its id. */
export function getContentClaimById(id: string, scope: ProjectScope): ContentClaimRow | null {
  const db = getDatabase();
  const conditions = ['id = ?'];
  const params: unknown[] = [id];
  appendProjectCondition(conditions, params, scope);
  return (db.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM content_claims WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as ContentClaimRow | undefined) ?? null;
}

/**
 * The active claim (if any) for one artifact. Unscoped by project: the
 * ACTIVE-partial unique index itself is not project-scoped (an
 * `artifact_id` already belongs to exactly one project), so this mirrors the
 * constraint exactly — used both for the 409 holder-identity lookup after a
 * failed insert and for cross-referencing the inventory list.
 */
export function getActiveContentClaim(
  artifactKind: string,
  artifactId: string,
): ContentClaimRow | null {
  const db = getDatabase();
  return (db.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM content_claims
      WHERE state = 'active' AND artifact_kind = ? AND artifact_id = ?`,
  ).get(artifactKind, artifactId) as ContentClaimRow | undefined) ?? null;
}

/** Every active claim in scope — the inventory's "plus active claims" half. */
export function listActiveContentClaims(scope: ProjectScope): ContentClaimRow[] {
  const db = getDatabase();
  const conditions = ["state = 'active'"];
  const params: unknown[] = [];
  appendProjectCondition(conditions, params, scope);
  return db.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM content_claims WHERE ${conditions.join(' AND ')} ORDER BY claimed_at ASC`,
  ).all(...params) as ContentClaimRow[];
}

// ---------------------------------------------------------------------------
// content_claims — writes
// ---------------------------------------------------------------------------

/**
 * Constraint-based claim creation. Attempts the INSERT; a unique-constraint
 * violation on the ACTIVE-partial index means another active claim already
 * holds this artifact — caught and mapped to `{ ok: false, holder }` rather
 * than checked for beforehand (SELECT-then-INSERT would be TOCTOU: two
 * concurrent callers could both pass the check and both insert).
 */
export function insertContentClaim(input: ContentClaimInsert): InsertContentClaimResult {
  const db = getDatabase();
  const id = createGroveEraId('content_claim');
  try {
    db.prepare(
      `INSERT INTO content_claims (
         id, artifact_kind, artifact_id, generation, project_id,
         claimed_by, claimed_at, expires_at, state, released_at, published_at, machine_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?)`,
    ).run(
      id,
      input.artifactKind,
      input.artifactId,
      input.generation,
      input.projectId,
      input.claimedBy,
      input.claimedAt,
      input.expiresAt,
      input.machineId,
    );
  } catch (err) {
    // Safe to read any UNIQUE violation as "already claimed": the ACTIVE-partial
    // index is the only realistically-violable unique constraint on this table
    // (the PK is a freshly minted random 32-hex id).
    if (isUniqueConstraintError(err)) {
      // Holder can be null: the holder may release/expire between the failed
      // INSERT and this lookup — the caller simply retries the claim.
      return { ok: false, holder: getActiveContentClaim(input.artifactKind, input.artifactId) };
    }
    throw err;
  }
  return { ok: true, row: selectClaimById(id)! };
}

/**
 * Refresh: a holder-only UPDATE of the held row's `generation` to the
 * current lineage-latest — never a second INSERT (which would 409 against
 * the holder's own active row). Only mutates a row that is still `active`;
 * returns null if the claim already transitioned (caller re-checks state).
 */
export function updateContentClaimGeneration(id: string, generation: number): ContentClaimRow | null {
  const db = getDatabase();
  const result = db.prepare(
    `UPDATE content_claims SET generation = ? WHERE id = ? AND state = 'active'`,
  ).run(generation, id);
  return result.changes > 0 ? selectClaimById(id) : null;
}

/** Voluntary release: `active` -> `released`. Returns null if the row was
 *  not `active` (already released/published/expired underneath the caller). */
export function releaseContentClaim(id: string, releasedAt: number): ContentClaimRow | null {
  const db = getDatabase();
  const result = db.prepare(
    `UPDATE content_claims SET state = 'released', released_at = ? WHERE id = ? AND state = 'active'`,
  ).run(releasedAt, id);
  return result.changes > 0 ? selectClaimById(id) : null;
}

/**
 * Release EVERY active claim a machine holds on one project — the detach-pull's
 * first-page side effect (Phase F T3, D-F-4). A member leaving a project must not
 * strand a live publication lock behind it: its rows come back, so its claims are
 * dropped too. Scoped to `(machine_id, project_id)` so a member's claims on OTHER
 * projects it still hosts are untouched. Idempotent — a re-pulled first page finds
 * the rows already `released` and changes nothing. Returns the count released.
 */
export function releaseActiveContentClaimsForMachine(
  machineId: string,
  projectId: string,
  releasedAt: number,
): number {
  const db = getDatabase();
  const result = db.prepare(
    `UPDATE content_claims SET state = 'released', released_at = ?
      WHERE state = 'active' AND machine_id = ? AND project_id = ?`,
  ).run(releasedAt, machineId, projectId);
  return result.changes;
}

/**
 * Cancels the active claim (if any) for an artifact that is being deleted —
 * the delete flow's explicit, non-cascading cancel (spec §5: deletion ends
 * the claim via an explicit call in the delete path, never an FK cascade).
 * Same `active` -> `released` transition a voluntary release uses:
 * `content_claims` has no distinct 'cancelled' state, so what marks this as
 * a delete-triggered cancel rather than a holder-initiated release is the
 * caller's own log line, not the stored row. A no-op (returns null) when the
 * artifact has no active claim.
 *
 * `artifactKind` is deliberately `string`, not `ContentClaimArtifactKind`:
 * release is kind-independent (residue tolerance).
 */
export function cancelActiveContentClaimForArtifact(
  artifactKind: string,
  artifactId: string,
  cancelledAt: number,
): ContentClaimRow | null {
  const claim = getActiveContentClaim(artifactKind, artifactId);
  if (!claim) return null;
  return releaseContentClaim(claim.id, cancelledAt);
}

/**
 * Holder marks published: `active` -> `published` AND the durable
 * last-published marker upsert, as ONE transaction — the spec presents
 * published as a single operation. Split into two auto-committed writes, a
 * failure between them would leave a terminal 'published' claim with no
 * `content_publications` row: the artifact re-surfaces in inventory as
 * never-published and the holder cannot retry (the claim is no longer
 * active). The upsert records the claim's own pinned `generation` as
 * `published_generation`.
 *
 * Returns null (and writes nothing) when the claim is not `active`.
 */
export function markContentClaimPublished(
  id: string,
  input: { publishedAt: number; publishedBy: string; machineId: string },
): { claim: ContentClaimRow; publication: ContentPublicationRow } | null {
  const db = getDatabase();
  let out: { claim: ContentClaimRow; publication: ContentPublicationRow } | null = null;
  db.transaction(() => {
    const result = db.prepare(
      `UPDATE content_claims SET state = 'published', published_at = ? WHERE id = ? AND state = 'active'`,
    ).run(input.publishedAt, id);
    if (result.changes === 0) return;
    const claim = selectClaimById(id)!;
    const publication = upsertContentPublication({
      artifact_kind: claim.artifact_kind,
      artifact_id: claim.artifact_id,
      published_generation: claim.generation,
      published_at: input.publishedAt,
      published_by: input.publishedBy,
      machine_id: input.machineId,
    });
    out = { claim, publication };
  })();
  return out;
}

/**
 * Expiry sweep: `active && expires_at < now -> expired`. Never assumes an
 * active row is unexpired — a row can arrive via backup-restore/project-copy
 * with `expires_at` already past, so this sweep is the backstop, not an
 * optimization. Returns the number of rows flipped.
 */
export function expireStaleContentClaims(nowSeconds: number = epochSeconds()): number {
  const db = getDatabase();
  const result = db.prepare(
    `UPDATE content_claims SET state = 'expired' WHERE state = 'active' AND expires_at < ?`,
  ).run(nowSeconds);
  return result.changes;
}

/**
 * Terminal-row prune: deletes released/published/expired rows older than
 * `retentionSeconds`. These are audit breadcrumbs, not content history
 * (lineage holds that), so a plain DELETE is safe — no dependent rows
 * reference `content_claims`. Scheduled by the `content-claim-expiry` power
 * job (`daemon/power-jobs.ts`), immediately after the expiry sweep — a later
 * consolidation task's job is verification, not wiring.
 */
export function pruneTerminalContentClaims(
  retentionSeconds: number,
  nowSeconds: number = epochSeconds(),
): number {
  const db = getDatabase();
  const cutoff = nowSeconds - Math.max(0, retentionSeconds);
  const result = db.prepare(
    `DELETE FROM content_claims
      WHERE state IN ('released', 'published', 'expired')
        AND COALESCE(released_at, published_at, expires_at) < ?`,
  ).run(cutoff);
  return result.changes;
}

// ---------------------------------------------------------------------------
// content_publications
// ---------------------------------------------------------------------------

/** The durable last-published marker for one artifact, or null if it has
 *  never been published. Never pruned. */
export function getContentPublication(
  artifactKind: string,
  artifactId: string,
): ContentPublicationRow | null {
  const db = getDatabase();
  return (db.prepare(
    `SELECT ${PUBLICATION_COLUMNS} FROM content_publications WHERE artifact_kind = ? AND artifact_id = ?`,
  ).get(artifactKind, artifactId) as ContentPublicationRow | undefined) ?? null;
}

/** Every publication marker, optionally restricted to one artifact kind —
 *  the inventory's bulk lookup (avoids one query per candidate artifact). */
export function listContentPublications(artifactKind?: ContentClaimArtifactKind): ContentPublicationRow[] {
  const db = getDatabase();
  if (artifactKind) {
    return db.prepare(
      `SELECT ${PUBLICATION_COLUMNS} FROM content_publications WHERE artifact_kind = ?`,
    ).all(artifactKind) as ContentPublicationRow[];
  }
  return db.prepare(`SELECT ${PUBLICATION_COLUMNS} FROM content_publications`).all() as ContentPublicationRow[];
}

/** Upsert the last-published marker on mark-published. Composite PK
 *  `(artifact_kind, artifact_id)` — one row per artifact, always current. */
export function upsertContentPublication(row: ContentPublicationRow): ContentPublicationRow {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO content_publications (
       artifact_kind, artifact_id, published_generation, published_at, published_by, machine_id
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (artifact_kind, artifact_id) DO UPDATE SET
       published_generation = excluded.published_generation,
       published_at = excluded.published_at,
       published_by = excluded.published_by,
       machine_id = excluded.machine_id`,
  ).run(
    row.artifact_kind,
    row.artifact_id,
    row.published_generation,
    row.published_at,
    row.published_by,
    row.machine_id,
  );
  return getContentPublication(row.artifact_kind, row.artifact_id)!;
}
