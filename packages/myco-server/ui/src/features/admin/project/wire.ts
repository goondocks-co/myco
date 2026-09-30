/**
 * The shapes a project's settings read, as the server sends them: what Myco
 * does in the project, its repository and its release tracking. Access keys
 * are `GrantRow` in `features/admin/wire.ts`.
 *
 * Declared here with no imports, since the dashboard cannot import the
 * server's declarations; `tests/myco-server/settings-wire.test.ts` holds each
 * to the server's own under `typecheck:tests`.
 */

/** `GET /api/projects/{p}/capabilities`: every capability, on or off. */
export interface CapabilitiesAnswer {
  capabilities: Record<string, boolean>;
}

/** A stored key described, never shown. */
export interface KeyDescription {
  configured: boolean;
  readable: boolean;
  maskedValue: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** `GET /api/projects/{p}/repository`: the committed source Myco's code tasks read. */
export interface RepositoryRow {
  revision: string;
  url: string;
  branch: string;
  username: string | null;
  credential: KeyDescription | null;
  updatedAt: number;
  updatedBy: string;
}

export interface RepositoryAnswer {
  repository: RepositoryRow | null;
}

export interface PackageTagMapping { pathGlob: string; tagPattern: string }

export interface ReleaseCheck {
  requestedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  status: 'complete' | 'partial' | 'unavailable' | null;
  failure: string | null;
  counts: { checked: number; changed: number; unchanged: number; unknown: number; unavailable: number; deferred: number } | null;
  lookups: number | null;
  lastCompleteAt: number | null;
}

/** `GET /api/projects/{p}/release-provenance`: release tracking, as stored and as it last ran. */
export interface ReleaseProvenanceRow {
  enabled: boolean;
  githubRepo: string | null;
  productionRefs: string[];
  integrationRefs: string[];
  packageMap: PackageTagMapping[];
  includeUnknown: boolean;
  maxLookups: number;
  revision: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
  credential: { configured: boolean; purpose: string };
  suggestedRepo: string | null;
  check: ReleaseCheck | null;
  problem: 'stored_settings_unreadable' | null;
}

export interface ReleaseProvenanceAnswer {
  releaseProvenance: ReleaseProvenanceRow;
}
