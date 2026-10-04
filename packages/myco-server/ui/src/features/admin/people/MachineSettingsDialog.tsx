import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { captureFolderRefusal, planFolderRefusal } from '@goondocks/myco-shared/member-protocol';
import { Button, Dialog, DialogContent, DialogFooter, IconButton, Input } from '../../../design';
import { ApiError, fetchJson, putJson } from '../../../lib/api';
import type { EffectiveSetting } from '@goondocks/myco-shared/settings-contract';
import { X } from 'lucide-react';
import { useMemberNames } from '../members';
import { ago } from '../../today/words';

/** The extra folders a machine's agents write plans to. */
export const PLAN_DIRS_LEAF = 'capture.plan_dirs';
/** The folders whose repositories a machine captures as soon as an agent works in one. */
export const AUTO_JOIN_ROOTS_LEAF = 'capture.auto_join_roots';

interface MachineLeaf extends Partial<EffectiveSetting> { leaf: string; configured: boolean; value: unknown; updatedAt: number | null; updatedBy: string | null; application?: 'applied' | 'pending' | 'unreported'; appliedValue?: unknown; nextEffective?: unknown; nextSource?: EffectiveSetting['source'] }

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

/** One list of folders a machine holds, as the dialog offers it: its heading and words, and the rule each folder must pass. */
interface FolderField {
  leaf: string;
  title: string;
  note: string;
  none: string;
  addLabel: string;
  placeholder: string;
  refusal: (entry: string) => string | null;
}

const FIELDS: readonly FolderField[] = [
  {
    leaf: AUTO_JOIN_ROOTS_LEAF,
    title: 'Folders it captures',
    note: 'A repository in one of these folders is captured as soon as an agent works in it, in the project that holds its remote or a new one. A repository anywhere else waits in Needs you until it’s connected.',
    none: 'None: every repository waits in Needs you until it’s connected.',
    addLabel: 'Folder to capture',
    placeholder: '~/Repos',
    refusal: captureFolderRefusal,
  },
  {
    leaf: PLAN_DIRS_LEAF,
    title: 'Extra plan folders',
    note: 'Plans your agents write here are captured too, beside each agent’s own plan folder. A folder may be relative to each project, start with ~/, or be absolute.',
    none: 'None: only each agent’s own plan folder.',
    addLabel: 'Plan folder to add',
    placeholder: '~/notes/plans',
    refusal: planFolderRefusal,
  },
];

/**
 * One machine's settings, offered to the member it belongs to: the folders whose repositories it captures on its own,
 * and the extra folders its agents write plans to, beside each agent's own. The machine reads a change at its next
 * session start.
 */
