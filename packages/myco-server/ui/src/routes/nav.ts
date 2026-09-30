import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import {
  Activity, Bot, KeyRound, ListChecks, Map as MapIcon, MessageSquare, Settings2, Sprout, Sun, Users, type LucideIcon,
} from 'lucide-react';

/** A page under a project, reached at `/p/:project<suffix>`. */
export interface ProjectPage {
  label: string;
  icon: LucideIcon;
  /** The path after `/p/:project`; the empty string is the project's home. */
  suffix: string;
  /** Shown only to an admin: every route behind the page is an admin's. */
  admin?: true;
}

/** The code map's page under a project: where Knowledge will hold it. */
export const CODE_MAP_SUFFIX = '/knowledge/map';

/** The pages under a project, in nav order. */
export const PROJECT_PAGES: readonly ProjectPage[] = [
  { label: 'Today', icon: Sun, suffix: '' },
  { label: 'Sessions', icon: MessageSquare, suffix: '/sessions' },
  { label: 'Spores', icon: Sprout, suffix: '/spores' },
  { label: 'Plans', icon: ListChecks, suffix: '/plans' },
  { label: 'Code map', icon: MapIcon, suffix: CODE_MAP_SUFFIX },
  { label: 'Agent runs', icon: Bot, suffix: '/runs' },
  { label: 'Access', icon: KeyRound, suffix: '/access', admin: true },
];

/** The pages on a phone's bottom bar; the rest are under More. */
export const PHONE_PAGES: readonly ProjectPage[] = PROJECT_PAGES.slice(0, 3);

/** A page for the whole server. */
export interface ServerPage {
  label: string;
  icon: LucideIcon;
  to: string;
  /** Pages folded under this one in the nav, listed while any of them is open. */
  children?: ReadonlyArray<{ label: string; to: string }>;
}

/**
 * The nav foot: the server's admin pages. A member who is not an admin sees
 * none of them. Measures and Operations fold under Status, where the one
 * Health page will hold all three.
 */
export const ADMIN_PAGES: readonly ServerPage[] = [
  { label: INVITE_CONTROLS.page, icon: Users, to: '/access' },
  { label: 'Settings', icon: Settings2, to: '/settings' },
  {
    label: 'Status',
    icon: Activity,
    to: '/status',
    children: [
      { label: 'Measures', to: '/measures' },
      { label: 'Operations', to: '/operations' },
    ],
  },
];

/** Whether a path is a page of a nav group: its head or one folded under it. */
export function inGroup(page: ServerPage, pathname: string): boolean {
  return [page.to, ...(page.children ?? []).map((child) => child.to)].includes(pathname.replace(/\/+$/, ''));
}

/** Every project, listed with its session count. */
export const PROJECTS_PATH = '/projects';

/** The page a member's own machines are listed on. */
export const MY_MACHINES_PATH = '/access';

/**
 * The pages that have an all-projects form, by the suffix of their per-project
 * one. The project filter can be cleared only on one of these: until a page
 * has a form that spans every project, there is nothing to clear it to.
 */
export const ALL_PROJECTS_FORMS: Readonly<Record<string, string>> = { '': '/', '/sessions': '/sessions' };

/** The suffix of the page whose all-projects form is at this path, or null when the path is no such form. */
export function allProjectsSuffix(pathname: string, forms: Readonly<Record<string, string>> = ALL_PROJECTS_FORMS): string | null {
  const path = pathname.replace(/(.)\/+$/, '$1');
  return Object.entries(forms).find(([, form]) => form === path)?.[0] ?? null;
}

/**
 * Where a page link in the nav leads: the page's all-projects form while the
 * path is unscoped and the page has one, else the page under `projectId`.
 */
export function pageHref(page: Pick<ProjectPage, 'suffix'>, pathname: string, projectId: string, forms: Readonly<Record<string, string>> = ALL_PROJECTS_FORMS): string {
  const all = forms[page.suffix];
  if (projectOf(pathname) === null && all !== undefined) return all;
  return projectPath(projectId, page.suffix);
}

