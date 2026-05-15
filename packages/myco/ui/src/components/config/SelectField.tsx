import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import type { BaseFieldControlProps } from './field-control-types';

export interface SelectFieldProps extends BaseFieldControlProps {
  value: string;
  onChange: (next: string) => void;
  options: readonly string[];
  /** Optional label overrides keyed by option value. */
  optionLabels?: Readonly<Record<string, string>>;
  placeholder?: string;
}

/**
 * Enum dropdown built on the Radix Select wrapper used elsewhere in
 * Settings. Read-only collapses to a static value chip — Radix's
 * disabled trigger still surfaces a chevron, which we want to avoid
 * for a clean read-only row.
 */
export function SelectField({
  id,
  value,
  onChange,
  disabled,
  readonly,
  options,
  optionLabels,
  placeholder,
}: SelectFieldProps) {
  if (readonly) {
    return (
      <div
        id={id}
        className="flex h-9 items-center rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 font-mono text-sm text-on-surface"
      >
        {optionLabels?.[value] ?? value}
      </div>
    );
  }

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {optionLabels?.[option] ?? option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
