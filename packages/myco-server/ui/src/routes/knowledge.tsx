import { Navigate, Route, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { CodeMap } from '../features/knowledge/CodeMap';
import { KnowledgeFrame, type KnowledgeSection } from '../features/knowledge/KnowledgeFrame';
import { PlanPage } from '../features/knowledge/PlanPage';
import { PlansBoard } from '../features/knowledge/PlansBoard';
import { SporeArticle } from '../features/knowledge/SporeArticle';
import { SporeStream } from '../features/knowledge/SporeStream';
import { NotFound } from '../pages/NotFound';
import { KNOWLEDGE_SUFFIX, keptFilters, PLANS_SUFFIX, projectPath } from './nav';
import { useRouteProject } from './route-project';

/**
 * The Knowledge routes: the spore stream and the plans board across every
 * project at `/knowledge` and `/knowledge/plans`, each narrowed to one at
 * `/p/:projectId/knowledge…`, a project's code map, a spore's article and a
 * plan's page. `/spores`, `/plans` and their forms under a project lead to the
 * stream and the board, the list's filters kept.
 */
export const knowledgeRoutes = (
  <>
    <Route path={KNOWLEDGE_SUFFIX} element={<KnowledgeRoute section="spores" />} />
    <Route path={PLANS_SUFFIX} element={<KnowledgeRoute section="plans" />} />
    <Route path={`/p/:projectId${KNOWLEDGE_SUFFIX}`} element={<KnowledgeRoute section="spores" />} />
    <Route path={`/p/:projectId${PLANS_SUFFIX}`} element={<KnowledgeRoute section="plans" />} />
    <Route path="/p/:projectId/knowledge/map" element={<KnowledgeRoute section="map" />} />
    <Route path="/p/:projectId/spores/:sporeId" element={<SporeRoute />} />
    <Route path="/p/:projectId/plans/:planKey" element={<PlanRoute />} />
    <Route path="/spores" element={<Moved suffix={KNOWLEDGE_SUFFIX} />} />
    <Route path="/plans" element={<Moved suffix={PLANS_SUFFIX} />} />
    <Route path="/p/:projectId/spores" element={<Moved suffix={KNOWLEDGE_SUFFIX} />} />
    <Route path="/p/:projectId/plans" element={<Moved suffix={PLANS_SUFFIX} />} />
  </>
);

function KnowledgeRoute({ section }: { section: KnowledgeSection }) {
  const { projectId, known, projectName } = useRouteProject();
  if (!known || (section === 'map' && projectId === null)) return <NotFound />;
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
  const { projectId, known, projectName } = useRouteProject();
  if (!known || projectId === null) return <NotFound />;
  return <SporeArticle key={`${projectId}/${sporeId}`} projectId={projectId} sporeId={sporeId} projectName={projectName(projectId)} />;
}

function PlanRoute() {
  const { planKey = '' } = useParams();
  const [params] = useSearchParams();
  const { projectId, known, projectName } = useRouteProject();
  if (!known || projectId === null) return <NotFound />;
  return <PlanPage key={`${projectId}/${planKey}`} projectId={projectId} planKey={planKey} sessionHint={params.get('session')} projectName={projectName(projectId)} />;
}

/** A list's other address, sent to the list under the same project and with its filters. */
function Moved({ suffix }: { suffix: string }) {
  const { projectId } = useParams();
  const { search } = useLocation();
  const to = projectId === undefined ? suffix : projectPath(projectId, suffix);
  return <Navigate to={`${to}${keptFilters(search)}`} replace />;
}
