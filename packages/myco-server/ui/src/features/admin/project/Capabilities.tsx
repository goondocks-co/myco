import { useState } from 'react';
import { allTasksReadRepository, REPOSITORY_TASKS } from '@goondocks/myco-shared/repository';
import { useProjects } from '../../../hooks/use-projects';
import { useTaskDescriptions } from '../../../hooks/use-tasks';
import { ActionLink, Disclosure, ErrorState, LoadingState, Switch } from '../../../design';
import { settingsRefusalText, useCapabilities, useRepository, useSettingsActions } from '../../../hooks/use-settings';
import { PROJECT_SETTINGS_ANCHORS, projectRepositoryPath } from '../../../routes/nav';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import type { RepositoryRow } from './wire';
import type { TaskDescription } from '../../tasks/wire';

/** What each capability does in a project, in the reader's words. */
const CAPABILITY_WORDS: Readonly<Record<string, { label: string; note: string }>> = {
  cortex: { label: 'Context for sessions', note: 'Sessions here are handed the instructions at start, and spores and plans on their prompts.' },
  canopy: { label: 'Code map', note: 'Myco keeps a map of where things live in this project’s code, from its repository.' },
  vault_evolution: { label: 'Learning', note: 'Myco learns spores from this project’s sessions and keeps them current.' },
};

function repositoryName(connection: RepositoryRow): string {
  const parts = new URL(connection.url).pathname.replace(/\/$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

/** One capability's switch, saving as it is flipped and saying why when the server refuses. */
function CapabilityRow({ projectId, capability, enabled, repository, repositoryState, tasks, taskState }: {
  projectId: string; capability: string; enabled: boolean;
  repository: RepositoryRow | null | undefined; repositoryState: 'ready' | 'loading' | 'error';
  tasks: readonly TaskDescription[] | undefined; taskState: 'ready' | 'loading' | 'error';
}) {
  const actions = useSettingsActions();
  const [error, setError] = useState<string | null>(null);
  const words = CAPABILITY_WORDS[capability] ?? { label: capability, note: undefined };
  const id = `capability-${capability}`;
  // The tasks a person can run under this capability; a stage another task pulls, like turn cards for learning, is part of it.
  const capabilityTasks = tasks?.filter((task) => task.capability === capability && task.startable) ?? [];
  const repositoryTasks = capabilityTasks.filter((task) => REPOSITORY_TASKS.includes(task.task));
  const independentTasks = capabilityTasks.filter((task) => !REPOSITORY_TASKS.includes(task.task));
  const readsRepository = repositoryTasks.length > 0;
  const allNeedRepository = allTasksReadRepository(capabilityTasks.map((task) => task.task));
  const missingNote = allNeedRepository ? 'Needs this project’s repository to read its code.'
    : `Can run ${independentTasks.map((task) => task.name).join(', ')} ${enabled ? 'now' : 'when enabled'}; connect the repository to also run ${repositoryTasks.map((task) => task.name).join(', ')}.`;
  const missingStatus = allNeedRepository ? 'On · Code tasks cannot run until a repository is connected'
    : 'On · Some tasks need a repository';
  const missingRepository = taskState === 'ready' && readsRepository && repositoryState === 'ready' && repository === null;
  const repositoryNote = taskState === 'loading' ? 'Checking task requirements.'
    : taskState === 'error' ? 'Couldn’t check task requirements.'
      : !readsRepository ? null
    : repositoryState === 'loading' ? 'Checking this project’s repository.'
      : repositoryState === 'error' ? 'Couldn’t check this project’s repository.'
        : repository === null ? missingNote
          : repository === undefined ? 'Couldn’t check this project’s repository.'
            : `Reads ${repositoryName(repository)} @ ${repository.branch}`;
  const enabledStatus = taskState === 'loading' ? 'On · Checking task requirements'
    : taskState === 'error' ? 'On · Task requirements unavailable'
      : readsRepository && repositoryState === 'loading' ? 'On · Checking repository'
    : readsRepository && repositoryState === 'error' ? 'On · Repository status unavailable'
      : missingRepository ? missingStatus : 'On';
  return (
    <SettingRow
      inline
      setting={`capability.${capability}`}
      label={words.label}
      htmlFor={id}
      note={<>{words.note}{repositoryNote !== null && <span className="block">{repositoryNote}</span>}</>}
      status={error ?? (enabled ? enabledStatus : 'Off')}
      refused={error !== null}
      details={enabled && missingRepository && <ActionLink to={projectRepositoryPath(projectId, true)}>Connect repository</ActionLink>}
      control={(
        <Switch
          id={id}
          aria-label={words.label}
          checked={enabled}
          disabled={actions.setCapability.isPending}
          onCheckedChange={(checked) => {
            setError(null);
            actions.setCapability.mutate({ projectId, capability, enabled: checked }, { onError: (err) => setError(settingsRefusalText(err)) });
          }}
        />
      )}
    />
  );
}

/** What Myco does in a project: a switch per capability. */
export function Capabilities({ projectId }: { projectId: string }) {
  const caps = useCapabilities(projectId);
  const tasks = useTaskDescriptions(projectId);
  const repository = useRepository(projectId);
  const projects = useProjects();
  const archived = projects.data?.projects.find((project) => project.projectId === projectId)?.archivedAt != null;
  return (
    <AdminSection id={PROJECT_SETTINGS_ANCHORS.capabilities} title="What Myco does here" description={archived ? undefined : "Each switch saves as you flip it."}>
      {archived ? <fieldset disabled><p className="t-small text-muted">Archived: Myco does no work here until it's restored</p></fieldset>
        : caps.isPending ? <LoadingState label="Loading what Myco does here" count={4} />
        : caps.isError ? <ErrorState error={caps.error} onRetry={() => void caps.refetch()} />
        : (
          <>
            <RowCard label="What Myco does here">
              {Object.entries(caps.data.capabilities).filter(([capability]) => Object.hasOwn(CAPABILITY_WORDS, capability)).map(([capability, enabled]) => (
                <CapabilityRow
                  key={capability} projectId={projectId} capability={capability} enabled={enabled}
                  repository={repository.isSuccess ? repository.data.repository : undefined}
                  repositoryState={repository.isSuccess ? 'ready' : repository.isError ? 'error' : 'loading'}
                  tasks={tasks.data?.tasks}
                  taskState={tasks.isSuccess ? 'ready' : tasks.isError ? 'error' : 'loading'}
                />
              ))}
            </RowCard>

            {Object.keys(caps.data.retiredCapabilities ?? {}).length > 0 && (
              <Disclosure summary="Older capabilities">
                <p className="t-small text-muted">Stored admissions for capabilities Myco no longer uses. Skills ship with Myco.</p>
                {Object.entries(caps.data.retiredCapabilities ?? {}).map(([capability, enabled]) => (
                  <p key={capability} data-retired-capability={capability} className="t-small">{capability}: {enabled ? 'On' : 'Off'}</p>
                ))}
              </Disclosure>
            )}
          </>
        )}
    </AdminSection>
  );
}
