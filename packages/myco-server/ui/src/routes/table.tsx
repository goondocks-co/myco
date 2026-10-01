import type { RouteObject } from 'react-router-dom';
import { Join } from '../pages/Join';
import { LinkPage } from '../pages/Link';
import { NotFound } from '../pages/NotFound';
import { Projects } from '../pages/Projects';
import { adminRoutes } from './admin';
import { knowledgeRoutes } from './knowledge';
import { movedRoutes } from './moved';
import { sessionRoutes } from './sessions';
import { Shell } from './Shell';
import { ResumePendingLink, Today } from './today';
import { workRoutes } from './work';

/**
 * Every route the dashboard answers, as the one table `App` renders: sign-in's two pages, the addresses that moved,
 * and, inside the shell, every page. The feature ledger reads its paths (`docs/architecture/myco-2.0.md` §7.2).
 */
export const ROUTES: RouteObject[] = [
  { path: '/link', element: <LinkPage /> },
  { path: '/join', element: <Join /> },
  ...movedRoutes,
  {
    element: <ResumePendingLink />,
    children: [{
      element: <Shell />,
      children: [
        { path: '/', element: <Today /> },
        { path: '/projects', element: <Projects /> },
        { path: '/p/:projectId', element: <Today /> },
        ...sessionRoutes,
        ...knowledgeRoutes,
        ...workRoutes,
        ...adminRoutes,
        { path: '*', element: <NotFound /> },
      ],
    }],
  },
];

/** Every path a route table answers at, nested routes included. */
export function routePaths(routes: readonly RouteObject[] = ROUTES): string[] {
  return routes.flatMap((route) => [...(route.path === undefined ? [] : [route.path]), ...routePaths(route.children ?? [])]);
}
