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
export const RUNNERS_PATH = '/runners';
export const RUNS_PATH = '/runs';
export const SETTINGS_PATH = '/settings';
export const HEALTH_PATH = '/status/health';
export const MY_MACHINES_PATH = '/me/machines';
export const SETTINGS_SECTIONS = [
  { id: 'work', label: 'Myco’s work', to: SETTINGS_PATH },
  { id: 'models', label: 'Models and keys', to: `${SETTINGS_PATH}/models` },
  { id: 'capture', label: 'Capture and retention', to: `${SETTINGS_PATH}/capture` },
  { id: 'backups', label: 'Backups', to: `${SETTINGS_PATH}/backups` },
  { id: 'access', label: 'Sign-in and access', to: `${SETTINGS_PATH}/access` },
] as const;

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
  measures: '/measures',
  operations: '/operations',
} as const;
export function routeGroup<P extends Record<string, string>, E extends Record<keyof P, unknown>>(paths: P, elements: E) {
  return Object.entries(paths).map(([key, path]) => ({ path, element: elements[key as keyof E] }));
}

interface RouteNode { path?: string; children?: readonly RouteNode[] }
const declaredPaths = [ROUTESPaths, adminRoutesPaths, knowledgeRoutesPaths, workRoutesPaths, sessionRoutesPaths, movedPaths];
export function routePaths(routes: readonly RouteNode[] = [
  ...declaredPaths.flatMap(group => Object.values(group).map(path => ({ path }))),
  ...SETTINGS_SECTIONS.map(section => ({ path: section.to })),
], parent = ''): string[] {
  return routes.flatMap(route => {
    const full = route.path === undefined ? parent : route.path.startsWith('/') || !parent ? route.path : parent.replace(/\/+$/, '') + '/' + route.path;
    return [...(route.path === undefined ? [] : [full]), ...routePaths(route.children ?? [], full)];
  });
}
