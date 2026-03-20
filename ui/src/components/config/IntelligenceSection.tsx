import type { MycoConfig } from '../../hooks/use-config';
import { ConfigSection } from './ConfigSection';
import { Input } from '../ui/input';
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
  numChange,
  strChange,
} from './config-helpers';

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
            <Field label="Provider">
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
            <Field label="Model">
              <Input
                value={intelligence.llm.model}
                onChange={strChange(updateLlm, 'model')}
              />
            </Field>
            <Field label="Context Window">
              <Input
                type="number"
                value={intelligence.llm.context_window}
                onChange={numChange(updateLlm, 'context_window')}
              />
            </Field>
            <Field label="Max Tokens">
              <Input
                type="number"
                value={intelligence.llm.max_tokens}
                onChange={numChange(updateLlm, 'max_tokens')}
              />
            </Field>
          </div>
        </div>
        <div>
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Embedding</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider">
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
            <Field label="Model">
              <Input
                value={intelligence.embedding.model}
                onChange={strChange(updateEmbedding, 'model')}
              />
            </Field>
          </div>
        </div>
      </div>
    </ConfigSection>
  );
}
