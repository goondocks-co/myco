/**
 * Shared "Advanced: pin a specific model" collapsible. Renders the toggle
 * button (ChevronRight/Down) over a {@link ModelSelectField} plus helper copy.
 *
 * Pinning a model is the escape hatch the reasoning-profile system falls back
 * to — useful for local providers without a reasoning map, or to force a
 * specific SKU regardless of tier. Both the Grove-default Agent card and the
 * per-task Task Config render this identically; it lives here so the two stay
 * visually and behaviourally in sync.
 *
 * Open/close state is self-managed by default (uncontrolled). Pass `open` +
 * `onOpenChange` to drive it from a parent — Task Config does this to auto-open
 * when a saved model override loads and to collapse it on "Clear All
 * Overrides".
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ModelSelectField, type ModelSelectFieldProps } from './ModelSelectField';

const DEFAULT_HELPER_TEXT =
  'Used only when the selected reasoning profile has no mapping — ' +
  'e.g. local providers without a reasoning map.';

type ModelPinFieldProps = Pick<
  ModelSelectFieldProps,
  'providerType' | 'localBackend' | 'baseUrl' | 'model' | 'modelPlaceholder' | 'providers' | 'onModelChange'
>;

export interface AdvancedModelPinProps extends ModelPinFieldProps {
  /** Controlled open state. Omit for self-managed (uncontrolled) behaviour. */
  open?: boolean;
  /** Controlled open-state setter. Required when `open` is provided. */
  onOpenChange?: (open: boolean) => void;
  /** Helper copy under the field. Defaults to the shared escape-hatch wording. */
  helperText?: string;
}

export function AdvancedModelPin({
  open,
  onOpenChange,
  helperText = DEFAULT_HELPER_TEXT,
  ...fieldProps
}: AdvancedModelPinProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : uncontrolledOpen;
  const toggle = () => {
    const next = !isOpen;
    if (isControlled) {
      onOpenChange?.(next);
    } else {
      setUncontrolledOpen(next);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1 font-sans text-xs text-on-surface-variant hover:text-on-surface"
      >
        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Advanced: pin a specific model
      </button>
      {isOpen && (
        <>
          <ModelSelectField {...fieldProps} />
          <p className="font-sans text-[11px] text-on-surface-variant/70">
            {helperText}
          </p>
        </>
      )}
    </div>
  );
}
