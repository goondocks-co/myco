import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';

/** A row of choices that narrow one list, the chosen one filled. */
export function FilterPills<T extends string>({ label, options, value, onChange }: { label: string; options: ReadonlyArray<{ value: T; label: string }>; value: T | null; onChange: (value: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 flex-wrap gap-s2">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'inline-flex h-[28px] items-center rounded-pill border px-s3 t-small transition-colors duration-120 max-lg:h-tap',
            option.value === value ? 'border-primary bg-primary font-medium text-on-primary' : 'border-line bg-surface-1 text-ink-2 hover:border-line-strong',
            focusRing,
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
