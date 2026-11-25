import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { agoWords } from '@goondocks/myco-shared/time-words';
import { Button, ErrorState, StatusChip } from '../../../design';
import { useIsAdmin } from '../../../hooks/use-me';
import { useProjects } from '../../../hooks/use-projects';
import { useStatus } from '../../../hooks/use-status';
import { fetchJson } from '../../../lib/api';
import { harnessLabel } from '../../../lib/harness';
import { live } from '../../../lib/live';
import { ConnectDialog, connectedWords, RepositoryItem } from '../../today/Repositories';
import type { UncapturedAnswer, UncapturedRootItem } from '../../today/wire';
import { harnessHealthWords } from '../../today/words';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import type { Machine } from '../machines';
import { ActivityDialog } from '../people/ActivityDialog';
import { AUTO_JOIN_ROOTS_LEAF, MachineSettingsDialog } from '../people/MachineSettingsDialog';

interface MachineLeafRow { leaf: string; effective?: unknown }

/** The repositories waiting on one machine, from every page of the waiting list. */
function useWaitingOn(machineId: string) {
  const query = useInfiniteQuery({
    queryKey: ['uncaptured', 'pages'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchJson<UncapturedAnswer>(`/api/uncaptured${pageParam === null ? '' : `?cursor=${encodeURIComponent(pageParam)}`}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
    ...live({ follows: ['sessions'] }),
  });
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  useEffect(() => { if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage(); }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const items = useMemo(() => (query.data?.pages.flatMap((page) => page.items) ?? []).filter((item) => item.machineId === machineId), [query.data, machineId]);
  return { query, items };
}

/**
 * What the machine captures: the agents set up on it and their state, the folders whose repositories it captures by
 * themselves and anything waiting outside them, and when it last captured. A machine with no sign-in captures nothing.
 */
export function CapturePart({ claim, viewerId }: { claim: Machine | null; viewerId: string | null }) {
  const admin = useIsAdmin();
  return (
    <AdminSection id="capture" title="What does it capture?">
      <RowCard label="What does it capture?">
        {claim === null ? (
          <SettingRow
            label={admin ? 'Nothing' : 'Nothing of yours'}
            note={admin
              ? 'No one signed in on this machine to capture, so it sends no sessions. That’s usual for a machine that only does Myco’s work.'
              : 'None of your sign-ins are on this machine, so nothing it does is captured for you.'}
            control={<span />}
          />
        ) : <Captures claim={claim} viewerId={viewerId} />}
      </RowCard>
    </AdminSection>
  );
}

function Captures({ claim, viewerId }: { claim: Machine; viewerId: string | null }) {
  const [activity, setActivity] = useState(false);
  const projects = useProjects();
  const now = Date.now();
  const projectName = (id: string) => projects.data?.projects.find((project) => project.projectId === id)?.name ?? null;
  const signedIn = claim.standing === 'allowed';
  const forProjects = claim.capturedProjects.map(projectName).filter((name): name is string => name !== null);
  return (
    <>
      {signedIn ? <Agents claim={claim} /> : (
        <SettingRow label="Nothing now" note="It’s no longer signed in, so it captures nothing. What it sent is kept." control={<span />} />
      )}
      {signedIn && <Folders claim={claim} viewerId={viewerId} />}
      <SettingRow
        setting="machine-last-capture"
        label="Last captured"
        note={claim.lastCaptureAt === null ? 'Nothing from it lately.' : `${agoWords(claim.lastCaptureAt, now)}${forProjects.length === 0 ? '' : `, for ${forProjects.join(', ')}`}.`}
        control={claim.machineId === null ? <span /> : <Button size="sm" onClick={() => setActivity(true)}>What it sent</Button>}
      />
      <ActivityDialog target={activity && claim.machineId !== null ? { name: claim.name, machineId: claim.machineId, bytesWritten: claim.bytesWritten } : null} onClose={() => setActivity(false)} />
    </>
  );
}

/** The agents set up on it, each with its state as the machine last reported it, and the ones that sent something lately. */
function Agents({ claim }: { claim: Machine }) {
  const status = useStatus();
  const facts = (status.data?.harnesses ?? []).filter((fact) => fact.machineId === claim.machineId);
  const failed = status.isError || status.data?.unavailable?.includes('installedAgents') === true;
  const needing = facts.filter((fact) => fact.state !== 'ready' && fact.state !== 'trust_required' && fact.state !== 'held_elsewhere');
  const sending = claim.capturedAgents.map(harnessLabel);
  const label = status.isPending ? 'Reading its agents…'
    : failed ? 'Its agents couldn’t be read'
    : facts.length === 0 ? (sending.length === 0 ? 'No agents set up' : `${sending.length === 1 ? 'One agent' : `${sending.length} agents`} sending`)
    : `${facts.length === 1 ? 'One agent' : `${facts.length} agents`} set up`;
  return (
    <SettingRow
      setting="machine-agents"
      label={label}
      note={sending.length === 0 ? (facts.length === 0 && !failed && !status.isPending ? 'No coding agent on it has sent anything lately.' : 'None has sent anything lately.') : `Sending lately: ${sending.join(', ')}.`}
      details={facts.length === 0 ? (failed ? <ErrorState error={status.error ?? new Error('installed agents unavailable')} onRetry={() => void status.refetch()} /> : undefined) : (
        <ul className="flex flex-col gap-s1 t-meta text-faint" aria-label="Agents set up on it" data-machine-agents="">
          {facts.map((fact) => <li key={fact.id}>{harnessHealthWords({ ...fact, machineName: 'this machine' })}</li>)}
        </ul>
      )}
      control={facts.length === 0 ? <span /> : needing.length === 0 ? <StatusChip tone="ok">All set up</StatusChip> : <StatusChip tone="warn">{needing.length === 1 ? 'One needs you' : `${needing.length} need you`}</StatusChip>}
    />
  );
}

/** The folders whose repositories it captures by themselves, what waits outside them, and changing them, for its member. */
function Folders({ claim, viewerId }: { claim: Machine; viewerId: string | null }) {
  const own = claim.memberId === viewerId && claim.machineId !== null;
  const admin = useIsAdmin();
  const [changing, setChanging] = useState(false);
  const [connecting, setConnecting] = useState<UncapturedRootItem | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const projects = useProjects();
  const settings = useQuery({
    queryKey: ['machine-settings', claim.machineId],
    enabled: own,
    queryFn: ({ signal }) => fetchJson<{ leaves: MachineLeafRow[] }>(`/api/machines/${encodeURIComponent(claim.machineId!)}/settings`, signal),
    ...live('still'),
  });
  const waiting = useWaitingOn(claim.machineId ?? '');
  const folders = settings.data?.leaves.find((row) => row.leaf === AUTO_JOIN_ROOTS_LEAF)?.effective;
  const listed = Array.isArray(folders) ? folders.filter((folder): folder is string => typeof folder === 'string') : [];
  const label = !own ? 'Its folders' : settings.isPending ? 'Reading its folders…' : settings.isError ? 'Its folders couldn’t be read'
    : listed.length === 0 ? 'No folder captured by itself' : `Repositories under ${listed.join(', ')}`;
  const note = !own ? 'The folders it captures are for its member to see and change.'
    : listed.length === 0 ? 'Every repository on it waits here until it’s connected.'
    : `A repository in ${listed.length === 1 ? 'that folder' : 'those folders'} gets a project by itself.`;
  const targets = (projects.data?.projects ?? []).filter((project) => project.archivedAt == null).map((project) => ({ projectId: project.projectId, name: project.name }));
  return (
    <>
      <SettingRow
        setting="machine-folders"
        label={label}
        note={`${note}${waiting.items.length === 0 ? '' : ` ${waiting.items.length === 1 ? 'One repository is waiting.' : `${waiting.items.length} repositories are waiting.`}`}`}
        status={connected ?? undefined}
        details={<>
          {settings.isError && <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />}
          {waiting.query.error != null && <ErrorState error={waiting.query.error} onRetry={() => void (waiting.query.isFetchNextPageError ? waiting.query.fetchNextPage() : waiting.query.refetch())} />}
          {waiting.items.length > 0 && (
            <ul className="mt-s2 flex flex-col gap-s3" aria-label="Waiting outside its folders">
              {waiting.items.map((item) => <RepositoryItem key={item.rootKey} item={item} now={Date.now()} viewerId={viewerId} admin={admin} onConnect={(picked) => { setConnected(null); setConnecting(picked); }} />)}
            </ul>
          )}
        </>}
        control={own ? <Button size="sm" onClick={() => setChanging(true)}>Change folders</Button> : <span />}
      />
      <ConnectDialog item={connecting} viewerId={viewerId} projects={targets} onClose={() => setConnecting(null)} onConnected={(item) => setConnected(connectedWords(item, viewerId))} />
      <MachineSettingsDialog machine={changing && claim.machineId !== null ? { id: claim.machineId, name: claim.name } : null} onClose={() => setChanging(false)} />
    </>
  );
}
