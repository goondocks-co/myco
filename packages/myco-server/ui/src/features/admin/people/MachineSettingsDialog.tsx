import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { planFolderRefusal } from '@goondocks/myco-shared/member-protocol';
import { Button, Dialog, DialogContent, DialogFooter, IconButton, Input } from '../../../design';
import { ApiError, fetchJson, putJson } from '../../../lib/api';
import { X } from 'lucide-react';
import { useMemberNames } from '../members';
import { ago } from '../../today/words';

/** The one setting a machine holds today: the extra folders its agents write plans to. */
export const PLAN_DIRS_LEAF = 'capture.plan_dirs';

interface MachineLeaf { leaf: string; configured: boolean; value: unknown; updatedAt: number | null; updatedBy: string | null }

const settingsPath = (machineId: string) => `/api/machines/${encodeURIComponent(machineId)}/settings`;

function refusalWords(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Only the member this machine belongs to can change its settings.';
    if (err.status === 400) return 'The server could not accept those folders.';
    return `The server refused (${err.status}).`;
  }
  return 'Could not reach the server.';
}

const asFolders = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/**
 * One machine's settings, offered to the member it belongs to: the extra
 * folders its agents write plans to, beside each agent's own. The machine
 * reads a change at its next session start; an empty list returns it to the
 * agents' own folders.
 */
export function MachineSettingsDialog({ machine, onClose }: { machine: { id: string; name: string } | null; onClose: () => void }) {
  return (
    <Dialog open={machine !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {machine !== null && <SettingsBody key={machine.id} machine={machine} onClose={onClose} />}
    </Dialog>
  );
}

function SettingsBody({ machine, onClose }: { machine: { id: string; name: string }; onClose: () => void }) {
  const client = useQueryClient();
  const nameOf = useMemberNames();
  const settings = useQuery({
    queryKey: ['machine-settings', machine.id],
    queryFn: ({ signal }) => fetchJson<{ leaves: MachineLeaf[] }>(settingsPath(machine.id), signal),
  });
  const stored = settings.data?.leaves.find((l) => l.leaf === PLAN_DIRS_LEAF);
  const [dirs, setDirs] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => { setDirs(asFolders(stored?.value)); setDraft(''); }, [stored?.value]);
  const save = useMutation({
    mutationFn: (value: string[]) => putJson<{ applied: boolean }>(`${settingsPath(machine.id)}/${PLAN_DIRS_LEAF}`, { value }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['machine-settings', machine.id] }),
  });
  const add = () => {
    const dir = draft.trim();
    const why = dir === '' ? null : planFolderRefusal(dir);
    setRefused(why);
    if (why !== null) return;
    if (dir !== '' && !dirs.includes(dir)) setDirs([...dirs, dir]);
    setDraft('');
  };
  const changed = JSON.stringify(dirs) !== JSON.stringify(asFolders(stored?.value));
  const changedBy = stored?.configured ? nameOf(stored.updatedBy) : null;

  return (
    <DialogContent title={`Settings for ${machine.name}`} description="This machine picks up a change at its next session start.">
      {settings.error ? <p role="alert" className="t-small text-bad">{refusalWords(settings.error)}</p> : (
        <div className="flex flex-col gap-s3">
          <div className="flex flex-col gap-s1">
            <span className="t-body font-medium text-ink">Extra plan folders</span>
            <p className="t-small text-muted">Plans your agents write here are captured too, beside each agent’s own plan folder. A folder may be relative to each project, start with ~/, or be absolute.</p>
          </div>
          <ul className="flex flex-col gap-s1" aria-label="Extra plan folders">
            {dirs.map((dir) => (
              <li key={dir} className="flex items-center gap-s2">
                <span className="min-w-0 flex-1 break-all t-mono text-ink">{dir}</span>
                <IconButton size="sm" label={`Remove ${dir}`} onClick={() => setDirs(dirs.filter((d) => d !== dir))}>
                  <X aria-hidden className="size-s4" />
                </IconButton>
              </li>
            ))}
            {dirs.length === 0 && <li className="t-small text-muted">None: only each agent’s own plan folder.</li>}
          </ul>
          <form className="flex items-center gap-s2" onSubmit={(event) => { event.preventDefault(); add(); }}>
            <Input aria-label="Plan folder to add" className="t-mono" placeholder="~/notes/plans" value={draft} onChange={(event) => setDraft(event.target.value)} />
            <Button type="submit" disabled={draft.trim() === ''}>Add</Button>
          </form>
          {refused !== null && <p role="alert" className="t-small text-bad">That folder is too broad: {refused}.</p>}
          {stored?.configured === true && stored.updatedAt !== null && (
            <p className="t-meta text-faint">Changed{changedBy === null ? '' : ` by ${changedBy}`} {ago(stored.updatedAt, Date.now())}.</p>
          )}
          {save.error && <p role="alert" className="t-small text-bad">{refusalWords(save.error)}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button variant="primary" disabled={!changed} pending={save.isPending} onClick={() => save.mutate(dirs)}>Save</Button>
          </DialogFooter>
        </div>
      )}
    </DialogContent>
  );
}
