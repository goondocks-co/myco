import { useModels } from '../../hooks/use-models';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

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

  // Ensure current value is always an option so it doesn't disappear
  const hasValue = value && models.includes(value);
  const showNotFound = value && !isLoading && models.length > 0 && !hasValue;

  return (
    <Select value={value || '__empty__'} onValueChange={(v) => onChange(v === '__empty__' ? '' : v)}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder ?? 'Select model'}>
          {isLoading
            ? 'Loading models...'
            : showNotFound
              ? `${value} (not found)`
              : value || placeholder || 'Select model'}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {!value && (
          <SelectItem value="__empty__">{placeholder ?? 'Select model'}</SelectItem>
        )}
        {value && !hasValue && !isLoading && (
          <SelectItem value={value}>
            {value}{models.length > 0 ? ' (not found)' : ''}
          </SelectItem>
        )}
        {models.map((m) => (
          <SelectItem key={m} value={m}>{m}</SelectItem>
        ))}
        {isLoading && (
          <SelectItem value={value || '__empty__'} disabled>
            Loading models...
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}
