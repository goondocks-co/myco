import { TabLinks } from '../../design';
import { projectPath, RUNNERS_PATH, RUNS_PATH, TASKS_SUFFIX, WORK_SUFFIX } from '../../routes/nav';

/** Myco's work's sections, each at its own address. */
export type WorkSection = 'overview' | 'tasks' | 'runs' | 'runners';

/**
 * The tabs between what Myco is doing and did, its tasks, every run it finished, and the machines that run it. Runs
 * and runners span the server; from a project, Runs opens narrowed to it.
 */
export function WorkTabs({ projectId, section }: { projectId: string | null; section: WorkSection }) {
  const scoped = (suffix: string) => (projectId === null ? suffix : projectPath(projectId, suffix));
  return (
    <TabLinks
      label="Myco’s work sections"
      items={[
        { to: scoped(WORK_SUFFIX), label: 'Overview', active: section === 'overview' },
        { to: scoped(TASKS_SUFFIX), label: 'Tasks', active: section === 'tasks' },
        { to: projectId === null ? RUNS_PATH : `${RUNS_PATH}?project=${encodeURIComponent(projectId)}`, label: 'Runs', active: section === 'runs' },
        { to: RUNNERS_PATH, label: 'Runners', active: section === 'runners' },
      ]}
    />
  );
}
