import { useLocation } from 'react-router-dom';
import { ScopeSwitcher, type ScopeAll } from '../design';
import { useProjects } from '../hooks/use-projects';
import { isArchived, type ProjectSummary } from '../lib/api';
import {
  allProjectsSuffix, clearProjectHref, CODE_MAP_SUFFIX, keptFilters, pageSuffix, PROJECT_SETTINGS_SUFFIX, projectOf, PROJECTS_PATH, switchProjectHref,
} from './nav';

/** Most recent activity first; a project with none sorts last, then by name. */
function byRecency(a: ProjectSummary, b: ProjectSummary): number {
  return (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1) || a.name.localeCompare(b.name);
}

/** The projects a scope list offers: every project not archived, and the one open even when it is, most recent first. */
export function scopeProjects(all: readonly ProjectSummary[], openId: string | null): ProjectSummary[] {
  return all.filter((project) => !isArchived(project) || project.projectId === openId).sort(byRecency);
}

/** Why a page with no all-projects form offers only projects, by the page it is. */
const ONE_PROJECT_REASONS: Readonly<Record<string, string>> = {
  [CODE_MAP_SUFFIX]: 'The code map is drawn for one project at a time.',
  [PROJECT_SETTINGS_SUFFIX]: 'These settings belong to one project.',
};
const RECORD_REASON = 'This page belongs to one project.';
const LEAVES_RECORD = 'Leaves this page for the list across every project.';

/** The path under `/p/:project` with no trailing slash, or null for a path under no project. */
function underProject(pathname: string): string | null {
  const match = /^\/p\/[^/]+(.*)$/.exec(pathname);
  return match === null ? null : match[1]!.replace(/\/+$/, '');
}

/**
 * The "All projects" row for a path: on a page's all-projects form it is the
 * scope now; under a project it leads to that form, keeping the list's
 * filters, and from a record to its list's form, saying it leaves the record;
 * a page drawn per project says why it has none.
 */
export function scopeAll(location: { pathname: string; search: string }): ScopeAll | null {
  const rest = underProject(location.pathname);
  if (rest === null) {
    return allProjectsSuffix(location.pathname) === null ? null : { href: `${location.pathname}${keptFilters(location.search)}`, active: true };
  }
  const suffix = pageSuffix(location.pathname);
  const clear = clearProjectHref(location);
  if (clear === null) return { reason: ONE_PROJECT_REASONS[suffix] ?? RECORD_REASON };
  // From a record, every project's form is its list's: taking it leaves the record, and the row says so.
  return rest === suffix ? { href: clear, active: false } : { href: clear, active: false, leaves: LEAVES_RECORD };
}

/** The scope this path shows, in the words its switcher says it: "All projects" or the project's name. */
export function scopeWords(pathname: string, name: (projectId: string) => string | null): string {
  const projectId = projectOf(pathname);
  return projectId === null ? 'All projects' : name(projectId) ?? 'This project';
}

/**
 * The page's scope beside its title: which projects it shows, and the one
 * place to change it. Picking a project keeps the page; "All projects" leads
 * to the page's all-projects form, where it has one.
 */
export function PageScope() {
  const location = useLocation();
  const projects = useProjects();
  const all = projects.data?.projects ?? [];
  const openId = projectOf(location.pathname);
  const listed = scopeProjects(all, openId);
  return (
    <ScopeSwitcher
      label="Showing"
      current={scopeWords(location.pathname, (id) => all.find((project) => project.projectId === id)?.name ?? null)}
      projects={listed.map((project) => ({
        projectId: project.projectId,
        name: project.name,
        sessionCount: project.sessionCount,
        lastActivityAt: project.lastActivityAt,
        href: switchProjectHref(location, project.projectId),
        active: project.projectId === openId,
      }))}
      all={scopeAll(location)}
      more={{ href: PROJECTS_PATH, label: 'Every project, in detail' }}
    />
  );
}

/** The same list for choosing one project without leaving the page, as Run a task asks for it. */
export function ProjectPick({ value, onChange }: { value: string | null; onChange: (projectId: string) => void }) {
  const projects = useProjects();
  const listed = scopeProjects(projects.data?.projects ?? [], value);
  const chosen = listed.find((project) => project.projectId === value);
  return (
    <ScopeSwitcher
      label="Project"
      current={chosen?.name ?? 'Choose a project'}
      projects={listed.map((project) => ({
        projectId: project.projectId,
        name: project.name,
        sessionCount: project.sessionCount,
        lastActivityAt: project.lastActivityAt,
        active: project.projectId === value,
      }))}
      all={null}
      onPick={onChange}
    />
  );
}

/** What a page for the whole server says in place of a scope. */
export function ServerScope() {
  return <p className="t-small text-muted" data-scope-deployment="">Applies to every project.</p>;
}
