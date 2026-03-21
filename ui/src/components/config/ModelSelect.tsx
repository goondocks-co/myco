import { useEffect, useState } from 'react';
import { useModels, REQUIRES_BASE_URL, type ModelType } from '../../hooks/use-models';

/** Debounce delay before a changed base URL triggers a new model fetch. */
const BASE_URL_DEBOUNCE_MS = 500;

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

  // Debounce base URL so each keystroke doesn't trigger a new fetch.
  const [debouncedUrl, setDebouncedUrl] = useState(baseUrl);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedUrl(baseUrl), BASE_URL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [baseUrl]);

  const { data, isLoading } = useModels(provider, debouncedUrl, modelType);
  const models = data?.models ?? [];

  // When models load, match the configured value to an available model.
  // Handles tag variations: configured "bge-m3" matches returned "bge-m3:latest".
  // Only calls onChange when the resolved model actually differs from the current
  // value — prevents spurious dirty-state on 30s cache refreshes.
  useEffect(() => {
    if (isLoading || waitingForUrl || models.length === 0) return;
    if (models.includes(value)) return; // Exact match — keep it

    // Fuzzy match: "bge-m3" matches "bge-m3:latest", or "qwen3.5:latest" matches "qwen3.5:latest"
    const fuzzy = models.find((m) => m.startsWith(value + ':') || value.startsWith(m + ':') || m === value);
    const resolved = fuzzy ?? models[0];
    if (resolved !== value) onChange(resolved);
  }, [models, isLoading, waitingForUrl, value, onChange]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={isLoading || !provider || waitingForUrl}
      className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
    >
      {waitingForUrl && <option value="">{placeholder ?? 'Enter base URL first'}</option>}
      {!waitingForUrl && isLoading && <option value={value}>Loading models...</option>}
      {!waitingForUrl && !isLoading && !provider && <option value="">{placeholder ?? 'Select provider first'}</option>}
      {!waitingForUrl && !isLoading && provider && models.length === 0 && (
        <option value="">{placeholder ?? 'No models available'}</option>
      )}
      {!waitingForUrl && !isLoading && models.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
    </select>
  );
}
