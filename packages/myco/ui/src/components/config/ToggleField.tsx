import { Switch } from '../ui/switch';
import type { BaseFieldControlProps } from './field-control-types';

export interface ToggleFieldProps extends BaseFieldControlProps<boolean> {
}

/**
 * Boolean control: shadcn-style Switch with an On/Off text affordance.
 * Read-only renders the same surface but blocks toggling.
 */
export function ToggleField({
  id,
  value,
  onChange,
  disabled,
  readonly,
}: ToggleFieldProps) {
  return (
    <div className="flex items-center gap-2" id={id}>
      <Switch
        checked={value}
        onCheckedChange={(next) => onChange(next)}
        disabled={disabled || readonly}
      />
      <span className="font-mono text-xs text-on-surface-variant">
        {value ? 'On' : 'Off'}
      </span>
    </div>
  );
}
