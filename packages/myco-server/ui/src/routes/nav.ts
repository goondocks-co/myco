import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import {
  Activity, Bot, MessageSquare, Settings2, SlidersHorizontal, Sprout, Sun, Users, type LucideIcon,
} from 'lucide-react';

/** A page under a project, reached at `/p/:project<suffix>`. */
export interface ProjectPage {
  label: string;
  icon: LucideIcon;
  /** The path after `/p/:project`; the empty string is the project's home. */
  suffix: string;
  /** Shown only to an admin: every route behind the page is an admin's. */
  admin?: true;
  /** The other paths under a project that belong to this page: its sections and the records it lists. */
  also?: readonly string[];
}

/** Knowledge under a project: its spores. */
export const KNOWLEDGE_SUFFIX = '/knowledge';
/** Knowledge's plans board under a project. */
export const PLANS_SUFFIX = '/knowledge/plans';
/** Knowledge's code map under a project. */
export const CODE_MAP_SUFFIX = '/knowledge/map';
/** A spore's article under a project, as `/p/:project/spores/:sporeId`. */
export const SPORE_SUFFIX = '/spores';
/** A plan's page under a project, as `/p/:project/plans/:planKey`. */
export const PLAN_SUFFIX = '/plans';
/** Myco's work under a project: what its own runs came to. */
export const WORK_SUFFIX = '/work';
/** The descriptions of Myco’s tasks under its work. */
export const TASKS_SUFFIX = '/work/tasks';
/** One run of Myco's work under a project, as `/p/:project/work/runs/:runId`. */
export const RUN_SUFFIX = '/work/runs';
/** A project's settings: what Myco does there, its repository, its access keys and release tracking. */
export const PROJECT_SETTINGS_SUFFIX = '/settings';

/** Where each part of a project's settings sits on its page. */
export const PROJECT_SETTINGS_ANCHORS = {
  capabilities: 'capabilities',
  repository: 'repository',
  accessKeys: 'access-keys',
  releases: 'release-tracking',
} as const;

/** The pages under a project, in nav order. */
export const PROJECT_PAGES: readonly ProjectPage[] = [
  { label: 'Today', icon: Sun, suffix: '' },
  { label: 'Sessions', icon: MessageSquare, suffix: '/sessions' },
  { label: 'Knowledge', icon: Sprout, suffix: KNOWLEDGE_SUFFIX, also: [PLANS_SUFFIX, CODE_MAP_SUFFIX, SPORE_SUFFIX, PLAN_SUFFIX] },
  { label: 'Myco’s work', icon: Bot, suffix: WORK_SUFFIX, also: [RUN_SUFFIX, TASKS_SUFFIX] },
  { label: 'Project settings', icon: SlidersHorizontal, suffix: PROJECT_SETTINGS_SUFFIX, admin: true },
];

/** Whether a page's suffix, or one of the paths that belong to it, is this one. */
function owns(page: ProjectPage, suffix: string): boolean {
  return page.suffix === suffix || (page.also ?? []).includes(suffix);
}

/** The nav page a suffix belongs to. */
export function pageOf(suffix: string): ProjectPage | undefined {
  return PROJECT_PAGES.find((page) => owns(page, suffix));
}

/**
 * Where a record's list lives: a spore's article belongs to the spores, a
 * plan's page to the plans board, a run to Myco's work. A switch or a clear of the project from a
 * record leads to its list.
 */
const LIST_OF: Readonly<Record<string, string>> = { [SPORE_SUFFIX]: KNOWLEDGE_SUFFIX, [PLAN_SUFFIX]: PLANS_SUFFIX, [RUN_SUFFIX]: WORK_SUFFIX };

function listSuffix(pathname: string): string {
  const suffix = pageSuffix(pathname);
  return LIST_OF[suffix] ?? suffix;
}

/**
 * Whether a nav page is the one open: its own path or one of the paths that
 * belong to it, under a project or in its all-projects form.
 */
export function pageIsOpen(page: ProjectPage, pathname: string, forms: Readonly<Record<string, string>> = ALL_PROJECTS_FORMS): boolean {
  if (projectOf(pathname) !== null) return owns(page, pageSuffix(pathname));
  const suffix = allProjectsSuffix(pathname, forms);
  return suffix !== null && owns(page, suffix);
}

/** The pages on a phone's bottom bar; the rest are under More. */
export const PHONE_PAGES: readonly ProjectPage[] = PROJECT_PAGES.slice(0, 3);

/** A page for the whole server. */
export interface ServerPage {
  label: string;
  icon: LucideIcon;
  to: string;
}

/** Who is a member, and the machines that write here. */
export const PEOPLE_PATH = '/people';
/** The server's settings, in five sections. */
export const SETTINGS_PATH = '/settings';
/**
 * The one page on the server's health. `/health` is the server's own liveness
 * route on both targets, so the page lives under `/status`.
 */
