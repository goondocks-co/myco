import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MACHINE_UPDATE_LEAVES, RELEASE_CHANNELS, type MachineUpdateLeaf } from '@goondocks/myco-shared/member-protocol';
import { Select } from '../../../design';
import { fetchJson, putJson } from '../../../lib/api';
import { live } from '../../../lib/live';

interface UpdateLeaf {
  leaf: string;
  effective: unknown;
  nextEffective: unknown;
  application: 'applied' | 'pending' | 'unreported';
  state?: string;
  reason?: string;
}
interface Settings { leaves: UpdateLeaf[] }
const words = (leaf: string, value: unknown) => value === null || value === undefined ? 'Not reported' : leaf === 'update.automatic' ? value === true ? 'On' : 'Off' : String(value);

/** The machine's own update preferences, with requested changes kept visibly separate until reported. */
export function MachineUpdates({ machineId, name }: { machineId: string; name: string }) {
  const client = useQueryClient();
  const key = ['machine-settings', machineId];
  const path = `/api/machines/${encodeURIComponent(machineId)}/settings`;
  const settings = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchJson<Settings>(path, signal),
    ...live<Settings>({ whileMoving: data => data?.leaves.some(leaf => MACHINE_UPDATE_LEAVES.includes(leaf.leaf as MachineUpdateLeaf) && leaf.application === 'pending') === true }),
  });
  const save = useMutation({
    mutationFn: ({ leaf, value }: { leaf: MachineUpdateLeaf; value: string | boolean }) => putJson(`${path}/${leaf}`, { value }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  if (settings.error) return <p role="alert" className="t-small text-bad">Could not read this machine’s update settings.</p>;
  if (settings.data === undefined) return <p className="t-small text-muted">Reading update settings…</p>;
  return <section aria-label={`Updates for ${name}`} className="flex flex-col gap-s2">
    {MACHINE_UPDATE_LEAVES.map(leaf => {
      const stored = settings.data.leaves.find(row => row.leaf === leaf);
      if (stored === undefined) return null;
      const title = leaf === 'update.automatic' ? 'Automatic updates' : 'Release channel';
      const value = stored.application === 'pending' ? stored.nextEffective : stored.effective;
      return <div key={leaf} className="flex flex-col gap-s1">
        <p className="t-small text-muted">{title}: {words(leaf, stored.effective)}{stored.effective == null ? '' : ' · last reported by this machine'}</p>
        <Select
          label={`${title} for ${name}`}
          placeholder="Not reported"
          value={value === null || value === undefined ? '' : String(value)}
          disabled={save.isPending}
          options={leaf === 'update.automatic' ? [{ value: 'true', label: 'On' }, { value: 'false', label: 'Off' }] : RELEASE_CHANNELS.map(channel => ({ value: channel, label: channel }))}
          onValueChange={selected => save.mutate({ leaf, value: leaf === 'update.automatic' ? selected === 'true' : selected })}
        />
        {stored.state === 'invalid' && <p role="alert" className="t-small text-bad">{stored.reason}</p>}
        {stored.application === 'pending' && <p className="t-small text-muted">Waiting for this machine: {title.toLowerCase()} → {words(leaf, stored.nextEffective)}. It checks and reports settings during agent activity. An idle or offline machine waits until activity resumes.</p>}
      </div>;
    })}
    {save.error && <p role="alert" className="t-small text-bad">Update setting was not saved: {save.error.message}</p>}
  </section>;
}
