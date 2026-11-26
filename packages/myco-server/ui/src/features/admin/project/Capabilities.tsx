import { CURATION_DAILY_LIMIT_SETTING as CURATION_LIMIT } from '@goondocks/myco-shared/settings-contract';
import { useState } from 'react';
import { allTasksRequireRepository, REQUIRED_REPOSITORY_TASKS } from '@goondocks/myco-shared/repository';
import { useProjects } from '../../../hooks/use-projects';
import { useTaskDescriptions } from '../../../hooks/use-tasks';
import { ActionLink, Button, Input, ErrorState, LoadingState, Switch } from '../../../design';
import { isSettingsConflict, settingsRefusalText, useCapabilities, useRepository, useSettingsActions } from '../../../hooks/use-settings';
import { PROJECT_SETTINGS_ANCHORS, projectRepositoryPath } from '../../../routes/nav';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import { useIsAdmin } from '../../../hooks/use-me';
import { CurationPreview } from './CurationPreview';
import { startableEntry } from '../../work/RunTask';
import type { RepositoryRow } from './wire';
import type { TaskDescription } from '../../tasks/wire';

/** What each capability does in a project, in the reader's words. */
export const CAPABILITY_WORDS: Readonly<Record<string, { label: string; note: string }>> = {
  cortex: { label: 'Context for sessions', note: 'Sessions here are handed the instructions at start, and spores and plans on their prompts.' },
  canopy: { label: 'Code map', note: 'Myco keeps a map of where things live in this project’s code, from its repository.' },
  spore_curation: { label: 'Curate overlapping spores', note: 'Myco finds spores that say the same thing or contradict each other, and merges, rewrites or retires them, starting with new or changed spores, up to the daily limit below.' },
  vault_evolution: { label: 'Learning', note: 'Myco learns spores from this project’s sessions and keeps them current.' },
};

/** A task as the page names it in a sentence: "learning from the code". */
const startedName = (task: TaskDescription): string => startableEntry(task.task, task.name).started.toLowerCase();
const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

