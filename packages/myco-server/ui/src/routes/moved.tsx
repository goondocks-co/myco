import { movedPaths } from './declarations';
import { Navigate, useLocation, useParams, type RouteObject } from 'react-router-dom';
import { useIsAdmin } from '../hooks/use-me';
import {
  HEALTH_ANCHORS, HEALTH_PATH, keptFilters, KNOWLEDGE_SUFFIX, PEOPLE_SETTINGS_PATH, PLANS_SUFFIX, PROJECT_SETTINGS_ANCHORS,
  PROJECT_SETTINGS_SUFFIX, projectPath, RUN_SUFFIX, RUNNERS_PATH, runnerPath, RUNS_PATH, WORK_SUFFIX,
} from './nav';

/** What an old address carries that its new one keeps: its path's parts, its query string, and who is asking. */
export interface MovedFrom {
  params: Readonly<Record<string, string | undefined>>;
  search: string;
  admin: boolean;
}

export interface MovedAddress {
  /** The address a link may still carry, as a route path. */
  from: string;
  /** Where it leads now. */
  to: (at: MovedFrom) => string;
}

const project = (at: MovedFrom): string => at.params.projectId ?? '';

/**
 * Every address the dashboard used to answer at, and where each leads now.
 * Links to them live on in spores, issues and bookmarks, so each is kept for as
 * long as the page it names exists in some form. A list keeps its filters; a
 * record keeps its id.
 */
export const MOVED: readonly MovedAddress[] = [
  // The notifications placeholder: Today is the start.
  { from: movedPaths.notifications, to: () => '/' },
  // Spores and Plans became Knowledge's tabs.
  { from: movedPaths.spores, to: ({ search }) => `${KNOWLEDGE_SUFFIX}${keptFilters(search)}` },
  { from: movedPaths.plans, to: ({ search }) => `${PLANS_SUFFIX}${keptFilters(search)}` },
  { from: movedPaths.projectSpores, to: (at) => `${projectPath(project(at), KNOWLEDGE_SUFFIX)}${keptFilters(at.search)}` },
  { from: movedPaths.projectPlans, to: (at) => `${projectPath(project(at), PLANS_SUFFIX)}${keptFilters(at.search)}` },
  // Agent runs became Myco's work, and a run its panel there.
  { from: movedPaths.runs, to: (at) => `${projectPath(project(at), WORK_SUFFIX)}${at.search}` },
  { from: movedPaths.run, to: (at) => `${projectPath(project(at), `${RUN_SUFFIX}/${encodeURIComponent(at.params.runId ?? '')}`)}${at.search}` },
  // Access became Settings › People and machines; a project's access keys are in its settings.
  { from: movedPaths.access, to: () => PEOPLE_SETTINGS_PATH },
  { from: movedPaths.projectAccess, to: (at) => `${projectPath(project(at), PROJECT_SETTINGS_SUFFIX)}#${PROJECT_SETTINGS_ANCHORS.accessKeys}` },
  // Status, Measures and Operations became parts of Health; a measures window is kept.
  { from: movedPaths.status, to: ({ search }) => `${HEALTH_PATH}${search}#${HEALTH_ANCHORS.status}` },
  { from: movedPaths.measures, to: ({ search }) => `${HEALTH_PATH}${search}#${HEALTH_ANCHORS.measures}` },
  { from: movedPaths.operations, to: ({ search }) => `${HEALTH_PATH}${search}#${HEALTH_ANCHORS.upkeep}` },
  // Runs and Runners became tabs of Myco's work; Runs keeps its filters, a runner its id.
  { from: movedPaths.serverRuns, to: ({ search }) => `${RUNS_PATH}${search}` },
  { from: movedPaths.serverRunners, to: ({ search }) => `${RUNNERS_PATH}${search}` },
  { from: movedPaths.serverRunner, to: ({ params, search }) => `${runnerPath(params.runnerId ?? '')}${search}` },
];

/** Leads a moved address to where its page is now, keeping its fragment unless the destination names one. */
function Moved({ address }: { address: MovedAddress }) {
  const params = useParams();
  const { search, hash } = useLocation();
  const admin = useIsAdmin();
  const to = address.to({ params, search, admin });
  return <Navigate to={to.includes('#') ? to : `${to}${hash}`} replace />;
}

/** One route per old address, each leading to where its page is now. */
export const movedRoutes: RouteObject[] = MOVED.map((address) => ({ path: address.from, element: <Moved address={address} /> }));