export function MachineSettingsDialog({ machine, onClose }: { machine: { id: string; name: string } | null; onClose: () => void }) {
  return (
    <Dialog open={machine !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {machine !== null && <SettingsBody key={machine.id} machine={machine} onClose={onClose} />}
    </Dialog>
  );
}

function FolderList({ field, stored, folders, refusedSave, onChange, onClear }: {
  field: FolderField; stored: MachineLeaf; folders: string[]; refusedSave: string | null; onChange: (next: string[]) => void; onClear: () => void;
}) {
  const nameOf = useMemberNames();
  const [draft, setDraft] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  const add = () => {
    const dir = draft.trim();
    const why = dir === '' ? null : field.refusal(dir);
    setRefused(why);
    if (why !== null) return;
    if (dir !== '' && !folders.includes(dir)) onChange([...folders, dir]);
    setDraft('');
  };
  const changedBy = stored.configured ? nameOf(stored.updatedBy) : null;
  return (
    <section className="flex flex-col gap-s3" aria-label={field.title} data-machine-leaf={field.leaf}>
      <div className="flex flex-col gap-s1">
        <span className="t-body font-medium text-ink">{field.title}</span>
        <p className="t-small text-muted">{field.note}</p>
      </div>
      <ul className="flex flex-col gap-s1" aria-label={field.title}>
        {folders.map((dir) => (
          <li key={dir} className="flex items-center gap-s2">
            <span className="min-w-0 flex-1 break-all t-mono text-ink">{dir}</span>
            <IconButton size="sm" label={`Remove ${dir}`} onClick={() => onChange(folders.filter((d) => d !== dir))}>
              <X aria-hidden className="size-s4" />
            </IconButton>
          </li>
        ))}
        {folders.length === 0 && <li className="t-small text-muted">{field.none}</li>}
      </ul>
      <form className="flex items-center gap-s2" onSubmit={(event) => { event.preventDefault(); add(); }}>
        <Input aria-label={field.addLabel} className="t-mono" placeholder={field.placeholder} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <Button type="submit" disabled={draft.trim() === ''}>Add</Button>
      </form>
      {refused !== null && <p role="alert" className="t-small text-bad">That folder can’t be used: {refused}.</p>}
      {refusedSave !== null && <p role="alert" className="t-small text-bad">Not saved: {refusedSave}</p>}
      {(stored.nextSource ?? stored.source) === 'default' && <p className="t-small text-muted">Using Myco’s default.</p>}
      {stored.reason && <p className="t-small text-muted">{stored.reason}</p>}
      {stored.application === 'pending' && <p className="t-small text-muted">Currently cached on this machine: {JSON.stringify(stored.effective ?? stored.appliedValue)}.</p>}
      {(stored.nextSource ?? stored.source) === 'invalid' && <p className="t-small text-muted break-all">Stored value: {JSON.stringify(stored.stored ?? stored.value)}.</p>}
      {(stored.nextSource ?? stored.source) === 'invalid' && <Button variant="ghost" onClick={onClear}>Clear the stored value</Button>}
      {stored.configured && stored.updatedAt !== null && (
        <p className="t-meta text-faint">Changed{changedBy === null ? '' : ` by ${changedBy}`} {ago(stored.updatedAt, Date.now())}.</p>
      )}
    </section>
  );
}

function SettingsBody({ machine, onClose }: { machine: { id: string; name: string }; onClose: () => void }) {
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ['machine-settings', machine.id],
    queryFn: ({ signal }) => fetchJson<{ leaves: MachineLeaf[] }>(settingsPath(machine.id), signal),
  });
  // A leaf the server does not list is not offered: it would be a setting this server cannot hold.
  const fields = FIELDS.flatMap((field) => {
    const stored = settings.data?.leaves.find((l) => l.leaf === field.leaf);
    return stored === undefined ? [] : [{ field, stored }];
  });
  // Unsaved edits, by leaf: each stays until its own save is accepted, whatever another list's save is answered.
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const foldersOf = (leaf: string, stored: MachineLeaf) => edits[leaf] ?? asFolders(Object.hasOwn(stored, 'nextEffective') ? stored.nextEffective : Object.hasOwn(stored, 'effective') ? stored.effective : stored.value);
  const changed = fields.filter(({ field, stored }) => JSON.stringify(foldersOf(field.leaf, stored)) !== JSON.stringify(asFolders(Object.hasOwn(stored, 'nextEffective') ? stored.nextEffective : Object.hasOwn(stored, 'effective') ? stored.effective : stored.value)));
  const save = useMutation({
    mutationFn: async (writes: Array<{ leaf: string; value: string[] }>) => {
      const answers: Array<{ leaf: string; refused: string | null }> = [];
      for (const write of writes) {
        try {
          await putJson<{ applied: boolean }>(`${settingsPath(machine.id)}/${write.leaf}`, { value: write.value });
          answers.push({ leaf: write.leaf, refused: null });
        } catch (err) {
          answers.push({ leaf: write.leaf, refused: refusalWords(err) });
        }
      }
      return answers;
    },
    // A saved list is read back before its edit is let go, so the list never shows the value it replaced.
    onSuccess: async (answers) => {
      await client.invalidateQueries({ queryKey: ['machine-settings', machine.id] });
      const saved = new Set(answers.filter((a) => a.refused === null).map((a) => a.leaf));
      setEdits((current) => Object.fromEntries(Object.entries(current).filter(([leaf]) => !saved.has(leaf))));
      setRefusals(Object.fromEntries(answers.flatMap((a) => (a.refused === null ? [] : [[a.leaf, a.refused]]))));
    },
  });

  const clear = useMutation({
    mutationFn: (leaf: string) => putJson(`${settingsPath(machine.id)}/${leaf}`, { value: null, reset: true }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['machine-settings', machine.id] }),
  });
  const connections = settings.data?.leaves.find((leaf) => leaf.leaf === 'capture.connect_roots');

  return (
    <DialogContent title={`Settings for ${machine.name}`} description="This machine picks up a change at its next session start.">
      {settings.error ? <p role="alert" className="t-small text-bad">{refusalWords(settings.error)}</p> : (
        <div className="flex flex-col gap-s5">
          {fields.map(({ field, stored }) => (
            <FolderList
              key={field.leaf}
              field={field}
              stored={stored}
              folders={foldersOf(field.leaf, stored)}
              refusedSave={refusals[field.leaf] ?? null}
              onChange={(next) => setEdits({ ...edits, [field.leaf]: next })}
              onClear={() => clear.mutate(field.leaf)}
            />
          ))}
          {connections && <section aria-label="Connected repositories" className="flex flex-col gap-s2">
            <span className="t-body font-medium text-ink">Connected repositories</span>
            <p className="t-small text-muted">{Object.keys((connections.nextEffective ?? connections.effective ?? connections.value ?? {}) as object).length} repositories connected from Needs you.</p>
            {connections.reason && <p className="t-small text-muted">{connections.reason}</p>}
            {connections.application === 'pending' && <p className="t-small text-muted">Currently cached on this machine: {JSON.stringify(connections.effective ?? connections.appliedValue)}.</p>}
            {(connections.nextSource ?? connections.source) === 'invalid' && <p className="t-small text-muted break-all">Stored value: {JSON.stringify(connections.stored ?? connections.value)}.</p>}
            {(connections.nextSource ?? connections.source) === 'invalid' && <Button variant="ghost" pending={clear.isPending} onClick={() => clear.mutate(connections.leaf)}>Clear the stored value</Button>}
          </section>}
          {clear.error && <p role="alert" className="t-small text-bad">Not cleared: {refusalWords(clear.error)}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button
              variant="primary"
              disabled={changed.length === 0}
              pending={save.isPending}
              onClick={() => save.mutate(changed.map(({ field, stored }) => ({ leaf: field.leaf, value: foldersOf(field.leaf, stored) })))}
            >
              Save
            </Button>
          </DialogFooter>
        </div>
      )}
    </DialogContent>
  );
}