export const HEALTH_PATH = '/status/health';

/** Where each part of Health sits on its page. */
export const HEALTH_ANCHORS = {
  needsYou: 'needs-you',
  status: 'status',
  workers: 'workers',
  backups: 'backups',
  upkeep: 'upkeep',
  measures: 'measures',
} as const;

/** The five sections of Settings, each at its own address; the first is Settings itself. */
export const SETTINGS_SECTIONS = [
  { id: 'work', label: 'Myco’s work', to: SETTINGS_PATH },
  { id: 'models', label: 'Models and keys', to: `${SETTINGS_PATH}/models` },
  { id: 'capture', label: 'Capture and retention', to: `${SETTINGS_PATH}/capture` },
  { id: 'backups', label: 'Backups', to: `${SETTINGS_PATH}/backups` },
  { id: 'access', label: 'Sign-in and access', to: `${SETTINGS_PATH}/access` },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/**
 * The nav foot: the server's admin pages. A member who is not an admin sees
 * none of them. Health carries the count of what needs an admin.
 */
export const ADMIN_PAGES: readonly ServerPage[] = [
  { label: INVITE_CONTROLS.page, icon: Users, to: PEOPLE_PATH },
  { label: 'Settings', icon: Settings2, to: SETTINGS_PATH },
  { label: 'Health', icon: Activity, to: HEALTH_PATH },
];

/** Every project, listed with its session count. */
export const PROJECTS_PATH = '/projects';

/** The page every member's own machines are listed on. */
export const MY_MACHINES_PATH = '/me/machines';

/**
 * The pages that have an all-projects form, by the suffix of their per-project
 * one. The scope switcher offers "All projects" only on one of these: until a page
 * has a form that spans every project, there is nothing to lead it to.
 */
export const ALL_PROJECTS_FORMS: Readonly<Record<string, string>> = {
  '': '/',
  '/sessions': '/sessions',
  [KNOWLEDGE_SUFFIX]: KNOWLEDGE_SUFFIX,
  [PLANS_SUFFIX]: PLANS_SUFFIX,
  [WORK_SUFFIX]: WORK_SUFFIX,
  [TASKS_SUFFIX]: TASKS_SUFFIX,
};

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
export const FILTER_KEYS: readonly string[] = ['q', 'agent', 'member', 'type', 'status', 'state', 'window', 'branch', 'day', 'outcome'];

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
  const long = PROJECT_PAGES.flatMap((p) => [p.suffix, ...(p.also ?? [])]).filter((suffix) => suffix.split('/').length > 2);
  const whole = long.find((suffix) => rest === suffix || rest.startsWith(`${suffix}/`));
  if (whole !== undefined) return whole;
  const section = match[2] ?? '';
  return section === '' ? '' : `/${section}`;
}

/** `/p/:project<suffix>`, with the project id encoded. */
export function projectPath(projectId: string, suffix = ''): string {
  return `/p/${encodeURIComponent(projectId)}${suffix}`;
}

/** Where one run of Myco's work opens: its panel over the project's work. */
export function runPath(projectId: string, runId: string): string {
  return projectPath(projectId, `${RUN_SUFFIX}/${encodeURIComponent(runId)}`);
}

/** The filters of a query string, in the order they were given. */
export function keptFilters(search: string): string {
  const kept = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) if (FILTER_KEYS.includes(key)) kept.append(key, value);
  const out = kept.toString();
  return out === '' ? '' : `?${out}`;
}

/**
 * Where picking a project in the scope switcher leads: the same page under that
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
  return `${projectPath(projectId, listSuffix(location.pathname))}${keptFilters(location.search)}`;
}

/** Where "All projects" in the scope switcher leads: the page's all-projects form, or null when the page has none yet. */
export function clearProjectHref(
  location: { pathname: string; search: string },
  forms: Readonly<Record<string, string>> = ALL_PROJECTS_FORMS,
): string | null {
  if (projectOf(location.pathname) === null) return null;
  const all = forms[listSuffix(location.pathname)];
  return all === undefined ? null : `${all}${keptFilters(location.search)}`;
}

const SERVER_TITLES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(ALL_PROJECTS_FORMS).map(([suffix, form]) => [form.replace(/\/+$/, ''), pageOf(suffix)?.label ?? 'Not found'])),
  [PROJECTS_PATH]: 'Projects',
  [MY_MACHINES_PATH]: 'My machines',
  ...Object.fromEntries(ADMIN_PAGES.map((page) => [page.to, page.label])),
  ...Object.fromEntries(SETTINGS_SECTIONS.map((section) => [section.to, 'Settings'])),
};

/** The page a path shows, in the words of the nav. */
export function titleOf(pathname: string): string {
  if (projectOf(pathname) !== null) {
    return pageOf(pageSuffix(pathname))?.label ?? 'Not found';
  }
  return SERVER_TITLES[pathname.replace(/\/+$/, '')] ?? 'Not found';
}
