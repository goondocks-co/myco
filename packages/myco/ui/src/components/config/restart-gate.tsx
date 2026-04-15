import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import { useRestart } from '../../hooks/use-restart';
import { Button } from '../ui/button';

interface RestartGateValue {
  dirty: ReadonlySet<string>;
  markDirty: (path: string) => void;
  clear: () => void;
}

const Ctx = createContext<RestartGateValue | null>(null);

/**
 * Tracks restart-gated config paths that have been written since the last
 * daemon restart. Fields like daemon.port or embedding.provider only take
 * effect after restart; this provider lets a ScopedField flag itself dirty
 * on commit and lets the page-level banner offer a single Restart button.
 */
export function RestartGateProvider({ children }: { children: ReactNode }) {
  const [dirty, setDirty] = useState<Set<string>>(() => new Set());

  const markDirty = useCallback((path: string) => {
    setDirty((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  const clear = useCallback(() => setDirty(new Set()), []);

  const value = useMemo<RestartGateValue>(
    () => ({ dirty, markDirty, clear }),
    [dirty, markDirty, clear],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRestartGate(): RestartGateValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useRestartGate must be inside RestartGateProvider');
  return ctx;
}

/**
 * Optional — components can call this to mark a path dirty without reading
 * the context themselves (keeps ScopedField decoupled from the gate's
 * existence when a page doesn't wrap in RestartGateProvider).
 */
export function useMarkRestartDirty(): (path: string) => void {
  const ctx = useContext(Ctx);
  return ctx?.markDirty ?? (() => {});
}

export function RestartBanner() {
  const { dirty, clear } = useRestartGate();
  const { restart, isRestarting } = useRestart();

  if (dirty.size === 0) return null;

  const handleRestart = async () => {
    try {
      await restart();
      clear();
    } catch {
      // Keep banner visible so user can retry
    }
  };

  return (
    <div className="mb-4 flex items-center justify-between gap-4 rounded-md border border-ochre/40 bg-ochre/5 p-3">
      <div className="min-w-0">
        <p className="font-sans text-sm font-medium text-on-surface">Restart required</p>
        <p className="font-sans text-xs text-on-surface-variant truncate">
          Changed: {[...dirty].join(', ')}
        </p>
      </div>
      <Button onClick={handleRestart} size="sm" disabled={isRestarting}>
        {isRestarting ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
        )}
        Restart daemon
      </Button>
    </div>
  );
}
