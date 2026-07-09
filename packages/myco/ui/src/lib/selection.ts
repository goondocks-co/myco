import type { ProjectActivityRow } from '@myco/daemon/api/projects-activity';

export interface GroveProjectSummary {
  project_id: string;
  name: string;
  slug: string;
  root: string;
  binding_id: string | null;
  status?: 'active' | 'archived';
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
  manifest_state: 'present' | 'missing' | 'invalid' | 'mismatch';
  capabilities?: Record<string, boolean>;
}

export interface GroveSummary {
  id: string;
  name: string;
  slug: string;
  mode: 'local';
  is_default: boolean;
  created_at: string;
  project_count: number;
  projects: GroveProjectSummary[];
}

export interface GrovesResponse {
  groves: GroveSummary[];
}

export interface ProjectSelection {
  grove: GroveSummary;
  project: GroveProjectSummary;
}

const LAST_SELECTION_KEY = 'myco.lastSelectedProject';

let currentRequestSelection: ProjectSelection | null = null;

export function setCurrentRequestSelection(selection: ProjectSelection | null): void {
  currentRequestSelection = selection;
}

export function getCurrentRequestSelection(): ProjectSelection | null {
  return currentRequestSelection;
}

export function requestContextHeadersFromSelection(): Record<string, string> {
  return requestContextHeadersForSelection(getCurrentRequestSelection());
}

export function requestContextHeadersForSelection(selection: ProjectSelection | null | undefined): Record<string, string> {
  if (!selection) return {};
  return {
    'x-myco-grove-id': selection.grove.id,
    'x-myco-project-id': selection.project.project_id,
  };
}

export function findSelection(
  groves: GroveSummary[],
  groveSlug: string | undefined,
  projectSlug: string | undefined,
): ProjectSelection | null {
  if (!groveSlug || !projectSlug) return null;
  const grove = groves.find((candidate) => candidate.slug === groveSlug || candidate.id === groveSlug);
  if (!grove) return null;
  const project = grove.projects.find((candidate) =>
    candidate.slug === projectSlug || candidate.project_id === projectSlug,
  );
  return project ? { grove, project } : null;
}

export function defaultSelection(groves: GroveSummary[]): ProjectSelection | null {
  const defaultGrove = groves.find((grove) => grove.is_default && grove.projects.length > 0);
  const grove = defaultGrove ?? groves.find((candidate) => candidate.projects.length > 0);
  if (!grove) return null;
  const project = grove.projects[0];
  return project ? { grove, project } : null;
}

function activityMsByProject(activity: ProjectActivityRow[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of activity ?? []) {
    // Normalize a missing or unparseable timestamp to 0 so NaN never reaches a
    // comparator (NaN makes Array.sort order undefined and `>` always false).
    const parsed = row.last_activity_at ? Date.parse(row.last_activity_at) : 0;
    map.set(row.project_id, Number.isNaN(parsed) ? 0 : parsed);
  }
  return map;
}

/**
 * Most-recently-active project across all groves, used as the landing default
 * when there is no stored selection. Falls back to the default grove's first
 * project when no activity data is available.
 */
export function mostRecentSelection(
  groves: GroveSummary[],
  activity: ProjectActivityRow[] | undefined,
): ProjectSelection | null {
  const fallback = defaultSelection(groves);
  if (!activity || activity.length === 0) return fallback;
  const ms = activityMsByProject(activity);
  // Seed with the default selection so a project only displaces it when it has
  // STRICTLY greater activity. This keeps the is_default grove preference on
  // ties (e.g. right after install when every project's activity is 0), instead
  // of silently landing on whichever grove happens to be first in the array.
  let best = fallback;
  let bestMs = fallback ? (ms.get(fallback.project.project_id) ?? 0) : -1;
  for (const grove of groves) {
    for (const project of grove.projects) {
      const value = ms.get(project.project_id) ?? 0;
      if (value > bestMs) {
        bestMs = value;
        best = { grove, project };
      }
    }
  }
  return best;
}

