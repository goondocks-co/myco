import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { ApiError, fetchJson, putJson } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { planFolderRefusal } from '@goondocks/myco-shared/member-protocol';

/** The one leaf a machine holds today: the extra folders its agents write plans to. */
const PLAN_DIRS_LEAF = 'capture.plan_dirs';

interface MachineLeaf { leaf: string; configured: boolean; value: unknown; updatedAt: number | null; updatedBy: string | null }

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50';
const primary = 'rounded-md bg-primary px-3 py-1.5 font-sans text-sm text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50';
const inputClass = 'min-w-0 flex-1 rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1 font-mono text-xs text-on-surface';

const settingsPath = (machineId: string) => `/api/machines/${encodeURIComponent(machineId)}/settings`;

function refusalWords(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { reason?: unknown; detail?: unknown } | null;
    if (err.status === 403) return 'Only the member this machine belongs to can change its settings.';
    if (typeof body?.detail === 'string') return body.detail;
    return `The server refused (${err.status}).`;
  }
  return 'Could not reach the server.';
}

/**
 * One machine's settings, offered to the member it belongs to: the extra folders its agents write plans to, beside
 * each agent's own. The machine reads a change at its next session start. An empty list returns it to the agents'
 * own folders. `machine` names the machine by id for the server and by its display name for the reader.
 */
export function MachineSettingsDialog({ machine, onClose, nameOf }: { machine: { id: string; name: string } | null; onClose: () => void; nameOf: (id: string | null) => string | null }) {
  const machineId = machine?.id ?? null;
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ['machine-settings', machineId],
    queryFn: ({ signal }) => fetchJson<{ leaves: MachineLeaf[] }>(settingsPath(machineId!), signal),
    enabled: machineId !== null,
  });
  const stored = settings.data?.leaves.find((l) => l.leaf === PLAN_DIRS_LEAF);
  const [dirs, setDirs] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  useEffect(() => { setDirs(Array.isArray(stored?.value) ? (stored!.value as string[]) : []); setDraft(''); }, [stored?.value, machineId]);
  const save = useMutation({
    mutationFn: (value: string[]) => putJson<{ applied: boolean }>(`${settingsPath(machineId!)}/${PLAN_DIRS_LEAF}`, { value }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['machine-settings', machineId] }),
  });
  const [refused, setRefused] = useState<string | null>(null);
  const add = () => {
    const dir = draft.trim();
    const why = dir === '' ? null : planFolderRefusal(dir);
    setRefused(why);
    if (why !== null) return;
    if (dir !== '' && !dirs.includes(dir)) setDirs([...dirs, dir]);
    setDraft('');
  };
  const changed = JSON.stringify(dirs) !== JSON.stringify(Array.isArray(stored?.value) ? stored!.value : []);
  return (
    <Dialog open={machineId !== null} onOpenChange={(open) => { if (!open) { save.reset(); onClose(); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings for {machine?.name}</DialogTitle>
          <DialogDescription>This machine picks up a change at its next session start.</DialogDescription>
        </DialogHeader>
        {settings.error ? <p className="font-sans text-sm text-tertiary">{refusalWords(settings.error)}</p> : (
          <div className="flex flex-col gap-3 font-sans text-sm">
            <div>
              <div className="text-on-surface">Extra plan folders</div>
              <p className="text-xs text-on-surface-variant">Plans your agents write here are captured too, beside each agent&apos;s own plan folder. A folder may be relative to each project, start with ~/, or be absolute.</p>
            </div>
            <ul className="flex flex-col gap-1" aria-label="Extra plan folders">
              {dirs.map((dir) => (
                <li key={dir} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 font-mono text-xs text-on-surface">{dir}</span>
                  <button type="button" className={button} onClick={() => setDirs(dirs.filter((d) => d !== dir))}>Remove</button>
                </li>
              ))}
              {dirs.length === 0 && <li className="text-xs text-on-surface-variant">None: only each agent&apos;s own plan folder.</li>}
            </ul>
            <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
              <input aria-label="Plan folder to add" className={inputClass} placeholder="~/notes/plans" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button type="submit" className={button} disabled={draft.trim() === ''}>Add</button>
            </form>
            {refused !== null && <p role="alert" className="text-xs text-tertiary">That folder is too broad: {refused}.</p>}
            {stored?.configured && <p className="text-xs text-on-surface-variant">Changed{stored.updatedBy ? ` by ${nameOf(stored.updatedBy) ?? stored.updatedBy}` : ''} {formatRelative(stored.updatedAt)}.</p>}
            {save.error && <p className="text-xs text-tertiary">{refusalWords(save.error)}</p>}
            <div className="flex justify-end">
              <button type="button" className={primary} disabled={!changed || save.isPending} onClick={() => save.mutate(dirs)}>Save</button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
