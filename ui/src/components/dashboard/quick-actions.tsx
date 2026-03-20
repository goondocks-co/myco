import { useState, useCallback } from 'react';
import { ExternalLink, FolderOpen, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import { type StatsResponse } from '../../hooks/use-daemon';
import { postJson } from '../../lib/api';
import { Button } from '../ui/button';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

const ACTION_FEEDBACK_DURATION_MS = 2_000;
const DROPDOWN_CLOSE_DELAY_MS = 150;

/* ---------- URI helpers ---------- */

function obsidianUri(name: string): string {
  return `obsidian://open?vault=${encodeURIComponent(name)}`;
}

function vscodeUri(path: string): string {
  return `vscode://file${path}`;
}

function finderUri(path: string): string {
  return `file://${path}`;
}

/* ---------- Action button hook ---------- */

type ActionState = 'idle' | 'loading' | 'success' | 'error';

function useAction(fn: () => Promise<unknown>) {
  const [state, setState] = useState<ActionState>('idle');

  const execute = useCallback(async () => {
    setState('loading');
    try {
      await fn();
      setState('success');
    } catch {
      setState('error');
    }
    setTimeout(() => setState('idle'), ACTION_FEEDBACK_DURATION_MS);
  }, [fn]);

  return { state, execute };
}

/* ---------- Sub-components ---------- */

function VaultLink({ label, href }: { label: string; href: string }) {
  return (
    <a
      href={href}
      className="flex items-center gap-2 rounded px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {label}
      <ExternalLink className="h-3 w-3 opacity-50" />
    </a>
  );
}

function ActionButton({
  label,
  icon,
  state,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  state: ActionState;
  onClick: () => void;
}) {
  const stateLabel =
    state === 'loading'
      ? 'Running...'
      : state === 'success'
        ? 'Done'
        : state === 'error'
          ? 'Failed'
          : label;

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        'gap-2 transition-colors',
        state === 'success' && 'border-primary/50 text-primary',
        state === 'error' && 'border-destructive/50 text-destructive',
      )}
      disabled={state === 'loading'}
      onClick={onClick}
    >
      {state === 'loading' ? (
        <RefreshCw className="h-4 w-4 animate-spin" />
      ) : (
        icon
      )}
      {stateLabel}
    </Button>
  );
}

/* ---------- QuickActions ---------- */

export function QuickActions({ stats }: { stats: StatsResponse }) {
  const runDigest = useAction(
    useCallback(() => postJson('/digest', {}), []),
  );
  const runCuration = useAction(
    useCallback(() => postJson('/curate', { dry_run: true }), []),
  );
  const restartDaemon = useAction(
    useCallback(() => postJson('/restart', {}), []),
  );

  const [vaultMenuOpen, setVaultMenuOpen] = useState(false);

  return (
    <div className="flex flex-wrap gap-2">
      <ActionButton
        label="Run Digest"
        icon={<Sparkles className="h-4 w-4" />}
        state={runDigest.state}
        onClick={runDigest.execute}
      />
      <ActionButton
        label="Run Curation"
        icon={<RefreshCw className="h-4 w-4" />}
        state={runCuration.state}
        onClick={runCuration.execute}
      />
      <ActionButton
        label="Restart Daemon"
        icon={<RotateCcw className="h-4 w-4" />}
        state={restartDaemon.state}
        onClick={restartDaemon.execute}
      />

      {/* Open Vault dropdown */}
      <div className="relative">
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => setVaultMenuOpen((prev) => !prev)}
          onBlur={() => setTimeout(() => setVaultMenuOpen(false), DROPDOWN_CLOSE_DELAY_MS)}
        >
          <FolderOpen className="h-4 w-4" />
          Open Vault
        </Button>
        {vaultMenuOpen && (
          <div className="absolute top-full left-0 z-10 mt-1 min-w-[140px] rounded-md border border-border bg-card p-1 shadow-md">
            <VaultLink
              label="Obsidian"
              href={obsidianUri(stats.vault.name)}
            />
            <VaultLink
              label="VS Code"
              href={vscodeUri(stats.vault.path)}
            />
            <VaultLink
              label="Finder"
              href={finderUri(stats.vault.path)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
