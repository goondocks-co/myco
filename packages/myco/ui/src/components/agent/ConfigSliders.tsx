import { cn } from '../../lib/cn';

/* ---------- Types ---------- */

export interface SliderConfig {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Format the value for display. Defaults to String(). */
  formatValue?: (v: number) => string;
}

interface ConfigSlidersProps {
  sliders: SliderConfig[];
  onChange?: (id: string, value: number) => void;
  disabled?: boolean;
  className?: string;
}

/* ---------- Component ---------- */

export function ConfigSliders({ sliders, onChange, disabled, className }: ConfigSlidersProps) {
  return (
    <div className={cn('space-y-5', className)}>
      {sliders.map((slider) => {
        const displayValue = slider.formatValue
          ? slider.formatValue(slider.value)
          : String(slider.value);

        return (
          <div key={slider.id} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor={`slider-${slider.id}`}
                className="font-sans text-xs font-medium text-on-surface-variant"
              >
                {slider.label}
              </label>
              <span className="font-mono text-xs text-on-surface">{displayValue}</span>
            </div>
            <input
              id={`slider-${slider.id}`}
              type="range"
              min={slider.min}
              max={slider.max}
              step={slider.step}
              value={slider.value}
              disabled={disabled}
              onChange={(e) => onChange?.(slider.id, Number(e.target.value))}
              className="config-slider w-full"
            />
          </div>
        );
      })}
    </div>
  );
}
