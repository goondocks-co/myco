import { useState, useEffect } from 'react';
import { CONFIG_SECTION_IDS } from '@myco/config/focus';
import { fetchJson } from '../../lib/api';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { ScopedField } from './ScopedField';

interface PlanDirsAgentResponse {
  symbiont: Record<string, string[]>;
}

/**
 * Plan Capture — machine-tier (2026-06 scope correction). Symbionts install
 * globally now, so the watched plan dirs and the managed-.gitignore toggle are
 * a per-machine capture policy, not a per-repo git-committed setting. Both
 * fields use lockScope='machine' so they write to ~/.myco/config.yaml and the
 * Personal pill never appears. The daemon's config-write reaction still runs
 * symbiont reconciliation (.gitignore on the active project) and refreshes the
 * in-memory plan watcher on every successful machine-config write.
 */
export function PlanCaptureCard() {
  const [symbiont, setSymbiont] = useState<Record<string, string[]>>({});
  const [newDir, setNewDir] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  // Symbiont-managed plan dirs come from a separate read-only endpoint
  // (manifest-derived, not from myco.yaml).
  useEffect(() => {
    fetchJson<PlanDirsAgentResponse>('/config/plan-dirs')
      .then((data) => setSymbiont(data.symbiont))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  const symbiontEntries = Object.entries(symbiont);

  return (
    <Surface
      id={CONFIG_SECTION_IDS.settingsPlanCapture}
      level="low"
      className="rounded-lg p-6 space-y-5 border-t-2 border-t-amber-500 transition-all duration-300"
    >
      <SectionHeader>Plan Capture</SectionHeader>

      {isLoading ? (
        <p className="font-sans text-sm text-on-surface-variant">Loading...</p>
      ) : (
        <div className="space-y-5">
          {/* Agent directories — read-only, derived from symbiont manifests */}
          <div className="space-y-2">
            <p className="font-sans text-sm font-medium text-on-surface">Agent Directories</p>
            <p className="font-sans text-xs text-on-surface-variant">
              Directories monitored by connected agents. Managed by symbiont manifests.
            </p>
            {symbiontEntries.length === 0 ? (
              <p className="font-sans text-xs text-on-surface-variant italic">No agent directories configured.</p>
            ) : (
              <div className="space-y-3">
                {symbiontEntries.map(([agentName, dirs]) => (
                  <div key={agentName} className="space-y-1">
                    <p className="font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">
                      {agentName}
                    </p>
                    <div className="space-y-1">
                      {dirs.map((dir) => (
                        <div
                          key={dir}
                          className="rounded bg-surface-container px-3 py-1.5 font-mono text-xs text-on-surface-variant"
                        >
                          {dir}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <ScopedField
            path="capture.ignore_plan_dirs_in_git"
            label="Ignore Custom Plan Dirs In Git"
            lockScope="machine"
            hint=".gitignore is rewritten on every change"
          >
            {({ value, onChange }) => (
              <Switch checked={value ?? false} onCheckedChange={onChange} />
            )}
          </ScopedField>

          <ScopedField
            path="capture.plan_dirs"
            label="Custom Directories"
            lockScope="machine"
            hint="extra paths to watch for plan files"
          >
            {({ value, onChange }) => {
              const dirs = value ?? [];
              return (
                <div className="space-y-2">
                  {dirs.length > 0 && (
                    <div className="space-y-1">
                      {dirs.map((dir) => (
                        <div
                          key={dir}
                          className="flex items-center gap-2 rounded bg-surface-container px-3 py-1.5"
                        >
                          <span className="flex-1 font-mono text-xs text-on-surface">{dir}</span>
                          <button
                            type="button"
                            onClick={() => onChange(dirs.filter((d) => d !== dir))}
                            className="font-sans text-xs text-on-surface-variant hover:text-tertiary transition-colors leading-none"
                            aria-label={`Remove ${dir}`}
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Input
                      placeholder="/path/to/plans"
                      value={newDir}
                      onChange={(e) => setNewDir(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        const trimmed = newDir.trim();
                        if (!trimmed || dirs.includes(trimmed)) return;
                        onChange([...dirs, trimmed]);
                        setNewDir('');
                      }}
                      className="flex-1 font-mono text-xs"
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        const trimmed = newDir.trim();
                        if (!trimmed || dirs.includes(trimmed)) return;
                        onChange([...dirs, trimmed]);
                        setNewDir('');
                      }}
                      disabled={!newDir.trim()}
                    >
                      Add
                    </Button>
                  </div>
                </div>
              );
            }}
          </ScopedField>
        </div>
      )}
    </Surface>
  );
}
