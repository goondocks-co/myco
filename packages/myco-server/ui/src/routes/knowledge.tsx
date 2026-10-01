import { useParams, type RouteObject } from 'react-router-dom';
import { CodeMap } from '../features/knowledge/CodeMap';
import { KnowledgeFrame, type KnowledgeSection } from '../features/knowledge/KnowledgeFrame';
import { PlanPage } from '../features/knowledge/PlanPage';
import { PlansBoard } from '../features/knowledge/PlansBoard';
import { SporeArticle } from '../features/knowledge/SporeArticle';
import { SporeStream } from '../features/knowledge/SporeStream';
import { NotFound } from '../pages/NotFound';
import { KNOWLEDGE_SUFFIX, PLANS_SUFFIX } from './nav';
import { useRouteProject } from './route-project';

/**
 * The Knowledge routes: the spore stream and the plans board across every
 * project at `/knowledge` and `/knowledge/plans`, each narrowed to one at
 * `/p/:projectId/knowledge…`, a project's code map, a spore's article and a
 * plan's page. The older Spores and Plans addresses that lead here are in
 * `routes/moved.tsx`.
 */
export const knowledgeRoutes: RouteObject[] = [
  { path: KNOWLEDGE_SUFFIX, element: <KnowledgeRoute section="spores" /> },
  { path: PLANS_SUFFIX, element: <KnowledgeRoute section="plans" /> },
  { path: `/p/:projectId${KNOWLEDGE_SUFFIX}`, element: <KnowledgeRoute section="spores" /> },
  { path: `/p/:projectId${PLANS_SUFFIX}`, element: <KnowledgeRoute section="plans" /> },
  { path: '/p/:projectId/knowledge/map', element: <KnowledgeRoute section="map" /> },
  { path: '/p/:projectId/spores/:sporeId', element: <SporeRoute /> },
  { path: '/p/:projectId/plans/:planKey', element: <PlanRoute /> },
];

function KnowledgeRoute({ section }: { section: KnowledgeSection }) {
  const { projectId, standIn, projectName } = useRouteProject();
  if (standIn !== null) return standIn;
  if (section === 'map' && projectId === null) return <NotFound />;
  return (
    <KnowledgeFrame projectId={projectId} projectName={projectId === null ? null : projectName(projectId)} section={section}>
      {section === 'spores' && <SporeStream key={projectId ?? ''} projectId={projectId} projectName={projectName} />}
      {section === 'plans' && <PlansBoard key={projectId ?? ''} projectId={projectId} projectName={projectName} />}
      {section === 'map' && projectId !== null && <CodeMap projectId={projectId} />}
    </KnowledgeFrame>
  );
}

function SporeRoute() {
  const { sporeId = '' } = useParams();
  const { projectId, standIn, projectName } = useRouteProject();
  if (standIn !== null) return standIn;
  if (projectId === null) return <NotFound />;
  return <SporeArticle key={`${projectId}/${sporeId}`} projectId={projectId} sporeId={sporeId} projectName={projectName(projectId)} />;
}

function PlanRoute() {
  const { planKey = '' } = useParams();
  const { projectId, standIn, projectName } = useRouteProject();
  if (standIn !== null) return standIn;
  if (projectId === null) return <NotFound />;
  return <PlanPage key={`${projectId}/${planKey}`} projectId={projectId} planKey={planKey} projectName={projectName(projectId)} />;
}
