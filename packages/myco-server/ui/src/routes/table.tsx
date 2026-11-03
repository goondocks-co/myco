import { ROUTESPaths } from './declarations';
import { Device } from '../pages/Device';
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
  { path: ROUTESPaths.device, element: <Device /> },
  { path: ROUTESPaths.link, element: <LinkPage /> },
  { path: ROUTESPaths.join, element: <Join /> },
  ...movedRoutes,
  {
    element: <ResumePendingLink />,
    children: [{
      element: <Shell />,
      children: [
        { path: ROUTESPaths.today, element: <Today /> },
        { path: ROUTESPaths.projects, element: <Projects /> },
        { path: ROUTESPaths.project, element: <Today /> },
        ...sessionRoutes,
        ...knowledgeRoutes,
        ...workRoutes,
        ...adminRoutes,
        { path: ROUTESPaths.missing, element: <NotFound /> },
      ],
    }],
  },
];

export { routePaths } from './declarations';