function repositoryName(connection: RepositoryRow): string {
  const parts = new URL(connection.url).pathname.replace(/\/$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

/** One capability's switch, saving as it is flipped and saying why when the server refuses. */
function CapabilityRow({ projectId, capability, enabled, revision, repository, appConfigured, repositoryState, tasks, taskState }: {
  projectId: string; capability: string; enabled: boolean; revision: number;
  repository: RepositoryRow | null | undefined; appConfigured: boolean; repositoryState: 'ready' | 'loading' | 'error';
  tasks: readonly TaskDescription[] | undefined; taskState: 'ready' | 'loading' | 'error';
}) {
  const actions = useSettingsActions();
  const [error, setError] = useState<string | null>(null);
  const words = CAPABILITY_WORDS[capability] ?? { label: capability, note: undefined };
  const id = `capability-${capability}`;
  // The tasks a person can run under this capability; a stage another task pulls, like turn cards for learning, is part of it.
  const capabilityTasks = tasks?.filter((task) => task.capability === capability && task.startable) ?? [];
  const repositoryTasks = capabilityTasks.filter((task) => REQUIRED_REPOSITORY_TASKS.includes(task.task));
  const independentTasks = capabilityTasks.filter((task) => !REQUIRED_REPOSITORY_TASKS.includes(task.task));
  const readsRepository = repositoryTasks.length > 0;
  const allNeedRepository = allTasksRequireRepository(capabilityTasks.map((task) => task.task));
  const needsSetup = repository != null && !appConfigured;
  const repositoryAction = needsSetup ? 'set up repository access on this server' : 'connect the repository';
  const missingNote = needsSetup ? `${allNeedRepository ? 'Code tasks' : repositoryTasks.map((task) => task.name).join(', ')} wait until the server operator sets up repository access with myco server github-app.`
    : allNeedRepository ? 'Needs this project’s repository to read its code.'
    : `${sentence(independentTasks.map(startedName).join(' and '))} ${enabled ? 'runs now' : 'runs once this is on'}; ${repositoryAction} so ${repositoryTasks.map(startedName).join(' and ')} can run too.`;
  const missingStatus = needsSetup ? (allNeedRepository ? 'On · Code tasks need repository access set up' : 'On · Some tasks need repository access set up')
    : allNeedRepository ? 'On · Code tasks cannot run until a repository is connected' : 'On · Some tasks need a repository';
  const missingRepository = taskState === 'ready' && readsRepository && repositoryState === 'ready' && (repository === null || needsSetup);
  const repositoryNote = taskState === 'loading' ? 'Checking task requirements.'
    : taskState === 'error' ? 'Couldn’t check task requirements.'
      : !readsRepository ? null
    : repositoryState === 'loading' ? 'Checking this project’s repository.'
      : repositoryState === 'error' ? 'Couldn’t check this project’s repository.'
        : repository === null || needsSetup ? missingNote
          : repository === undefined ? 'Couldn’t check this project’s repository.'
            : allNeedRepository ? `It reads the code in ${repositoryName(repository)}, on its ${repository.branch} branch.`
              : `When you start ${repositoryTasks.map(startedName).join(' or ')}, Myco reads the code in ${repositoryName(repository)}, on its ${repository.branch} branch.`;
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
      details={enabled && missingRepository && !needsSetup && <ActionLink to={projectRepositoryPath(projectId, true)}>Connect repository</ActionLink>}
      control={(
        <Switch
          id={id}
          aria-label={words.label}
          checked={enabled}
          disabled={actions.setCapability.isPending}
          onCheckedChange={(checked) => {
            setError(null);
            actions.setCapability.mutate({ projectId, capability, enabled: checked, revision }, { onError: (err) => setError(settingsRefusalText(err)) });
          }}
        />
      )}
    />
  );
}

function CurationLimit({ projectId, value, revision }: { projectId: string; value: number; revision: number }) {
  const actions = useSettingsActions();
  const [draft, setDraft] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const clearDraft = () => { setDraft(null); setDraftRevision(undefined); };
  const save = () => {
    setError(null);
    actions.setProjectSetting.mutate({ projectId, leaf: CURATION_LIMIT.leaf, value: Number(shown), revision: draftRevision ?? revision }, {
      onSuccess: clearDraft,
      onError: err => { if (isSettingsConflict(err)) clearDraft(); setError(settingsRefusalText(err)); },
    });
  };
  return <SettingRow setting={CURATION_LIMIT.leaf} label="Groups curated per day" htmlFor="curation-daily-limit"
    note={`A group is a few spores that overlap, and curating one spends model tokens. This is the most new groups Myco starts here in any 24 hours. A group that failed may be tried again on top of that, and spend more. It starts at ${CURATION_LIMIT.rule.default}.`} status={error ?? undefined} refused={error !== null}
    control={<div className="flex w-full items-center justify-end gap-s2"><Input id="curation-daily-limit" className="min-w-s12 flex-1" type="number" min={CURATION_LIMIT.rule.min} max={CURATION_LIMIT.rule.max} value={shown}
      onChange={event => { if (draft === null) setDraftRevision(revision); setDraft(event.target.value); }} />
      <Button className="shrink-0" pending={actions.setProjectSetting.isPending} disabled={!Number.isInteger(Number(shown)) || Number(shown)<CURATION_LIMIT.rule.min || Number(shown)>CURATION_LIMIT.rule.max || Number(shown)===value}
        onClick={save}>Save daily limit</Button></div>} />;
}

/** What Myco does in a project: a switch per capability. */
export function Capabilities({ projectId }: { projectId: string }) {
  const caps = useCapabilities(projectId);
  const tasks = useTaskDescriptions(projectId);
  const repository = useRepository(projectId);
  const projects = useProjects();
  const admin = useIsAdmin();
  const archived = projects.data?.projects.find((project) => project.projectId === projectId)?.archivedAt != null;
  return (
    <AdminSection id={PROJECT_SETTINGS_ANCHORS.capabilities} title="What Myco does here" description={archived ? undefined : "Each switch saves as you flip it."}>
      {archived ? <fieldset disabled><p className="t-small text-muted">Archived: Myco does no work here until it's restored</p></fieldset>
        : caps.isPending ? <LoadingState label="Loading what Myco does here" count={4} />
        : caps.isError ? <ErrorState error={caps.error} onRetry={() => void caps.refetch()} />
        : (
          <RowCard label="What Myco does here">
            {Object.entries(caps.data.capabilities).filter(([capability]) => Object.hasOwn(CAPABILITY_WORDS, capability)).map(([capability, enabled]) => (
              <CapabilityRow
                key={capability} projectId={projectId} capability={capability} enabled={enabled} revision={caps.data.capabilityRevisions[capability] ?? 0}
                repository={repository.isSuccess ? repository.data.repository : undefined}
                appConfigured={repository.isSuccess ? repository.data.appConfigured : true}
                repositoryState={repository.isSuccess ? 'ready' : repository.isError ? 'error' : 'loading'}
                tasks={tasks.data?.tasks}
                taskState={tasks.isSuccess ? 'ready' : tasks.isError ? 'error' : 'loading'}
              />
            ))}
            <CurationLimit key={projectId} projectId={projectId} value={caps.data.settings[CURATION_LIMIT.leaf]!} revision={caps.data.revisions[CURATION_LIMIT.leaf] ?? 0} />
            {admin && Object.hasOwn(caps.data.capabilities, 'spore_curation') && <CurationPreview key={`preview-${projectId}`} projectId={projectId} />}
          </RowCard>
        )}
    </AdminSection>
  );
}
