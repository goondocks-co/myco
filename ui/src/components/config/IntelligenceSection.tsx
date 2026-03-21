import type { MycoConfig } from '../../hooks/use-config';
import { ConfigSection } from './ConfigSection';
import {
  Field,
  NativeSelect,
  LLM_PROVIDERS,
  EMBEDDING_PROVIDERS,
  CONTEXT_WINDOW_OPTIONS,
} from './config-helpers';
import { ModelSelect } from './ModelSelect';

interface IntelligenceSectionProps {
  intelligence: MycoConfig['intelligence'];
  isDirty: boolean;
  updateLlm: (key: string, value: string | number) => void;
  updateEmbedding: (key: string, value: string) => void;
}

const contextWindowOptions = CONTEXT_WINDOW_OPTIONS.map((opt) => ({
  value: String(opt.value),
  label: `${opt.label} (${opt.value.toLocaleString()})`,
}));

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
            <Field label="Model" description="The model for extraction, summaries, and titles — speed matters more than depth">
              <ModelSelect
                provider={intelligence.llm.provider}
                baseUrl={intelligence.llm.base_url}
                value={intelligence.llm.model}
                onChange={(v) => updateLlm('model', v)}
              />
            </Field>
            <Field label="Context Window" description="How much text the model can read per operation">
              <NativeSelect
                value={String(intelligence.llm.context_window)}
                onChange={(v) => updateLlm('context_window', parseInt(v, 10))}
                options={contextWindowOptions}
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
            <Field label="Model" description="The embedding model for semantic search and similarity">
              <ModelSelect
                provider={intelligence.embedding.provider}
                baseUrl={intelligence.embedding.base_url}
                value={intelligence.embedding.model}
                onChange={(v) => updateEmbedding('model', v)}
              />
            </Field>
          </div>
        </div>
      </div>
    </ConfigSection>
  );
}
