import type { MycoConfig } from '../../hooks/use-config';
import { ConfigSection } from './ConfigSection';
import { Input } from '../ui/input';
import {
  Field,
  NativeSelect,
  LLM_PROVIDERS,
  EMBEDDING_PROVIDERS,
  CONTEXT_WINDOW_SELECT_OPTIONS,
} from './config-helpers';
import { ModelSelect } from './ModelSelect';

interface IntelligenceSectionProps {
  intelligence: MycoConfig['intelligence'];
  isDirty: boolean;
  updateLlm: (key: string, value: string | number) => void;
  updateEmbedding: (key: string, value: string) => void;
}

export function IntelligenceSection({
  intelligence,
  isDirty,
  updateLlm,
  updateEmbedding,
}: IntelligenceSectionProps) {
  return (
    <ConfigSection
      title="Intelligence"
      description="LLM and embedding provider configuration"
      isDirty={isDirty}
      defaultOpen
    >
      <div className="space-y-6">
        <div>
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">LLM</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider" description="Which LLM service to use for processing sessions">
              <NativeSelect
                value={intelligence.llm.provider}
                onChange={(v) => updateLlm('provider', v)}
                options={[...LLM_PROVIDERS]}
              />
            </Field>
            {intelligence.llm.provider === 'openai-compatible' && (
              <Field label="Base URL" description="OpenAI-compatible API endpoint (e.g., http://localhost:8080/v1)">
                <Input
                  value={intelligence.llm.base_url ?? ''}
                  onChange={(e) => updateLlm('base_url', e.target.value)}
                  placeholder="http://localhost:8080/v1"
                />
              </Field>
            )}
            <Field label="Model" description="The model for extraction, summaries, and titles — speed matters more than depth">
              <ModelSelect
                provider={intelligence.llm.provider}
                baseUrl={intelligence.llm.base_url}
                value={intelligence.llm.model}
                onChange={(v) => updateLlm('model', v)}
                modelType="llm"
              />
            </Field>
            <Field label="Context Window" description="How much text the model can read per operation">
              <NativeSelect
                value={String(intelligence.llm.context_window)}
                onChange={(v) => updateLlm('context_window', parseInt(v, 10))}
                options={CONTEXT_WINDOW_SELECT_OPTIONS}
              />
            </Field>
          </div>
        </div>
        <div>
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Embedding</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider" description="Which service generates vector embeddings for search">
              <NativeSelect
                value={intelligence.embedding.provider}
                onChange={(v) => updateEmbedding('provider', v)}
                options={[...EMBEDDING_PROVIDERS]}
              />
            </Field>
            {intelligence.embedding.provider === 'openai-compatible' && (
              <Field label="Base URL" description="OpenAI-compatible embedding API endpoint">
                <Input
                  value={intelligence.embedding.base_url ?? ''}
                  onChange={(e) => updateEmbedding('base_url', e.target.value)}
                  placeholder="http://localhost:8080/v1"
                />
              </Field>
            )}
            <Field label="Model" description="The embedding model for semantic search and similarity">
              <ModelSelect
                provider={intelligence.embedding.provider}
                baseUrl={intelligence.embedding.base_url}
                value={intelligence.embedding.model}
                onChange={(v) => updateEmbedding('model', v)}
                modelType="embedding"
              />
            </Field>
          </div>
        </div>
      </div>
    </ConfigSection>
  );
}
