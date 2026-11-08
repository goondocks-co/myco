import type { RelationalStore as sessions_import_RelationalStore } from "../../core/adapters.js";
import { CLEANLINESS_SQL as releaseCleanliness } from '../../core/provenance.js';
import { RELEASE_DERIVED, RELEASE_FENCE, RELEASE_UPSERT } from '../../db/release/classification.js';

const release_PATHS_MARK_SQL = 'CASE WHEN ? = 1 THEN COALESCE((SELECT d.tool_calls FROM session_documents d WHERE d.project_id = g.project_id AND d.session_id = g.session_id), 0) ELSE 0 END';

const release_FENCE = RELEASE_FENCE;

const release_RELEASE_UPSERT = RELEASE_UPSERT;

const release_DERIVED = RELEASE_DERIVED;

export function prepareReleasePaths(db: sessions_import_RelationalStore, projectId: string, sessionId: string) {
  return db.prepare(`SELECT d.state, CASE WHEN d.state = 'live' THEN (SELECT json_group_array(path) FROM (SELECT p.path FROM session_paths p
      WHERE p.project_id = d.project_id AND p.session_id = d.session_id AND p.generation = d.generation ORDER BY p.last_at DESC, p.path LIMIT 500)) END AS files
    FROM session_documents d WHERE d.project_id = ? AND d.session_id = ?`).bind(projectId, sessionId);
}

export function prepareReleaseCandidates(db: sessions_import_RelationalStore, projectId: string, mapped: number, prefix: string, fingerprint: string | null, limit: number) {
  return db.prepare(`SELECT g.session_id AS sessionId, g.capture_point AS point, g.head_sha AS headSha,
      ${releaseCleanliness} AS cleanliness, ${release_PATHS_MARK_SQL} AS pathsMark, g.captured_at AS capturedAt
    FROM knowledge_git_provenance g
    WHERE g.project_id = ? AND g.session_id IS NOT NULL AND g.head_sha IS NOT NULL
      AND (g.capture_point = 'session_end' OR (g.capture_point = 'session_start' AND NOT EXISTS (
        SELECT 1 FROM knowledge_git_provenance e WHERE e.project_id = g.project_id AND e.identity_key = 'session:' || g.session_id || ':session_end')))
      AND NOT EXISTS (SELECT 1 FROM knowledge_release_state k
        WHERE k.project_id = g.project_id AND k.identity_key = ? || g.session_id
          AND ((k.state = 'released' AND json_extract(k.evidence_json, '$.source') IS NULL)
            OR (json_extract(k.evidence_json, '$.source') = g.capture_point || ':' || g.head_sha || ':' || ${releaseCleanliness}
              AND (k.state = 'released' OR (? IS NOT NULL AND json_extract(k.evidence_json, '$.refs_fingerprint') = ?
                AND json_extract(k.evidence_json, '$.paths_mark') IS ${release_PATHS_MARK_SQL})))))
    ORDER BY capturedAt DESC, sessionId LIMIT ?`).bind(mapped, projectId, prefix, fingerprint, fingerprint, mapped, limit);
}

export function prepareReleasePropagation(db: sessions_import_RelationalStore, projectId: string, sessionPrefix: string, now: number, fence: readonly unknown[], limit: number) {
  return release_DERIVED.map(([namespace, table, key]) => db.prepare(`INSERT INTO knowledge_release_state
      (project_id, id, identity_key, namespace, record_id, source_session_id, state, confidence, basis_kind, basis_ref,
       basis_sha, release_pr_number, reason, evidence_json, checked_at, created_at)
    SELECT r.project_id, 'rs_' || lower(hex(randomblob(16))), r.project_id || ':${namespace}:' || r.${key}, '${namespace}', r.${key}, r.session_id,
       k.state, k.confidence, k.basis_kind, k.basis_ref, k.basis_sha, k.release_pr_number, k.reason,
       json_remove(k.evidence_json, '$.previous'), k.checked_at, ?
      FROM ${table} r JOIN knowledge_release_state k ON k.project_id = r.project_id AND k.identity_key = ? || r.session_id
      WHERE r.project_id = ? AND ${release_FENCE} AND NOT EXISTS (SELECT 1 FROM knowledge_release_state d
        WHERE d.project_id = r.project_id AND d.identity_key = r.project_id || ':${namespace}:' || r.${key}
          AND (d.source_session_id IS r.session_id OR d.state = 'released'))
      LIMIT ? ${release_RELEASE_UPSERT}`).bind(now, sessionPrefix, projectId, ...fence, limit));
}
