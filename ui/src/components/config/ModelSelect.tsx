import { useEffect } from 'react';
import { useModels, type ModelType } from '../../hooks/use-models';

/** Providers that require a base_url before models can be listed. */
const REQUIRES_BASE_URL = new Set(['openai-compatible']);

interface ModelSelectProps {
  provider: string | null;
  baseUrl?: string | null;
  value: string;
  onChange: (model: string) => void;
  placeholder?: string;
  /** Filter to only show LLM or embedding models. */
  modelType?: ModelType;
}

export function ModelSelect({
  provider,
  baseUrl,
  value,
  onChange,
  placeholder,
  modelType,
}: ModelSelectProps) {
  const needsUrl = provider ? REQUIRES_BASE_URL.has(provider) : false;
  const waitingForUrl = needsUrl && !baseUrl;

  const { data, isLoading } = useModels(provider, baseUrl, modelType);
  const models = data?.models ?? [];

  // Auto-select the current configured value if it's in the list,
  // otherwise select the first available model
  useEffect(() => {
    if (isLoading || waitingForUrl || models.length === 0) return;
    if (!models.includes(value)) {
      onChange(models[0]);
    }
  }, [models, isLoading, waitingForUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={isLoading || !provider || waitingForUrl}
      className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
    >
      {waitingForUrl && <option value="">Enter base URL first</option>}
      {!waitingForUrl && isLoading && <option value={value}>Loading models...</option>}
      {!waitingForUrl && !isLoading && !provider && <option value="">Select provider first</option>}
      {!waitingForUrl && !isLoading && provider && models.length === 0 && (
        <option value="">No models available</option>
      )}
      {!waitingForUrl && !isLoading && models.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
    </select>
  );
}
