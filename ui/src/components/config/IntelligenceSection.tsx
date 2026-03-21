import type { MycoConfig } from '../../hooks/use-config';
import { ConfigSection } from './ConfigSection';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  Field,
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
              <Select
                value={intelligence.llm.provider}
                onValueChange={(v) => updateLlm('provider', v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LLM_PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <Select
                value={String(intelligence.llm.context_window)}
                onValueChange={(v) => updateLlm('context_window', parseInt(v, 10))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTEXT_WINDOW_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={String(opt.value)}>
                      {opt.label} ({opt.value.toLocaleString()})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </div>
        <div>
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Embedding</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider" description="Which service generates vector embeddings for search">
              <Select
                value={intelligence.embedding.provider}
                onValueChange={(v) => updateEmbedding('provider', v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMBEDDING_PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
