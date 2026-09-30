import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import {
  Activity, Bot, Gauge, KeyRound, LayoutDashboard, ListChecks, MessageSquare, Settings2, Sprout, Users, Wrench, type LucideIcon,
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

/** The pages under a project, in nav order. */
export const PROJECT_PAGES: readonly ProjectPage[] = [
  { label: 'Overview', icon: LayoutDashboard, suffix: '' },
  { label: 'Sessions', icon: MessageSquare, suffix: '/sessions' },
  { label: 'Spores', icon: Sprout, suffix: '/spores' },
  { label: 'Plans', icon: ListChecks, suffix: '/plans' },
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
}

/** The nav foot: the server's admin pages. A member who is not an admin sees none of them. */
export const ADMIN_PAGES: readonly ServerPage[] = [
  { label: INVITE_CONTROLS.page, icon: Users, to: '/access' },
  { label: 'Settings', icon: Settings2, to: '/settings' },
  { label: 'Status', icon: Activity, to: '/status' },
  { label: 'Measures', icon: Gauge, to: '/measures' },
  { label: 'Operations', icon: Wrench, to: '/operations' },
];

/** Every project, listed with its session count. */
export const PROJECTS_PATH = '/projects';

/** The page a member's own machines are listed on. */
export const MY_MACHINES_PATH = '/access';

/**
 * The pages that have an all-projects form, by the suffix of their per-project
 * one. Clearing the project filter on one of these lands on its all-projects
 * form; on any other page it lands on the Projects list.
 */
const ALL_PROJECTS_FORMS: Readonly<Record<string, string>> = {};

/**
 * The query parameters that filter a list. They survive a change of project, so
 * a filtered list stays filtered; anything else (the open tab, the turn, the
 * page offset) belongs to the record or the page left behind and is dropped.
 */
export const FILTER_KEYS: readonly string[] = ['q', 'agent', 'member', 'type', 'status', 'state', 'window', 'branch'];

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

/** The page under a project a path is on (`/sessions`, `/runs`), without the record it names, or '' for the project's home. */
export function pageSuffix(pathname: string): string {
  const section = PROJECT_PATH.exec(pathname)?.[2] ?? '';
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
 * From a page that spans the server, it leads to the project's home.
 */
export function switchProjectHref(location: { pathname: string; search: string }, projectId: string): string {
  if (projectOf(location.pathname) === null) return projectPath(projectId);
  return `${projectPath(projectId, pageSuffix(location.pathname))}${keptFilters(location.search)}`;
}

/** Where clearing the project filter leads: the page's all-projects form, or the Projects list where there is none yet. */
export function clearProjectHref(location: { pathname: string; search: string }): string {
  const all = ALL_PROJECTS_FORMS[pageSuffix(location.pathname)];
  return all === undefined ? PROJECTS_PATH : `${all}${keptFilters(location.search)}`;
}

const SERVER_TITLES: Readonly<Record<string, string>> = {
  [PROJECTS_PATH]: 'Projects',
  ...Object.fromEntries(ADMIN_PAGES.map((page) => [page.to, page.label])),
};

/** The page a path shows, in the words of the nav. */
export function titleOf(pathname: string): string {
  if (projectOf(pathname) !== null) {
    const suffix = pageSuffix(pathname);
    return PROJECT_PAGES.find((page) => page.suffix === suffix)?.label ?? 'Not found';
  }
  return SERVER_TITLES[pathname.replace(/\/+$/, '')] ?? 'Not found';
}
