/**
 * What a session reports it created: a pull request, issue, tag, release or deploy, named by its own id and URL.
 *
 * The report is the only source. Nothing here reads commits, branches, tool output or text to find an artifact; a row
 * exists only where the session's agent or harness declared it. One row per (session, kind, artifact id), minted at
 * report and never updated: the same report again answers the stored row, and the same artifact under a different
 * URL is refused rather than rewritten.
 *
 * Every writer of a row admits it through `admitArtifact` first: the report writer with the incoming URL, which it
 * serializes once, and the restorer with the stored URL, which must already be in that serialized form. A row the
 * admission refuses is never written.
 *
 * The insert itself requires the session to be held and not deleted, so a report racing the session's deletion either
 * lands before the deletion's batch, which then removes it, or writes nothing.
 */
import type { RelationalStore } from './adapters.js';
import { NOT_TOMBSTONED_PARAMS } from './tombstones.js';
import type { ReadScope } from '../read/scope.js';

export const ARTIFACT_KINDS = ['pr', 'issue', 'tag', 'release', 'deploy'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_ID_MAX_BYTES = 256;
export const ARTIFACT_URL_MAX_BYTES = 2048;

/** One refusal for each malformed field, naming the shape it takes. */
export const ARTIFACT_KIND_REASON = `kind is one of ${ARTIFACT_KINDS.join(', ')}`;
export const ARTIFACT_ID_REASON = `artifact_id is the artifact's own id: not blank, no control characters, at most ${ARTIFACT_ID_MAX_BYTES} bytes`;
export const ARTIFACT_URL_REASON = `url is the artifact's https URL, with no user name or password, at most ${ARTIFACT_URL_MAX_BYTES} bytes`;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

const isArtifactKind = (value: unknown): value is ArtifactKind => (ARTIFACT_KINDS as readonly unknown[]).includes(value);

/** The URL in its serialized form, or null unless it is an https URL with a host, no credentials and within the bound. */
function serializedUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') return null;
  return bytes(url.href) > ARTIFACT_URL_MAX_BYTES ? null : url.href;
}

export interface AdmittedArtifact {
  kind: ArtifactKind;
  artifactId: string;
  /** Always in its serialized form. */
  url: string;
}

/**
 * The artifact a writer may store, or the one refusal its fields earn. `report` serializes an incoming URL; `stored`
 * admits a URL only in the serialized form a report stores, so a stored value is never rewritten on its way back in.
 */
export function admitArtifact(
  fields: { kind: unknown; artifactId: unknown; url: unknown }, source: 'report' | 'stored',
): { ok: true; artifact: AdmittedArtifact } | { ok: false; reason: string } {
  if (!isArtifactKind(fields.kind)) return { ok: false, reason: ARTIFACT_KIND_REASON };
  const id = fields.artifactId;
  if (typeof id !== 'string' || id.trim().length === 0 || CONTROL_CHARACTERS.test(id) || bytes(id) > ARTIFACT_ID_MAX_BYTES) return { ok: false, reason: ARTIFACT_ID_REASON };
  const url = serializedUrl(fields.url);
  if (url === null || (source === 'stored' && url !== fields.url)) return { ok: false, reason: ARTIFACT_URL_REASON };
  return { ok: true, artifact: { kind: fields.kind, artifactId: id, url } };
}

export interface SessionArtifactRow {
  id: string;
  sessionId: string;
  kind: ArtifactKind;
  artifactId: string;
  url: string;
  author: string;
  reportedAt: number;
}

export interface ArtifactReport {
  sessionId: string;
  kind: unknown;
  artifactId: unknown;
  url: unknown;
  author: string;
  reportedAt: number;
}

export type ReportOutcome =
  | { outcome: 'created' | 'existing'; artifact: SessionArtifactRow }
  | { outcome: 'conflict'; artifact: SessionArtifactRow }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'no_session' };

export const ARTIFACT_COLUMNS = `id, session_id AS sessionId, kind, artifact_id AS artifactId, url, author, reported_at AS reportedAt`;

