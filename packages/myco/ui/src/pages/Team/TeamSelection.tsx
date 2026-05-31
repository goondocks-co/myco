import { useState } from 'react';
import { Network, FolderTree } from 'lucide-react';
import {
  useTeamRegistry,
  useTeamProjects,
  useSetProjectMembership,
  useJoinTeam,
  type TeamRegistryRecord,
  type TeamProjectRow,
} from '../../hooks/use-team';
import { Panel } from '../../components/ui/panel';
import { IconEyebrow } from '../../components/ui/icon-eyebrow';
import { Eyebrow } from '../../components/ui/eyebrow';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { CopyableField } from '../../components/team/CopyableField';

function TeamRow({ team }: { team: TeamRegistryRecord }) {
  const count = team.projects.length;
  const updateCommand = `myco-team update --team-id ${team.team_id} --observability`;
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-[var(--ghost-border)] px-4 py-3">
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-sm font-medium text-on-surface">{team.name}</span>
        <code className="text-xs font-mono text-on-surface-variant break-all">{team.worker_url}</code>
        <div className="mt-2">
          <CopyableField label="Update command" value={updateCommand} />
        </div>
      </div>
      <Badge variant="outline">
        {count} project{count === 1 ? '' : 's'}
      </Badge>
    </div>
  );
}

function ProjectRow({
  project,
  teams,
  disabled,
  onChange,
}: {
  project: TeamProjectRow;
  teams: TeamRegistryRecord[];
  disabled: boolean;
  onChange: (newTeamId: string) => void;
}) {
  const value = project.team_id ?? '';
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--ghost-border)] px-4 py-3">
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-sm font-medium text-on-surface truncate">{project.project_name}</span>
        <span className="text-xs text-on-surface-variant truncate">{project.grove_name}</span>
      </div>
      <select
        className="shrink-0 rounded-md border border-[var(--ghost-border)] bg-surface-container px-3 py-1.5 text-xs text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40 disabled:opacity-50"
        value={value}
        disabled={disabled}
        aria-label={`Team for ${project.project_name}`}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Not synced</option>
        {teams.map((team) => (
          <option key={team.team_id} value={team.team_id}>
            {team.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function TeamSelection() {
  const { data: registry, isLoading: registryLoading } = useTeamRegistry();
  const { data: projectsData, isLoading: projectsLoading } = useTeamProjects();
  const membership = useSetProjectMembership();
  const join = useJoinTeam();
  const [error, setError] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState('');
  const [joinKey, setJoinKey] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);

  const teams = registry?.teams ?? [];
  const projects = projectsData?.projects ?? [];
  const pending = membership.isPending;

  const handleJoin = async () => {
    setJoinError(null);
    try {
      await join.mutateAsync({ worker_url: joinUrl.trim(), team_key: joinKey.trim() });
      setJoinUrl('');
      setJoinKey('');
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleChange = async (project: TeamProjectRow, newTeamId: string) => {
    const oldTeamId = project.team_id ?? '';
    if (newTeamId === oldTeamId) return;
    setError(null);
    try {
      // Remove-then-add so a project that moves between teams never trips the
      // server's 409 (a project can only belong to one team at a time).
      if (oldTeamId) {
        await membership.mutateAsync({
          team_id: oldTeamId,
          grove_id: project.grove_id,
          project_id: project.project_id,
          action: 'remove',
        });
      }
      if (newTeamId !== '') {
        await membership.mutateAsync({
          team_id: newTeamId,
          grove_id: project.grove_id,
          project_id: project.project_id,
          action: 'add',
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel
        tone="sage"
        eyebrow={<IconEyebrow Icon={Network}>Teams</IconEyebrow>}
        title="Registered teams"
      >
        <div className="flex flex-col gap-2 mb-4">
          <p className="text-xs text-on-surface-variant m-0">
            Join a team a teammate shared with you. Paste the Worker URL and Team key — no extra install required.
          </p>
          <label className="myco-eyebrow-sm text-on-surface-variant" htmlFor="join-worker-url">Worker URL</label>
          <input
            id="join-worker-url"
            aria-label="Worker URL"
            className="rounded-md border border-[var(--ghost-border)] bg-surface-container px-3 py-1.5 text-xs text-on-surface"
            value={joinUrl}
            onChange={(e) => setJoinUrl(e.target.value)}
            placeholder="https://team.example.workers.dev"
          />
          <label className="myco-eyebrow-sm text-on-surface-variant" htmlFor="join-team-key">Team key</label>
          <input
            id="join-team-key"
            aria-label="Team key"
            type="password"
            className="rounded-md border border-[var(--ghost-border)] bg-surface-container px-3 py-1.5 text-xs text-on-surface"
            value={joinKey}
            onChange={(e) => setJoinKey(e.target.value)}
          />
          <div className="flex justify-end">
            <Button size="sm" disabled={join.isPending || !joinUrl.trim() || !joinKey.trim()} onClick={handleJoin}>
              {join.isPending ? 'Joining…' : 'Join team'}
            </Button>
          </div>
          {joinError && <p className="text-sm text-terracotta m-0" data-testid="team-join-error">{joinError}</p>}
        </div>
        {registryLoading && teams.length === 0 ? (
          <p className="text-sm text-on-surface-variant m-0">Loading teams…</p>
        ) : teams.length === 0 ? (
          <p className="text-sm text-on-surface-variant m-0">
            No teams yet. An operator provisions one with <code className="font-mono">myco-team install</code>, or join one a teammate shared with you using the form above.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {teams.map((team) => (
              <TeamRow key={team.team_id} team={team} />
            ))}
          </div>
        )}
      </Panel>

      <Panel
        tone="sage"
        eyebrow={<IconEyebrow Icon={FolderTree}>Projects</IconEyebrow>}
        title="Assign projects to a team"
      >
        <p className="text-xs text-on-surface-variant m-0 mb-3">
          Choose which team each project syncs to. Moving a project removes it from its
          current team before adding it to the new one.
        </p>
        {projectsLoading && projects.length === 0 ? (
          <p className="text-sm text-on-surface-variant m-0">Loading projects…</p>
        ) : projects.length === 0 ? (
          <div className="flex flex-col gap-1">
            <Eyebrow size="sm">No projects</Eyebrow>
            <p className="text-sm text-on-surface-variant m-0">
              No projects are registered with this daemon yet.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {projects.map((project) => (
              <ProjectRow
                key={`${project.grove_id}:${project.project_id}`}
                project={project}
                teams={teams}
                disabled={pending}
                onChange={(newTeamId) => handleChange(project, newTeamId)}
              />
            ))}
          </div>
        )}
        {error && (
          <p className="text-sm text-terracotta m-0 mt-3" data-testid="team-selection-error">
            {error}
          </p>
        )}
      </Panel>
    </div>
  );
}

export default TeamSelection;
