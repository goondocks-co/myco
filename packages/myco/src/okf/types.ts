import type { ProjectScope } from '@myco/grove/ids.js';

/** Bundle section kinds a maintain run can include. */
export type OkfIncludeKind = 'spores' | 'canopy' | 'concepts' | 'guides';

/** Spore lifecycle filter for projection (real lifecycle: active|superseded|consolidated|obsolete). */
export type OkfSporeStatusFilter = 'active' | 'superseded' | 'consolidated' | 'obsolete' | 'all';

/** `published` bundles are repo-visible; `local` bundles live under `.myco/okf/bundle/`. */
export type OkfBundleMode = 'published' | 'local';

/**
 * `myco_strict` is the superset the legacy `OkfConcept` bundle path (still
 * live until Task 1.5) must satisfy — checked via `validateConceptSource`.
 * `conformance`/`strict` validate the OKF-v0.1 `OkfDocument` model instead:
 * `conformance` is the reference's real write-time floor (parseable
 * frontmatter mapping + the four-key floor); `strict` is Myco's superset on
 * top of it (no-frontmatter indexes, slug-safe paths, permissive-link
 * preference, hostile-frontmatter-text backstop). The two families are
 * validated by entirely separate per-file rule sets within
 * `validateBundleTree` — they never call into each other.
 *
 * CAVEAT: this uniform meaning holds only inside `validateBundleTree`. Called
 * directly, `validateConceptSource` still gives `'conformance'` its legacy
 * type-only-floor meaning (see that function's own doc comment) — the same
 * string means two different things depending on entry point.
 */
export type OkfValidationLevel = 'myco_strict' | 'conformance' | 'strict';

export interface OkfFrontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string;
  /** Unknown keys are preserved verbatim across parse/serialize. */
  [key: string]: unknown;
}

export interface OkfSourceRef {
  sourceKind?: 'spore' | 'canopy_entry' | 'canopy_map' | 'okf_concept';
  id: string;
  projectId: string | null;
  machineId?: string;
  sourceHash?: string;
  sourceUpdatedAt?: string;
  projectionVersion?: string;
  generatedByRunId?: string | null;
}

export interface OkfLink {
  from: string;
  to: string;
  label: string;
  reason: 'supersession' | 'file_path' | 'map_reference' | 'index' | 'concept_reference' | 'maintenance';
}

export interface OkfConcept {
  /** Bundle-relative path without `.md` — the identity. */
  id: string;
  /** ALWAYS `${id}.md`; derived, never hand-authored. */
  path: string;
  frontmatter: OkfFrontmatter;
  body: string;
  source: OkfSourceRef;
  links: OkfLink[];
  stale?: boolean;
}

/**
 * OKF v0.1 document — the portable-wiki document Phase 2 synthesis produces.
 * Unlike `OkfConcept`, it carries no Myco source/provenance and no derived
 * `links`; its frontmatter is the closed six-key OKF schema rendered by
 * `renderOkfDocument` in serialize.ts.
 */
export interface OkfDocument {
  /** Bundle-relative path, including `.md`. */
  path: string;
  frontmatter: OkfFrontmatter;
  body: string;
}

export interface OkfValidationIssue {
  level: 'error' | 'warning';
  /**
   * Machine-readable finding code, e.g. 'missing_type', 'unparseable_frontmatter',
   * 'path_traversal', 'duplicate_concept_id', 'nonroot_index_frontmatter',
   * 'unsafe_resource_uri', 'missing_recommended_field' (`myco_strict`);
   * 'missing_required_frontmatter_key', 'index_has_frontmatter',
   * 'unsafe_frontmatter_text', 'prefer_absolute_link' (`conformance`/`strict`).
   */
  code: string;
  /** Bundle-relative file path. */
  path: string;
  message: string;
}

export interface OkfValidationReport {
  ok: boolean;
  level: OkfValidationLevel;
  filesChecked: number;
  conceptsChecked: number;
  issues: OkfValidationIssue[];
}

export const OKF_VERSION = '0.1';
export const OKF_RESERVED_FILES = ['index.md', 'log.md'] as const;
/** Marker AND sidecar payload — one file (master-plan interface freeze). */
export const OKF_MARKER_FILENAME = '.myco-okf-maintain.json';
/** Bump intentionally to mark existing projections stale. */
export const OKF_PROJECTION_VERSION = '1';

// Bundle-write types are frozen here; the OkfBundle capability (Plan 4) consumes them.

export interface OkfBundleInclude {
  spores: boolean;
  canopy: boolean;
  concepts: boolean;
  guides: boolean;
}

export interface OkfBundleWriteInput {
  scope: ProjectScope;
  projectRoot: string;
  machineId: string;
  outputRoot?: string;
  mode: OkfBundleMode;
  /** Sections to include; when omitted, the capability derives them from config. */
  include?: OkfBundleInclude;
  sporeStatus: OkfSporeStatusFilter;
  includeUndescribedCanopy?: boolean;
  dryRun?: boolean;
  oneShot?: boolean;
  allowExternalOutput?: boolean;
  /** Overwrite pre-existing non-Myco output at the output root. */
  overwrite?: boolean;
  /** Acknowledge publish-eligibility findings before a repo-visible publish. */
  acknowledgePublish?: boolean;
  generatedByRunId?: string | null;
  now?: Date;
}

export interface OkfMaintainWarning {
  code: string;
  message: string;
  path?: string;
}

export interface OkfBundleWriteResult {
  outputRoot: string;
  dryRun: boolean;
  generatedAt: string;
  conceptCount: number;
  counts: Record<OkfIncludeKind, number>;
  warnings: OkfMaintainWarning[];
  validation: OkfValidationReport;
  inputsHash: string;
  /** Inputs unchanged since the last run — generation short-circuited. */
  unchanged?: boolean;
  publishEligibility?: {
    ok: boolean;
    findings: Array<{ code: string; path: string; excerpt: string }>;
  };
}
