import { useCallback, useState } from 'react';
import { CheckCircle, Loader2, XCircle } from 'lucide-react';
import { CONFIG_SECTION_IDS } from '@myco/config/focus';
import { useScopedConfig } from '../../hooks/use-scoped-config';
import { useModels } from '../../hooks/use-models';
import { fetchJson } from '../../lib/api';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { SearchableSelect } from '../ui/searchable-select';
import { ScopedField } from '../config/ScopedField';

type Provider = 'ollama' | 'openai-compatible';
type TestState = 'idle' | 'testing' | 'success' | 'error';

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
];

/** Embedding — provider endpoint + model selection. Personal-default by
 *  design: each machine has its own Ollama/OpenAI-compatible endpoint and
 *  may prefer different models based on local hardware. */
export function EmbeddingCard() {
  const { effective } = useScopedConfig();
  const currentProvider = effective?.embedding.provider ?? 'ollama';
  const currentBaseUrl = effective?.embedding.base_url ?? '';
  const { data: embeddingModelsData } = useModels(currentProvider, currentBaseUrl || undefined, 'embedding');
  const embeddingModels = embeddingModelsData?.models ?? [];
  const [testState, setTestState] = useState<TestState>('idle');
  const [testMessage, setTestMessage] = useState('');

  const handleTestConnection = useCallback(async () => {
    setTestState('testing');
    setTestMessage('');
    try {
      const params = new URLSearchParams({ provider: currentProvider, type: 'embedding' });
      if (currentBaseUrl) params.set('base_url', currentBaseUrl);
      const result = await fetchJson<{ provider: string; models: string[] }>(`/models?${params.toString()}`);
      const count = result.models.length;
      setTestState('success');
      setTestMessage(`Connected -- ${count} model${count !== 1 ? 's' : ''} available.`);
    } catch (err) {
      setTestState('error');
      setTestMessage(err instanceof Error ? err.message : 'Connection failed.');
    }
  }, [currentProvider, currentBaseUrl]);

  return (
    <Surface
      id={CONFIG_SECTION_IDS.settingsEmbedding}
      level="low"
      className="rounded-lg p-6 space-y-5 border-t-2 border-t-ochre transition-all duration-300"
    >
      <SectionHeader>Embedding</SectionHeader>

      <div className="space-y-4">
        <ScopedField
          path="embedding.provider"
          label="Provider"
          defaultScope="grove"
          allowPersonal={false}
          requiresRestart
        >
          {({ value, onChange }) => (
            <Select value={value ?? 'ollama'} onValueChange={(v) => { onChange(v as Provider); setTestState('idle'); }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </ScopedField>

        <ScopedField
          path="embedding.model"
          label="Model"
          defaultScope="grove"
          allowPersonal={false}
          requiresRestart
          commitOn={embeddingModels.length > 0 ? 'change' : 'blur'}
        >
          {({ value, onChange, onBlur }) =>
            embeddingModels.length > 0 ? (
              <SearchableSelect
                value={value ?? ''}
                onValueChange={onChange}
                placeholder="Select a model"
                searchPlaceholder="Search embedding models..."
                emptyMessage="No embedding models match that search."
                options={embeddingModels.map((candidate) => ({
                  value: candidate,
                  label: candidate,
                }))}
                sortOptions
                monospace
              />
            ) : (
              <Input
                placeholder="bge-m3"
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value)}
                onBlur={onBlur}
              />
            )
          }
        </ScopedField>

        <ScopedField
          path="embedding.base_url"
          label="Base URL"
          hint="optional"
          defaultScope="grove"
          allowPersonal={false}
          requiresRestart
          commitOn="blur"
          parse={(v) => (v === '' ? (undefined as unknown as string) : v)}
        >
          {({ value, onChange, onBlur }) => (
            <Input
              type="url"
              placeholder="http://localhost:11434"
              value={value ?? ''}
              onChange={(e) => { onChange(e.target.value); setTestState('idle'); }}
              onBlur={onBlur}
            />
          )}
        </ScopedField>

        <div className="flex items-center gap-3 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={handleTestConnection} disabled={testState === 'testing'}>
            {testState === 'testing' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Test Connection
          </Button>
          {testState === 'success' && (
            <span className="flex items-center gap-1 font-sans text-sm text-primary">
              <CheckCircle className="h-4 w-4" />
              {testMessage}
            </span>
          )}
          {testState === 'error' && (
            <span className="flex items-center gap-1 font-sans text-sm text-tertiary">
              <XCircle className="h-4 w-4" />
              {testMessage}
            </span>
          )}
        </div>
      </div>
    </Surface>
  );
}
