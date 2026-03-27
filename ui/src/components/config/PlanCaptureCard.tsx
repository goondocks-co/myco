import { useState, useEffect, useCallback } from 'react';
import { fetchJson, postJson } from '../../lib/api';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Input } from '../ui/input';
import { Button } from '../ui/button';

interface PlanDirsResponse {
  symbiont: Record<string, string[]>;
  custom: string[];
}

export function PlanCaptureCard() {
  const [symbiont, setSymbiont] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<string[]>([]);
  const [savedCustom, setSavedCustom] = useState<string[]>([]);
  const [newDir, setNewDir] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchJson<PlanDirsResponse>('/config/plan-dirs')
      .then((data) => {
        setSymbiont(data.symbiont);
        setCustom(data.custom);
        setSavedCustom(data.custom);
      })
      .catch(() => {
        // leave defaults on error
      })
      .finally(() => setIsLoading(false));
  }, []);

  const dirty =
    custom.length !== savedCustom.length ||
    custom.some((d, i) => d !== savedCustom[i]);

  const handleAdd = useCallback(() => {
    const trimmed = newDir.trim();
    if (!trimmed || custom.includes(trimmed)) return;
    setCustom((prev) => [...prev, trimmed]);
    setNewDir('');
    setSaveMessage(null);
  }, [newDir, custom]);

  const handleRemove = useCallback((dir: string) => {
    setCustom((prev) => prev.filter((d) => d !== dir));
    setSaveMessage(null);
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const result = await postJson<{ custom: string[] }>('/config/plan-dirs', {
        plan_dirs: custom,
      });
      setSavedCustom(result.custom);
      setCustom(result.custom);
      setSaveMessage({ type: 'success', text: 'Plan directories saved.' });
    } catch {
      setSaveMessage({ type: 'error', text: 'Failed to save plan directories.' });
    } finally {
      setIsSaving(false);
    }
  }, [custom]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleAdd();
    },
    [handleAdd],
  );

  const symbiontEntries = Object.entries(symbiont);

  return (
    <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-amber-500">
      <SectionHeader>Plan Capture</SectionHeader>

      {isLoading ? (
        <p className="font-sans text-sm text-on-surface-variant">Loading...</p>
      ) : (
        <div className="space-y-5">
          {/* Agent directories — read-only */}
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

          {/* Custom directories — editable */}
          <div className="space-y-2">
            <p className="font-sans text-sm font-medium text-on-surface">Custom Directories</p>
            <p className="font-sans text-xs text-on-surface-variant">
              Additional directories to watch for plan files.
            </p>

            {custom.length > 0 && (
              <div className="space-y-1">
                {custom.map((dir) => (
                  <div
                    key={dir}
                    className="flex items-center gap-2 rounded bg-surface-container px-3 py-1.5"
                  >
                    <span className="flex-1 font-mono text-xs text-on-surface">{dir}</span>
                    <button
                      type="button"
                      onClick={() => handleRemove(dir)}
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
                onKeyDown={handleKeyDown}
                className="flex-1 font-mono text-xs"
              />
              <Button type="button" size="sm" onClick={handleAdd} disabled={!newDir.trim()}>
                Add
              </Button>
            </div>
          </div>

          {/* Save row — only visible when dirty */}
          {dirty && (
            <div className="flex items-center gap-4 pt-1">
              <Button onClick={handleSave} disabled={isSaving} size="sm">
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
              {saveMessage && (
                <span
                  className={
                    saveMessage.type === 'success'
                      ? 'font-sans text-sm text-primary'
                      : 'font-sans text-sm text-tertiary'
                  }
                >
                  {saveMessage.text}
                </span>
              )}
            </div>
          )}

          {/* Success message when not dirty */}
          {!dirty && saveMessage?.type === 'success' && (
            <p className="font-sans text-sm text-primary">{saveMessage.text}</p>
          )}
        </div>
      )}
    </Surface>
  );
}
