import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { PageHeader } from '../components/ui/page-header';
import { SectionHeader } from '../components/ui/section-header';
import { fetchSettings, upsertSetting } from '../lib/api';
import { formatTimestamp } from '../lib/format';

const TEXTAREA_BASE_CLASS = 'appearance-none min-h-36 w-full rounded-md border border-[var(--ghost-border)] bg-[var(--surface-container-lowest)] px-3 py-3 font-mono text-sm text-[var(--on-surface)] outline-hidden transition-colors placeholder:text-[color-mix(in_srgb,var(--on-surface-variant),transparent_25%)] focus:border-primary/40';
const SELECT_BASE_CLASS = 'appearance-none h-9 w-full rounded-md border border-[var(--ghost-border)] bg-[var(--surface-container-lowest)] px-3 text-sm text-[var(--on-surface)] outline-hidden transition-colors focus:border-primary/40';

export default function Settings() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  const [key, setKey] = useState('');
  const [valueText, setValueText] = useState('true');
  const [message, setMessage] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: upsertSetting,
    onSuccess: async () => {
      setMessage('Setting updated.');
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      await queryClient.invalidateQueries({ queryKey: ['health'] });
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : 'Failed to update setting.');
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    try {
      const parsed = JSON.parse(valueText);
      mutation.mutate({ key, value: parsed });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Invalid JSON value.');
    }
  };

  const records = settingsQuery.data?.settings_records ?? {};
  const definitions = settingsQuery.data?.setting_definitions ?? [];
  const selectedDefinition = definitions.find((definition) => definition.key === key) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="Shared settings transport with schema-backed intent."
        subtitle="Collective owns override distribution, not product governance. This surface stays close to the contract team workers cache and apply."
        actions={<Badge variant="subtle">{Object.keys(records).length} active</Badge>}
      />

      <Card className="p-6">
        <div>
          <SectionHeader>Upsert Override</SectionHeader>
          <h2 className="mt-2 font-serif text-2xl text-on-surface">Edit Collective override state</h2>
        </div>

        <form className="mt-6 grid gap-4 md:grid-cols-2" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label className="text-xs text-on-surface-variant">Key</label>
            <select
              value={key}
              onChange={(event) => {
                const nextKey = event.target.value;
                setKey(nextKey);
                const nextDefinition = definitions.find((definition) => definition.key === nextKey);
                if (nextDefinition) {
                  setValueText(JSON.stringify(nextDefinition.example, null, 2));
                }
              }}
              className={SELECT_BASE_CLASS}
              required
            >
              <option value="">Select a supported override</option>
              {definitions.map((definition) => (
                <option key={definition.key} value={definition.key}>{definition.key}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="text-xs text-on-surface-variant">JSON value</label>
            <textarea
              value={valueText}
              onChange={(event) => setValueText(event.target.value)}
              className={TEXTAREA_BASE_CLASS}
              placeholder='{"enabled": true}'
            />
          </div>

          {selectedDefinition && (
            <div className="md:col-span-2 rounded-md border border-[var(--ghost-border)] bg-surface-container-low px-4 py-4">
              <div className="text-sm text-on-surface">{selectedDefinition.description}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge variant="subtle">{selectedDefinition.value_type}</Badge>
                {selectedDefinition.enum_values?.map((value) => (
                  <Badge key={value} variant="outline">{value}</Badge>
                ))}
                {selectedDefinition.minimum !== undefined && (
                  <Badge variant="outline">min {selectedDefinition.minimum}</Badge>
                )}
                {selectedDefinition.maximum !== undefined && (
                  <Badge variant="outline">max {selectedDefinition.maximum}</Badge>
                )}
              </div>
            </div>
          )}

          <div className="md:col-span-2 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={mutation.isPending}>Save override</Button>
            {message && <span className="text-sm text-on-surface-variant">{message}</span>}
          </div>
        </form>
      </Card>

      <div className="grid gap-4">
        {Object.entries(records).map(([settingKey, record]) => (
          <Card key={settingKey} className="p-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="truncate font-mono text-[11px] uppercase tracking-[0.22em] text-primary">
                  {settingKey}
                </div>
                <div className="mt-2 text-sm text-on-surface-variant">
                  {record.description ?? 'No description provided.'}
                </div>
              </div>
              <div className="text-sm text-on-surface-variant lg:text-right">
                <div>{record.updated_by ?? 'admin'}</div>
                <div>{formatTimestamp(record.updated_at)}</div>
              </div>
            </div>
            <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-surface-container-lowest p-4 font-mono text-xs text-on-surface">
              {JSON.stringify(record.value, null, 2)}
            </pre>
          </Card>
        ))}
      </div>
    </div>
  );
}
