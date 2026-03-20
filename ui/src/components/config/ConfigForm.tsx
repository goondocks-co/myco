import { useState, useCallback, useEffect } from 'react';
import { AlertTriangle, RefreshCw, Save } from 'lucide-react';
import type { MycoConfig } from '../../hooks/use-config';
import { useDaemon } from '../../hooks/use-daemon';
import { useRestart } from '../../hooks/use-restart';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { isDirty } from './config-helpers';
import { IntelligenceSection } from './IntelligenceSection';
import { DigestSection } from './DigestSection';
import { CaptureSection } from './CaptureSection';
import { ContextSection } from './ContextSection';
import { DaemonSection } from './DaemonSection';
import { TeamSection } from './TeamSection';

interface ConfigFormProps {
  config: MycoConfig;
  onSave: (config: MycoConfig) => Promise<unknown>;
  isSaving: boolean;
}

export function ConfigForm({ config, onSave, isSaving }: ConfigFormProps) {
  const [form, setForm] = useState<MycoConfig>(config);
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const [savedConfigHash, setSavedConfigHash] = useState<string | null>(null);

  const { data: stats } = useDaemon();
  const { restart, isRestarting } = useRestart();

  // Reset form when server config changes (e.g. after refetch)
  useEffect(() => {
    setForm(config);
  }, [config]);

  const runningConfigHash = stats?.daemon.config_hash ?? null;
  const needsRestart = savedConfigHash !== null && savedConfigHash !== runningConfigHash;

  const formDirty = isDirty(form, config);

  /* ---------- Section-level dirty checks ---------- */

  const intelligenceDirty = isDirty(form.intelligence, config.intelligence);
  const digestDirty = isDirty(form.digest, config.digest);
  const captureDirty = isDirty(form.capture, config.capture);
  const contextDirty = isDirty(form.context, config.context);
  const daemonDirty = isDirty(form.daemon, config.daemon);
  const teamDirty = isDirty(form.team, config.team);

  /* ---------- Updaters ---------- */

  const updateLlm = useCallback(
    (key: string, value: string | number) =>
      setForm((prev) => ({
        ...prev,
        intelligence: {
          ...prev.intelligence,
          llm: { ...prev.intelligence.llm, [key]: value },
        },
      })),
    [],
  );

  const updateEmbedding = useCallback(
    (key: string, value: string) =>
      setForm((prev) => ({
        ...prev,
        intelligence: {
          ...prev.intelligence,
          embedding: { ...prev.intelligence.embedding, [key]: value },
        },
      })),
    [],
  );

  const updateDigest = useCallback(
    (key: string, value: unknown) =>
      setForm((prev) => ({
        ...prev,
        digest: { ...prev.digest, [key]: value },
      })),
    [],
  );

  const updateDigestIntelligence = useCallback(
    (key: string, value: unknown) =>
      setForm((prev) => ({
        ...prev,
        digest: {
          ...prev.digest,
          intelligence: { ...prev.digest.intelligence, [key]: value },
        },
      })),
    [],
  );

  const updateDigestMetabolism = useCallback(
    (key: string, value: unknown) =>
      setForm((prev) => ({
        ...prev,
        digest: {
          ...prev.digest,
          metabolism: { ...prev.digest.metabolism, [key]: value },
        },
      })),
    [],
  );

  const updateDigestSubstrate = useCallback(
    (key: string, value: number) =>
      setForm((prev) => ({
        ...prev,
        digest: {
          ...prev.digest,
          substrate: { ...prev.digest.substrate, [key]: value },
        },
      })),
    [],
  );

  const updateCapture = useCallback(
    (key: string, value: number) =>
      setForm((prev) => ({
        ...prev,
        capture: { ...prev.capture, [key]: value },
      })),
    [],
  );

  const updateContext = useCallback(
    (key: string, value: number) =>
      setForm((prev) => ({
        ...prev,
        context: { ...prev.context, [key]: value },
      })),
    [],
  );

  const updateContextLayer = useCallback(
    (key: string, value: number) =>
      setForm((prev) => ({
        ...prev,
        context: {
          ...prev.context,
          layers: { ...prev.context.layers, [key]: value },
        },
      })),
    [],
  );

  const updateDaemon = useCallback(
    (key: string, value: unknown) =>
      setForm((prev) => ({
        ...prev,
        daemon: { ...prev.daemon, [key]: value },
      })),
    [],
  );

  const updateTeam = useCallback(
    (key: string, value: unknown) =>
      setForm((prev) => ({
        ...prev,
        team: { ...prev.team, [key]: value },
      })),
    [],
  );

  /* ---------- Save / restart ---------- */

  const handleSave = async () => {
    const saved = await onSave(form);
    if (runningConfigHash) {
      setSavedConfigHash(runningConfigHash);
    }
    setShowRestartDialog(true);
    return saved;
  };

  const handleRestart = async () => {
    setShowRestartDialog(false);
    await restart(true);
  };

  return (
    <div className="space-y-4">
      {/* Restart-pending banner */}
      {needsRestart && (
        <div className="flex items-center gap-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-500" />
          <span className="flex-1 text-sm text-yellow-700 dark:text-yellow-400">
            Configuration changed — restart required for changes to take effect
          </span>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 border-yellow-500/50 text-yellow-700 hover:bg-yellow-500/10 dark:text-yellow-400"
            onClick={handleRestart}
            disabled={isRestarting}
          >
            {isRestarting ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Restart Now
          </Button>
        </div>
      )}

      <IntelligenceSection
        intelligence={form.intelligence}
        isDirty={intelligenceDirty}
        updateLlm={updateLlm}
        updateEmbedding={updateEmbedding}
      />

      <DigestSection
        digest={form.digest}
        isDirty={digestDirty}
        updateDigest={updateDigest}
        updateDigestIntelligence={updateDigestIntelligence}
        updateDigestMetabolism={updateDigestMetabolism}
        updateDigestSubstrate={updateDigestSubstrate}
      />

      <CaptureSection
        capture={form.capture}
        isDirty={captureDirty}
        updateCapture={updateCapture}
      />

      <ContextSection
        context={form.context}
        isDirty={contextDirty}
        updateContext={updateContext}
        updateContextLayer={updateContextLayer}
      />

      <DaemonSection
        daemon={form.daemon}
        isDirty={daemonDirty}
        updateDaemon={updateDaemon}
      />

      <TeamSection
        team={form.team}
        isDirty={teamDirty}
        updateTeam={updateTeam}
      />

      {/* Save button */}
      <div className="flex items-center justify-end gap-3 pt-2">
        {formDirty && (
          <span className="text-sm text-muted-foreground">Unsaved changes</span>
        )}
        <Button
          onClick={handleSave}
          disabled={!formDirty || isSaving}
          className="gap-2"
        >
          {isSaving ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {isSaving ? 'Saving...' : 'Save Configuration'}
        </Button>
      </div>

      {/* Restart dialog */}
      <Dialog open={showRestartDialog} onOpenChange={setShowRestartDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configuration Saved</DialogTitle>
            <DialogDescription>
              Changes have been saved to disk. Some settings require a daemon restart to take effect.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRestartDialog(false)}>
              Later
            </Button>
            <Button
              onClick={handleRestart}
              disabled={isRestarting}
              className="gap-2"
            >
              {isRestarting ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {isRestarting ? 'Restarting...' : 'Restart Now'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
