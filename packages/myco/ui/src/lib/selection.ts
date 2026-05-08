export interface GroveProjectSummary {
  project_id: string;
  name: string;
  slug: string;
  root: string;
  binding_id: string | null;
  created_at: string;
  updated_at: string;
  manifest_state: 'present' | 'missing' | 'mismatch';
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
  const selection = getCurrentRequestSelection();
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
  return { grove, project: grove.projects[0] };
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
    ? parts[0].slice(0, 2)
    : `${parts[0][0]}${parts[1][0]}`;
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
