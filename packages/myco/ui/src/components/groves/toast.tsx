/**
 * Lightweight transient toast for Grove-management actions. We avoid
 * adding a new dependency for this cluster: the daemon notifications
 * surface is the durable channel, this is just for ephemeral
 * action feedback (snapshot path, mutation errors).
 *
 * Render <ToastViewport /> once near the app root, then call
 * `showToast({ ... })` from anywhere.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface ToastInput {
  level: 'success' | 'error' | 'info';
  title: string;
  detail?: string;
  ttlMs?: number;
}

interface ActiveToast extends ToastInput {
  id: number;
}

type Listener = (toasts: ActiveToast[]) => void;

let counter = 0;
let active: ActiveToast[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l(active);
}

export function showToast(input: ToastInput): void {
  const id = ++counter;
  const toast: ActiveToast = { ...input, id };
  active = [...active, toast];
  emit();
  const ttl = input.ttlMs ?? 5000;
  if (ttl > 0) {
    setTimeout(() => {
      active = active.filter((t) => t.id !== id);
      emit();
    }, ttl);
  }
}

export function ToastViewport(): ReactNode {
  const [toasts, setToasts] = useState<ActiveToast[]>(active);

  useEffect(() => {
    listeners.add(setToasts);
    return () => {
      listeners.delete(setToasts);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto rounded-md border bg-surface-container-highest px-4 py-3 shadow-lg',
            t.level === 'success' && 'border-primary/30',
            t.level === 'error' && 'border-tertiary/40',
            t.level === 'info' && 'border-outline-variant/30',
          )}
        >
          <div className="text-sm font-medium text-on-surface">{t.title}</div>
          {t.detail && (
            <div className="mt-1 break-all font-mono text-xs text-on-surface-variant">
              {t.detail}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Test-only reset. */
export function __resetToastsForTests(): void {
  active = [];
  counter = 0;
  emit();
}