/** Record one reported artifact once it is admitted, or answer the one already reported under the same session, kind and id. */
export async function reportSessionArtifact(db: RelationalStore, scope: ReadScope, report: ArtifactReport): Promise<ReportOutcome> {
  const admitted = admitArtifact(report, 'report');
  if (!admitted.ok) return { outcome: 'refused', reason: admitted.reason };
  const { kind, artifactId, url } = admitted.artifact;
  const { projectId } = scope;
  const inserted = await db.prepare(`INSERT INTO session_artifacts (project_id, id, session_id, kind, artifact_id, url, author, reported_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM sessions WHERE project_id = ? AND session_id = ?) AND ${NOT_TOMBSTONED_PARAMS}
      ON CONFLICT (project_id, session_id, kind, artifact_id) DO NOTHING
      RETURNING ${ARTIFACT_COLUMNS}`)
    .bind(projectId, crypto.randomUUID(), report.sessionId, kind, artifactId, url, report.author, report.reportedAt,
      projectId, report.sessionId, projectId, report.sessionId)
    .first<SessionArtifactRow>();
  if (inserted !== null) return { outcome: 'created', artifact: inserted };
  const existing = await db.prepare(`SELECT ${ARTIFACT_COLUMNS} FROM session_artifacts
      WHERE project_id = ? AND session_id = ? AND kind = ? AND artifact_id = ?`)
    .bind(projectId, report.sessionId, kind, artifactId)
    .first<SessionArtifactRow>();
  if (existing === null) return { outcome: 'no_session' };
  return { outcome: existing.url === url ? 'existing' : 'conflict', artifact: existing };
}

/** A restored artifact row this Deployment refuses: its fields fail admission, or it names a session nobody holds. */
export class ArtifactRestoreRefused extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ArtifactRestoreRefused';
  }
}

const admitStored = (row: Record<string, unknown>): void => {
  const admitted = admitArtifact({ kind: row.kind, artifactId: row.artifact_id, url: row.url }, 'stored');
  if (!admitted.ok) throw new ArtifactRestoreRefused(`a reported artifact fails admission: ${admitted.reason}`);
};

/**
 * Admit every artifact row a restore carries before anything is written: each row's fields as stored, and its session,
 * which the artifact itself or this Deployment must hold in the same Project. Throws on the first refusal.
 */
export async function admitRestoredArtifacts(db: RelationalStore, rows: readonly Record<string, unknown>[], sessions: readonly Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const carried = new Set(sessions.map((row) => JSON.stringify([row.project_id, row.session_id])));
  const unresolved = new Map<string, Set<string>>();
  for (const row of rows) {
    admitStored(row);
    if (typeof row.project_id !== 'string' || typeof row.session_id !== 'string') throw new ArtifactRestoreRefused('a reported artifact names no project and session');
    if (carried.has(JSON.stringify([row.project_id, row.session_id]))) continue;
    unresolved.set(row.project_id, (unresolved.get(row.project_id) ?? new Set()).add(row.session_id));
  }
  for (const [projectId, ids] of unresolved) {
    const { results } = await db.prepare(`SELECT session_id FROM sessions WHERE project_id = ? AND session_id IN (SELECT value FROM json_each(?))`)
      .bind(projectId, JSON.stringify([...ids])).all<{ session_id: string }>();
    if (results.length !== ids.size) throw new ArtifactRestoreRefused('a reported artifact names a session neither the artifact nor this Deployment holds');
  }
}

/** Restore one admitted artifact, excluding a session the destination has deleted or does not hold. */
export function restoreSessionArtifactStatement(db: RelationalStore, row: Record<string, unknown>) {
  admitStored(row);
  const columns = Object.keys(row);
  return db.prepare(`INSERT OR IGNORE INTO session_artifacts (${columns.join(', ')})
    SELECT ${columns.map(() => '?').join(', ')}
    WHERE EXISTS (SELECT 1 FROM sessions WHERE project_id = ? AND session_id = ?) AND ${NOT_TOMBSTONED_PARAMS} RETURNING rowid`)
    .bind(...columns.map((column) => row[column] ?? null), row.project_id, row.session_id, row.project_id, row.session_id);
}
