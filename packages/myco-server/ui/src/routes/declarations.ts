export const KNOWLEDGE_SUFFIX = '/knowledge';
export const PLANS_SUFFIX = '/knowledge/plans';
export const CODE_MAP_SUFFIX = '/knowledge/map';
export const SPORE_SUFFIX = '/spores';
export const PLAN_SUFFIX = '/plans';
export const WORK_SUFFIX = '/work';
export const TASKS_SUFFIX = '/work/tasks';
export const RUN_SUFFIX = '/work/runs';
export const PROJECT_SETTINGS_SUFFIX = '/settings';
export const PEOPLE_PATH = '/people';
/** Myco's work's tabs that span the server: the machines that run it, and every run it finished. */
export const RUNNERS_PATH = '/work/runners';
export const RUNS_PATH = '/work/history';
export const SETTINGS_PATH = '/settings';
export const HEALTH_PATH = '/status/health';
export const MY_MACHINES_PATH = '/me/machines';
/** "Is Myco helping?": the measures of what Myco serves and how it is used, across the server. */
export const MEASURES_PATH = '/measures';
export const SETTINGS_SECTIONS = [
  { id: 'work', label: 'Myco’s work', to: SETTINGS_PATH },
  { id: 'people', label: 'People and machines', to: `${SETTINGS_PATH}/people` },
  { id: 'repositories', label: 'Repositories', to: `${SETTINGS_PATH}/repositories` },
  { id: 'models', label: 'Models', to: `${SETTINGS_PATH}/models` },
  { id: 'connections', label: 'Connections', to: `${SETTINGS_PATH}/connections` },
  { id: 'advanced', label: 'Advanced', to: `${SETTINGS_PATH}/advanced` },
] as const;
/** Settings sections that no longer have a tab, each leading to the section that holds its settings now. */
export const MOVED_SETTINGS_SECTIONS = [
  { from: `${SETTINGS_PATH}/capture`, to: 'advanced' },
  { from: `${SETTINGS_PATH}/backups`, to: 'advanced', anchor: 'backups' },
  { from: `${SETTINGS_PATH}/access`, to: 'people' },
] as const satisfies ReadonlyArray<{ from: string; to: (typeof SETTINGS_SECTIONS)[number]['id']; anchor?: string }>;

export const adminRoutesPaths = {
  runs: RUNS_PATH,
  runners: RUNNERS_PATH,
  runner: `${RUNNERS_PATH}/:runnerId`,
  people: PEOPLE_PATH,
  machines: MY_MACHINES_PATH,
  projectSettings: `/p/:projectId${PROJECT_SETTINGS_SUFFIX}`,
  health: HEALTH_PATH,
} as const;

export const knowledgeRoutesPaths = {
  spores: KNOWLEDGE_SUFFIX,
  plans: PLANS_SUFFIX,
  projectSpores: `/p/:projectId${KNOWLEDGE_SUFFIX}`,
  projectPlans: `/p/:projectId${PLANS_SUFFIX}`,
  map: '/p/:projectId/knowledge/map',
  spore: '/p/:projectId/spores/:sporeId',
  plan: '/p/:projectId/plans/:planKey',
} as const;

export const workRoutesPaths = {
  tasks: TASKS_SUFFIX,
  projectTasks: `/p/:projectId${TASKS_SUFFIX}`,
  work: WORK_SUFFIX,
  projectWork: `/p/:projectId${WORK_SUFFIX}`,
  run: `/p/:projectId${RUN_SUFFIX}/:runId`,
} as const;

export const sessionRoutesPaths = {
  sessions: '/sessions',
  projectSessions: '/p/:projectId/sessions',
  session: '/p/:projectId/sessions/:sessionId',
} as const;

export const ROUTESPaths = {
  device: '/device',
  link: '/link',
  join: '/join',
  today: '/',
  projects: '/projects',
  measures: MEASURES_PATH,
  project: '/p/:projectId',
  missing: '*',
} as const;

export const movedPaths = {
  notifications: '/notifications',
  spores: '/spores',
  plans: '/plans',
  projectSpores: '/p/:projectId/spores',
  projectPlans: '/p/:projectId/plans',
  runs: '/p/:projectId/runs',
  run: '/p/:projectId/runs/:runId',
  access: '/access',
  projectAccess: '/p/:projectId/access',
  status: '/status',
  operations: '/operations',
  serverRuns: '/runs',
  serverRunners: '/runners',
  serverRunner: '/runners/:runnerId',
} as const;
export function routeGroup<P extends Record<string, string>, E extends Record<keyof P, unknown>>(paths: P, elements: E) {
  return Object.entries(paths).map(([key, path]) => ({ path, element: elements[key as keyof E] }));
}

interface RouteNode { path?: string; children?: readonly RouteNode[] }
const declaredPaths = [ROUTESPaths, adminRoutesPaths, knowledgeRoutesPaths, workRoutesPaths, sessionRoutesPaths, movedPaths];
export function routePaths(routes: readonly RouteNode[] = [
  ...declaredPaths.flatMap(group => Object.values(group).map(path => ({ path }))),
  ...SETTINGS_SECTIONS.map(section => ({ path: section.to })),
  ...MOVED_SETTINGS_SECTIONS.map(section => ({ path: section.from })),
], parent = ''): string[] {
  return routes.flatMap(route => {
    const full = route.path === undefined ? parent : route.path.startsWith('/') || !parent ? route.path : parent.replace(/\/+$/, '') + '/' + route.path;
    return [...(route.path === undefined ? [] : [full]), ...routePaths(route.children ?? [], full)];
  });
}
