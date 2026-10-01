import { Navigate, useLocation, useParams, type RouteObject } from 'react-router-dom';
import { useIsAdmin } from '../hooks/use-me';
import {
  HEALTH_ANCHORS, HEALTH_PATH, keptFilters, KNOWLEDGE_SUFFIX, MY_MACHINES_PATH, PEOPLE_PATH, PLANS_SUFFIX, PROJECT_SETTINGS_ANCHORS,
  PROJECT_SETTINGS_SUFFIX, projectPath, RUN_SUFFIX, WORK_SUFFIX,
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
  { from: '/notifications', to: () => '/' },
  // Spores and Plans became Knowledge's tabs.
  { from: '/spores', to: ({ search }) => `${KNOWLEDGE_SUFFIX}${keptFilters(search)}` },
  { from: '/plans', to: ({ search }) => `${PLANS_SUFFIX}${keptFilters(search)}` },
  { from: '/p/:projectId/spores', to: (at) => `${projectPath(project(at), KNOWLEDGE_SUFFIX)}${keptFilters(at.search)}` },
  { from: '/p/:projectId/plans', to: (at) => `${projectPath(project(at), PLANS_SUFFIX)}${keptFilters(at.search)}` },
  // Agent runs became Myco's work, and a run its panel there.
  { from: '/p/:projectId/runs', to: (at) => `${projectPath(project(at), WORK_SUFFIX)}${at.search}` },
  { from: '/p/:projectId/runs/:runId', to: (at) => `${projectPath(project(at), `${RUN_SUFFIX}/${encodeURIComponent(at.params.runId ?? '')}`)}${at.search}` },
  // Access became People & machines for an admin and My machines for a member; a project's access keys are in its settings.
  { from: '/access', to: ({ admin }) => (admin ? PEOPLE_PATH : MY_MACHINES_PATH) },
  { from: '/p/:projectId/access', to: (at) => `${projectPath(project(at), PROJECT_SETTINGS_SUFFIX)}#${PROJECT_SETTINGS_ANCHORS.accessKeys}` },
  // Status, Measures and Operations became parts of Health; a measures window is kept.
  { from: '/status', to: ({ search }) => `${HEALTH_PATH}${search}#${HEALTH_ANCHORS.status}` },
  { from: '/measures', to: ({ search }) => `${HEALTH_PATH}${search}#${HEALTH_ANCHORS.measures}` },
  { from: '/operations', to: ({ search }) => `${HEALTH_PATH}${search}#${HEALTH_ANCHORS.upkeep}` },
];

function Moved({ address }: { address: MovedAddress }) {
  const params = useParams();
  const { search } = useLocation();
  const admin = useIsAdmin();
  return <Navigate to={address.to({ params, search, admin })} replace />;
}

/** One route per old address, each leading to where its page is now. */
export const movedRoutes: RouteObject[] = MOVED.map((address) => ({ path: address.from, element: <Moved address={address} /> }));