/**
 * The query parameters that filter a list. They survive a change of project, so
 * a filtered list stays filtered; anything else (the open tab, the turn, the
 * page offset) belongs to the record or the page left behind and is dropped.
 */
export const FILTER_KEYS: readonly string[] = ['q', 'agent', 'member', 'type', 'status', 'state', 'window', 'branch', 'day'];

const PROJECT_PATH = /^\/p\/([^/]+)(?:\/([^/]+))?/;

/** The project a path is scoped to, or null for a page that spans the server. */
export function projectOf(pathname: string): string | null {
  const match = PROJECT_PATH.exec(pathname);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}

/**
 * The page under a project a path is on (`/sessions`, `/knowledge/map`), without
 * the record it names, or '' for the project's home. A page whose suffix runs
 * over more than one segment is matched whole; any other path is its first.
 */
export function pageSuffix(pathname: string): string {
  const match = PROJECT_PATH.exec(pathname);
  if (match === null) return '';
  const rest = pathname.slice(`/p/${match[1]}`.length).replace(/\/+$/, '');
  const page = PROJECT_PAGES.filter((p) => p.suffix.split('/').length > 2).find((p) => rest === p.suffix || rest.startsWith(`${p.suffix}/`));
  if (page !== undefined) return page.suffix;
  const section = match[2] ?? '';
  return section === '' ? '' : `/${section}`;
}

/** `/p/:project<suffix>`, with the project id encoded. */
export function projectPath(projectId: string, suffix = ''): string {
  return `/p/${encodeURIComponent(projectId)}${suffix}`;
}

/** The filters of a query string, in the order they were given. */
export function keptFilters(search: string): string {
  const kept = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) if (FILTER_KEYS.includes(key)) kept.append(key, value);
  const out = kept.toString();
  return out === '' ? '' : `?${out}`;
}

/**
 * Where picking a project in the filter leads: the same page under that
 * project, keeping the list's filters and dropping the record that was open.
 * From a page's all-projects form it leads to the same page under the project,
 * filters kept; from any other page that spans the server, to the project's
 * home.
 */
export function switchProjectHref(location: { pathname: string; search: string }, projectId: string): string {
  if (projectOf(location.pathname) === null) {
    const suffix = allProjectsSuffix(location.pathname);
    return suffix === null ? projectPath(projectId) : `${projectPath(projectId, suffix)}${keptFilters(location.search)}`;
  }
  return `${projectPath(projectId, pageSuffix(location.pathname))}${keptFilters(location.search)}`;
}

/** Where clearing the project filter leads: the page's all-projects form, or null when the page has none yet. */
export function clearProjectHref(
  location: { pathname: string; search: string },
  forms: Readonly<Record<string, string>> = ALL_PROJECTS_FORMS,
): string | null {
  if (projectOf(location.pathname) === null) return null;
  const all = forms[pageSuffix(location.pathname)];
  return all === undefined ? null : `${all}${keptFilters(location.search)}`;
}

const SERVER_TITLES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(ALL_PROJECTS_FORMS).map(([suffix, form]) => [form.replace(/\/+$/, ''), PROJECT_PAGES.find((page) => page.suffix === suffix)?.label ?? 'Not found'])),
  [PROJECTS_PATH]: 'Projects',
  ...Object.fromEntries(ADMIN_PAGES.flatMap((page) => [page, ...(page.children ?? [])]).map((page) => [page.to, page.label])),
};

/** The page a path shows, in the words of the nav. A member reads `/access` for their own machines. */
export function titleOf(pathname: string, role: 'admin' | 'member' = 'admin'): string {
  if (role === 'member' && pathname.replace(/\/+$/, '') === MY_MACHINES_PATH) return 'My machines';
  if (projectOf(pathname) !== null) {
    const suffix = pageSuffix(pathname);
    return PROJECT_PAGES.find((page) => page.suffix === suffix)?.label ?? 'Not found';
  }
  return SERVER_TITLES[pathname.replace(/\/+$/, '')] ?? 'Not found';
}
