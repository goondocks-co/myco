import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CommandBlock, ConfirmDialog, Dialog, DialogContent, DialogFooter, ErrorState, Input, LoadingState } from '../../../design';
import { fetchJson, postJson, deleteJson } from '../../../lib/api';
import { live } from '../../../lib/live';
import { AdminSection, RowCard } from '../AdminFrame';
import { agoWords } from '@goondocks/myco-shared/time-words';

interface TelemetryKey {
  id: string; label: string; lastUsedAt: number | null; revokedAt: number | null; accepted: number; rejected: number;
}
const PATH = '/api/telemetry/keys';
const QUERY = ['telemetry-keys'];

/** A key is held only while its one-time dialog is open, including the mutation that answered it. */
export function TelemetryKeys() {
  const client = useQueryClient();
  const keys = useQuery({ queryKey: QUERY, queryFn: ({ signal }) => fetchJson<{ endpoint: string; keys: TelemetryKey[] }>(PATH, signal), ...live('still') });
  const refresh = () => client.invalidateQueries({ queryKey: QUERY });
  const issue = useMutation({ gcTime: 0, mutationFn: (label: string) => postJson<{ key: string; headers: string; endpoint: string }>(PATH, { label }), onSuccess: refresh });
  const revoke = useMutation({ mutationFn: (id: string) => postJson(`${PATH}/${encodeURIComponent(id)}/revoke`), onSuccess: refresh });
  const forget = useMutation({ mutationFn: (id: string) => deleteJson(`${PATH}/${encodeURIComponent(id)}`), onSuccess: refresh });
  const [adding, setAdding] = useState(false), [label, setLabel] = useState('');
  const [revealed, setRevealed] = useState<{ headers: string; endpoint: string } | null>(null);
  const [revoking, setRevoking] = useState<TelemetryKey | null>(null);
  const close = () => { setAdding(false); setLabel(''); setRevealed(null); issue.reset(); };
  return <AdminSection id="telemetry" title="Telemetry keys"
    description="Connect a sender that reports agent activity using OpenTelemetry. These keys accept telemetry and cannot read Myco."
    actions={<Button onClick={() => setAdding(true)}>Add telemetry key</Button>}>
    <CommandBlock caption="OTLP endpoint base" command={keys.data?.endpoint ?? window.location.origin} />
    <p className="t-small text-muted">Configure your sender for OTLP/HTTP JSON with this base address and the authorization header shown when you create a key.</p>
    {keys.isPending ? <LoadingState label="Loading telemetry keys" /> : keys.isError ? <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
      : keys.data.keys.length === 0 ? <Card><p className="t-body text-muted">No telemetry keys.</p></Card>
        : <RowCard label="Telemetry keys">{keys.data.keys.map(key => <div key={key.id} className="flex items-start justify-between gap-s4 px-s4 py-s4">
          <div className="flex flex-col gap-s1"><span className="t-body font-medium text-ink">{key.label}</span>
            <span className="t-small text-muted">{key.revokedAt !== null ? 'Revoked' : key.lastUsedAt === null ? 'Never used' : `Last used ${agoWords(key.lastUsedAt, Date.now())}`}</span>
            <span className="t-small text-muted">{key.accepted} accepted · {key.rejected} rejected spans in the last day</span>
          </div>
          {key.revokedAt === null ? <Button onClick={() => { revoke.reset(); setRevoking(key); }}>Revoke</Button>
            : <Button disabled={forget.isPending} onClick={() => forget.mutate(key.id)}>Remove record</Button>}
        </div>)}</RowCard>}
    {forget.error && <ErrorState error={forget.error} />}
    <Dialog open={adding} onOpenChange={open => { if (!open) close(); }}><DialogContent title={revealed === null ? 'Add telemetry key' : 'Telemetry key · shown once'}>
      {revealed === null ? <form className="flex flex-col gap-s3" onSubmit={event => {
        event.preventDefault(); issue.mutate(label.trim(), { onSuccess: result => setRevealed({ headers: result.headers, endpoint: result.endpoint }) });
      }}>
        <label className="t-small text-muted" htmlFor="telemetry-key-name">Name</label>
        <Input id="telemetry-key-name" required maxLength={80} value={label} onChange={event => setLabel(event.target.value)} />
        {issue.error && <ErrorState error={issue.error} />}
        <DialogFooter><Button type="button" onClick={close}>Cancel</Button><Button type="submit" disabled={issue.isPending || label.trim() === ''}>Create key</Button></DialogFooter>
      </form> : <>
        <CommandBlock caption="OTLP endpoint base" command={revealed.endpoint} />
        <CommandBlock caption="OTLP headers list (Authorization: Bearer key)" command={revealed.headers} />
        <p className="t-small text-muted">Save this header now. The key is not shown again.</p>
        <DialogFooter><Button onClick={close}>Done</Button></DialogFooter>
      </>}
    </DialogContent></Dialog>
    <ConfirmDialog open={revoking !== null} title="Revoke telemetry key?" description="This sender will stop being accepted. Its stored spans, invocation facts and reported lineage will be removed."
      confirmLabel="Revoke key" onOpenChange={open => { if (!open) setRevoking(null); }} onConfirm={() => { if (revoking !== null) revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) }); }}
      pending={revoke.isPending} error={revoke.error?.message} />
  </AdminSection>;
}
