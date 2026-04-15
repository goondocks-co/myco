import { useState } from 'react';

interface ScopePillProps {
  /** Promote local override to project scope. */
  onPromote: () => void | Promise<void>;
  /** Clear the local override so the project value shines through. */
  onReset: () => void | Promise<void>;
}

/**
 * Compact "Personal" indicator with a click-to-open menu offering promote
 * (Save to project) and reset (Reset to project) actions. Used wherever a
 * scoped field has an active local override — ScopedField renders one
 * automatically; custom card components render this directly when they
 * need per-row scope affordances.
 *
 * Visually distinct from status badges: outlined + accent-colored so it
 * reads as an interactive control, not a passive label.
 */
export function ScopePill({ onPromote, onReset }: ScopePillProps) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="This setting is overridden on this machine"
        className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-primary hover:bg-primary/10 transition-colors cursor-pointer"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
        Personal
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 w-44 rounded-md border border-outline-variant/20 bg-surface-container-high p-1 text-xs shadow-lg">
          <button
            type="button"
            onClick={() => { void onPromote(); setOpen(false); }}
            className="block w-full rounded px-2 py-1 text-left hover:bg-surface-container-highest"
          >
            Save to project
          </button>
          <button
            type="button"
            onClick={() => { void onReset(); setOpen(false); }}
            className="block w-full rounded px-2 py-1 text-left hover:bg-surface-container-highest"
          >
            Reset to project
          </button>
        </div>
      )}
    </span>
  );
}
