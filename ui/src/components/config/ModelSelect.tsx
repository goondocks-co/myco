import { useEffect } from 'react';
import { useModels } from '../../hooks/use-models';

interface ModelSelectProps {
  provider: string | null;
  baseUrl?: string | null;
  value: string;
  onChange: (model: string) => void;
  placeholder?: string;
}

export function ModelSelect({
  provider,
  baseUrl,
  value,
  onChange,
  placeholder,
}: ModelSelectProps) {
  const { data, isLoading } = useModels(provider, baseUrl);
  const models = data?.models ?? [];

  // Auto-select first model when provider changes and current value isn't available
  useEffect(() => {
    if (isLoading || models.length === 0) return;
    if (!models.includes(value)) {
      onChange(models[0]);
    }
  }, [models, isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={isLoading || !provider}
      className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
    >
      {isLoading && <option value={value}>Loading models...</option>}
      {!isLoading && !provider && <option value="">Select provider first</option>}
      {!isLoading && provider && models.length === 0 && (
        <option value="">No models available</option>
      )}
      {!isLoading && models.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
    </select>
  );
}
