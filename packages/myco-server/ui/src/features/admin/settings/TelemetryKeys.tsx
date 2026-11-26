import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agoWords } from '@goondocks/myco-shared/time-words';
import { Button, CommandBlock, ConfirmDialog, DialogFooter, Disclosure, ErrorState, errorWords, Input, type Tone } from '../../../design';
import { deleteJson, fetchJson, postJson } from '../../../lib/api';
import { live } from '../../../lib/live';
import { ConnectionRow } from './ConnectionRow';

export interface TelemetryKey {
  cleanupDone: boolean;
  usedSpans: number;
  spanQuota: number;
  dailySpans: number;
  clockSkewMs: number | null;
  quotaReached: boolean;
  id: string;
  label: string;
  lastUsedAt: number | null;
  revokedAt: number | null;
  accepted: number;
  rejected: number;
}
const PATH = '/api/telemetry/keys';
const QUERY = ['telemetry-keys'];

/** Where an older link to the telemetry keys lands on Connections: before the first key, whether or not one exists. */
export const TELEMETRY_ANCHOR = 'telemetry';

/** `GET /api/telemetry/keys`: the address a sender reports to, and every key. */
export function useTelemetryKeys() {
  return useQuery({ queryKey: QUERY, queryFn: ({ signal }) => fetchJson<{ endpoint: string; keys: TelemetryKey[] }>(PATH, signal), ...live('still') });
}

/** The OpenTelemetry environment a launcher sets to report here with a key, the key itself written as a placeholder. */
export const telemetryEnvironment = (endpoint: string, header = 'Authorization=Bearer%20<the key>'): string =>
  [`OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`, `OTEL_EXPORTER_OTLP_HEADERS="${header}"`, 'OTEL_EXPORTER_OTLP_PROTOCOL=http/json'].join('\n');

/** Whether a key is reporting: revoked, full, quiet or reporting in the last day. */
function telemetryStatus(key: TelemetryKey): { words: string; tone: Tone } {
  if (key.revokedAt !== null) return { words: 'Revoked', tone: 'neutral' };
  if (key.quotaReached) return { words: 'Full', tone: 'warn' };
  if (key.lastUsedAt === null) return { words: 'Never used', tone: 'neutral' };
  return key.accepted > 0 ? { words: 'Reporting', tone: 'ok' } : { words: 'Quiet', tone: 'neutral' };
}

const rejectedWords = (n: number): string => (n === 0 ? 'none rejected' : `${n.toLocaleString()} rejected`);

/**
 * One row per telemetry key: what it is for, when it last reported and how much was accepted, how a launcher uses it,
 * and Remove. A revoked key keeps its record until its reports are cleaned up.
 */
export function TelemetryRows({ endpoint, keys }: { endpoint: string; keys: readonly TelemetryKey[] }) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: QUERY });
  const revoke = useMutation({ mutationFn: (id: string) => postJson(`${PATH}/${encodeURIComponent(id)}/revoke`), onSuccess: refresh });
  const forget = useMutation({ mutationFn: (id: string) => deleteJson(`${PATH}/${encodeURIComponent(id)}`), onSuccess: refresh });
  const [revoking, setRevoking] = useState<TelemetryKey | null>(null);
  const now = Date.now();
  return (
    <>
      {keys.map((key) => (
        <ConnectionRow
          key={key.id}
          kind="telemetry"
          label={key.label}
          use="A launcher that reports which session started which, and when. Optional: a launcher that names its own session when it starts another needs no key."
          status={telemetryStatus(key)}
          note={<>
            <p>{key.revokedAt !== null ? `Revoked ${agoWords(key.revokedAt, now)}` : key.lastUsedAt === null ? 'No report yet' : `Last report ${agoWords(key.lastUsedAt, now)}`}
              {` · ${key.accepted.toLocaleString()} accepted, ${rejectedWords(key.rejected)} in the last day`}</p>
            <p>{`${key.usedSpans.toLocaleString()} of ${key.spanQuota.toLocaleString()} reports kept · about ${key.dailySpans.toLocaleString()} a day`}</p>
            {key.clockSkewMs !== null && <p>{`This launcher’s clock or delivery is ${Math.round(key.clockSkewMs / 1000)} seconds from this server.`}</p>}
          </>}
          actions={key.revokedAt === null
            ? <Button size="sm" variant="ghost" onClick={() => { revoke.reset(); setRevoking(key); }}>Remove</Button>
            : <Button size="sm" variant="ghost" disabled={forget.isPending || !key.cleanupDone} onClick={() => forget.mutate(key.id)}>Remove record</Button>}
        >
          {key.revokedAt === null && (
            <Disclosure summary="How a launcher uses this key">
              <div className="flex flex-col gap-s2" data-telemetry-usage="">
                <p className="t-small text-muted">Set these in the launcher’s environment. The key was shown once, when it was made; it goes after “Bearer%20”.</p>
                <CommandBlock command={telemetryEnvironment(endpoint)} />
              </div>
            </Disclosure>
          )}
        </ConnectionRow>
      ))}
      {forget.error && <ErrorState error={forget.error} />}
      <ConfirmDialog
        open={revoking !== null}
        title="Remove this telemetry key?"
        description="Reports from that launcher are refused from now on, and what it already reported is removed in the background. Sessions and everything else Myco learned stay."
        confirmLabel="Remove key"
        onOpenChange={(open) => { if (!open) setRevoking(null); }}
        onConfirm={() => { if (revoking !== null) revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) }); }}
        pending={revoke.isPending}
        error={revoke.error ? `Nothing changed: ${errorWords(revoke.error).title.toLowerCase()}.` : null}
      />
    </>
  );
}

/** Names a new telemetry key, then shows its address and header once. The key is held only while this form is open. */
export function TelemetryKeyForm({ onDone }: { onDone: () => void }) {
  const client = useQueryClient();
  const issue = useMutation({
    gcTime: 0,
    mutationFn: (label: string) => postJson<{ key: string; headers: string; endpoint: string }>(PATH, { label }),
    onSuccess: () => client.invalidateQueries({ queryKey: QUERY }),
  });
  const [label, setLabel] = useState('');
  const [revealed, setRevealed] = useState<{ headers: string; endpoint: string } | null>(null);
  const close = () => { setLabel(''); setRevealed(null); issue.reset(); onDone(); };
  if (revealed !== null) {
    return (
      <div className="flex flex-col gap-s3">
        <CommandBlock caption="Set these in the launcher’s environment" command={telemetryEnvironment(revealed.endpoint, revealed.headers)} />
        <p className="t-small text-muted">Save this now. The key is not shown again.</p>
        <DialogFooter><Button onClick={close}>Done</Button></DialogFooter>
      </div>
    );
  }
  return (
    <form className="flex flex-col gap-s3" onSubmit={(event) => { event.preventDefault(); issue.mutate(label.trim(), { onSuccess: (result) => setRevealed({ headers: result.headers, endpoint: result.endpoint }) }); }}>
      <label className="t-small text-muted" htmlFor="telemetry-key-name">Name it after the launcher</label>
      <Input id="telemetry-key-name" required maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} />
      {issue.error && <ErrorState error={issue.error} />}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={issue.isPending || label.trim() === ''}>Create key</Button>
      </DialogFooter>
    </form>
  );
}
