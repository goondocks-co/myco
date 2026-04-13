import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { fetchSettings, upsertSetting } from '../lib/api';

function formatTimestamp(value: number): string {
  return new Date(value * 1000).toLocaleString();
}

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
      <Card className="p-6 md:p-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-[#ceab91]">Settings</p>
        <h2 className="mt-3 font-display text-4xl text-[#fff4e8] md:text-5xl">Transport override state with schema-backed intent.</h2>
        <p className="mt-4 max-w-3xl text-base leading-7 text-[#cab3a2]">
          The Collective owns override transport, not governance policy. This surface stays focused on an explicit schema-backed override set that team workers can cache and apply consistently.
        </p>
      </Card>

      <Card className="p-6">
        <h3 className="font-display text-3xl text-[#fff2e5]">Upsert override</h3>
        <form className="mt-6 grid gap-4 md:grid-cols-2" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label className="text-sm text-[#ccb6a6]">Key</label>
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
              className="h-11 w-full rounded-[24px] border border-[rgba(255,231,208,0.12)] bg-[rgba(255,248,240,0.05)] px-4 text-sm text-[#fff4e8] outline-none transition-colors focus:border-[rgba(247,179,106,0.55)]"
              required
            >
              <option value="">Select a supported override</option>
              {definitions.map((definition) => (
                <option key={definition.key} value={definition.key}>{definition.key}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm text-[#ccb6a6]">JSON value</label>
            <textarea
              value={valueText}
              onChange={(event) => setValueText(event.target.value)}
              className="min-h-32 w-full rounded-[24px] border border-[rgba(255,231,208,0.12)] bg-[rgba(255,248,240,0.05)] px-4 py-3 font-mono text-sm text-[#fff4e8] outline-none transition-colors placeholder:text-[#9e8b7e] focus:border-[rgba(247,179,106,0.55)]"
              placeholder='{"enabled": true}'
            />
          </div>
          <div className="md:col-span-2 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={mutation.isPending}>Save override</Button>
            {message ? <span className="text-sm text-[#d7c0ae]">{message}</span> : null}
          </div>
          {selectedDefinition ? (
            <div className="md:col-span-2 rounded-[24px] border border-[rgba(255,231,208,0.10)] bg-[rgba(255,248,240,0.04)] p-4 text-sm text-[#ccb6a6]">
              <p className="text-[#fff0e2]">{selectedDefinition.description}</p>
              <p className="mt-2 font-mono text-xs uppercase tracking-[0.22em] text-[#f6c69b]">
                {selectedDefinition.value_type}
                {selectedDefinition.enum_values ? `: ${selectedDefinition.enum_values.join(', ')}` : ''}
                {selectedDefinition.minimum !== undefined ? ` · min ${selectedDefinition.minimum}` : ''}
                {selectedDefinition.maximum !== undefined ? ` · max ${selectedDefinition.maximum}` : ''}
              </p>
            </div>
          ) : null}
        </form>
      </Card>

      <div className="grid gap-4">
        {Object.entries(records).map(([settingKey, record]) => (
          <Card key={settingKey} className="p-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#f6c69b]">{settingKey}</p>
                <p className="mt-2 text-sm text-[#bca493]">{record.description ?? 'No description provided.'}</p>
              </div>
              <div className="text-right text-sm text-[#9f8774]">
                <div>{record.updated_by ?? 'admin'}</div>
                <div>{formatTimestamp(record.updated_at)}</div>
              </div>
            </div>
            <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-words rounded-[24px] bg-[rgba(8,4,3,0.42)] p-4 font-mono text-xs text-[#ffe9d0]">
              {JSON.stringify(record.value, null, 2)}
            </pre>
          </Card>
        ))}
      </div>
    </div>
  );
}