/** Most-recently-active project within a single grove (first project if no activity). */
export function mostRecentProjectInGrove(
  grove: GroveSummary,
  activity: ProjectActivityRow[] | undefined,
): GroveProjectSummary | null {
  if (grove.projects.length === 0) return null;
  if (!activity || activity.length === 0) return grove.projects[0] ?? null;
  const ms = activityMsByProject(activity);
  return [...grove.projects].sort(
    (a, b) => (ms.get(b.project_id) ?? 0) - (ms.get(a.project_id) ?? 0),
  )[0] ?? null;
}

export function projectPath(selection: ProjectSelection, suffix = ''): string {
  const normalizedSuffix = suffix && suffix !== '/' ? `/${suffix.replace(/^\/+/, '')}` : '';
  return `/g/${selection.grove.slug}/p/${selection.project.slug}${normalizedSuffix}`;
}

export function projectRouteSuffix(pathname: string): string {
  const match = pathname.match(/^\/g\/[^/]+\/p\/[^/]+(?<suffix>\/.*)?$/);
  const suffix = match?.groups?.suffix ?? '/';
  if (/^\/sessions\/[^/]+/.test(suffix)) return '/sessions';
  return suffix;
}

export type NavScope = 'project' | 'grove' | 'machine';

/**
 * Pages whose true scope differs from what their URL implies. The Team surface
 * is machine-wide (teams are global; you assign any project from any grove) even
 * though it is bound to a grove route for request-context headers.
 */
const PAGE_SCOPE_OVERRIDES: Array<{ test: RegExp; scope: NavScope }> = [
  { test: /^\/g\/[^/]+\/team(\/|$|\?)/, scope: 'machine' },
];

/** Page scope inferred from the URL: project (/g/<g>/p/<p>/…), grove (/g/<g>/…), else machine. */
export function scopeForPath(pathname: string): NavScope {
  for (const o of PAGE_SCOPE_OVERRIDES) if (o.test.test(pathname)) return o.scope;
  if (/^\/g\/[^/]+\/p\/[^/]+/.test(pathname)) return 'project';
  if (/^\/g\/[^/]+/.test(pathname)) return 'grove';
  return 'machine';
}

export function selectionKey(selection: ProjectSelection | null): string {
  return selection ? `${selection.grove.id}:${selection.project.project_id}` : 'none';
}

export function readLastSelection(): { groveId: string; projectId: string } | null {
  try {
    const raw = window.localStorage.getItem(LAST_SELECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { groveId?: unknown; projectId?: unknown };
    if (typeof parsed.groveId !== 'string' || typeof parsed.projectId !== 'string') return null;
    return { groveId: parsed.groveId, projectId: parsed.projectId };
  } catch {
    return null;
  }
}

export function writeLastSelection(selection: ProjectSelection): void {
  try {
    window.localStorage.setItem(LAST_SELECTION_KEY, JSON.stringify({
      groveId: selection.grove.id,
      projectId: selection.project.project_id,
    }));
  } catch {
    // localStorage can be unavailable in hardened browser contexts.
  }
}

export function selectionFromLast(groves: GroveSummary[]): ProjectSelection | null {
  const last = readLastSelection();
  if (!last) return null;
  const grove = groves.find((candidate) => candidate.id === last.groveId);
  const project = grove?.projects.find((candidate) => candidate.project_id === last.projectId);
  return grove && project ? { grove, project } : null;
}

export function monogramFor(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'M';
  const letters = parts.length === 1
    ? parts[0]?.slice(0, 2) ?? 'M'
    : `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`;
  return letters.toUpperCase();
}

export function colorForProjectId(id: string): string {
  let hash = 0;
  for (let idx = 0; idx < id.length; idx += 1) {
    hash = (hash * 31 + id.charCodeAt(idx)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 58% 48%)`;
}

// `applyProjectFavicon` was removed — it generated a canvas with the
// project's monogram + colored bg and overwrote the theme favicon
// link. The result was that the OS tab UI lost the static
// `/favicon-<theme>.svg` whenever a project was selected. The
// project monogram still shines inside the app chrome (sidebar
// project switcher, Groves page tile) where it belongs.
