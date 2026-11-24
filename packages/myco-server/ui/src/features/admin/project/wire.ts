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
  settings: Record<string, number>;
  revisions: Record<string, number>;
  capabilityRevisions: Record<string, number>;
  retiredCapabilities?: Record<string, boolean>;
}

/** A stored key described, never shown. */
export interface KeyDescription {
  configured: boolean;
  readable: boolean;
  maskedValue: string | null;
  /** Whether the stored value is a subscription token or an API key; null when nothing readable is stored. */
  kind: 'subscription' | 'api-key' | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** `GET /api/projects/{p}/repository`: the committed source Myco's code tasks read, through one GitHub App installation. */
export interface RepositoryRow {
  revision: string;
  url: string;
  branch: string;
  repositoryId: number;
  installationId: number;
  updatedAt: number;
  updatedBy: string;
}

export interface RepositoryAnswer {
  repository: RepositoryRow | null;
  /** Whether this server holds its GitHub App key, read from its configuration alone. */
  appConfigured: boolean;
}

/** `GET /api/github-app/installations?page=`: one page of the server's App installations, and the accounts approved here. */
export interface InstallationAccount { id: number; login: string; type: 'User' | 'Organization' }
export interface InstallationRow { installationId: number; account: InstallationAccount; approved: boolean; suspended: boolean; permissionsAccepted: boolean }
export interface ApprovedAccountRow { accountId: number; login: string; type: 'User' | 'Organization'; approvedBy: string; approvedAt: number }
/** `app` names the App these install, by slug and owner, for its install page. */
export interface InstallationsAnswer {
  installations: InstallationRow[];
  accounts: ApprovedAccountRow[];
  page: number;
  more: boolean;
  app: { slug: string; owner: { login: string; type: 'User' | 'Organization' } | null };
}

/** `GET /api/github-app/installations/{id}/repositories?page=`: one page of an approved installation's repositories. */
export interface RepositoryChoice { id: number; fullName: string; defaultBranch: string; private: boolean }
export interface RepositoryChoicesAnswer { repositories: RepositoryChoice[]; more: boolean }

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
  productionRefs: string[];
  integrationRefs: string[];
  packageMap: PackageTagMapping[];
  includeUnknown: boolean;
  maxLookups: number;
  revision: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
  /** The Project's connected repository, which every check reads. */
  repository: { url: string; branch: string } | null;
  check: ReleaseCheck | null;
  problem: 'stored_settings_unreadable' | null;
  /** True while release history is still being prepared after an update: no check runs until it finishes. */
  building: boolean;
  /** Older release records kept aside because they could not be matched to one record, up to the server's report cap. */
  unresolvedStates: number;
}

export interface ReleaseProvenanceAnswer {
  releaseProvenance: ReleaseProvenanceRow;
}
