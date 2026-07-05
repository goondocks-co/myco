import type { ProjectScope } from '@myco/grove/ids.js';

/** Bundle section kinds a maintain run can include. */
export type OkfIncludeKind = 'spores' | 'canopy' | 'concepts' | 'guides';

/** Spore lifecycle filter for projection (real lifecycle: active|superseded|consolidated|obsolete). */
export type OkfSporeStatusFilter = 'active' | 'superseded' | 'consolidated' | 'obsolete' | 'all';

/** `published` bundles are repo-visible; `local` bundles live under `.myco/okf/bundle/`. */
export type OkfBundleMode = 'published' | 'local';

/**
 * `conformance` is the OKF v0.1 floor any consumer must accept;
 * `myco_strict` is the superset Myco-generated output must satisfy.
 */
export type OkfValidationLevel = 'conformance' | 'myco_strict';

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

export interface OkfValidationIssue {
  level: 'error' | 'warning';
  /**
   * Machine-readable finding code, e.g. 'missing_type', 'unparseable_frontmatter',
   * 'path_traversal', 'duplicate_concept_id', 'nonroot_index_frontmatter',
   * 'unsafe_resource_uri', 'missing_recommended_field'.
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
  include: OkfBundleInclude;
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
