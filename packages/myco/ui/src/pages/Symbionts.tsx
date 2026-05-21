/**
 * Symbionts page — global view of every coding agent Myco knows about,
 * the machine-detection status, and whether Myco's global config is
 * actually wired into each detected agent. The on-demand "Re-detect now"
 * button invokes `runSymbiontDetection()` on the daemon, which installs
 * the global config into any newly-detected agent and emits the same
 * notifications the periodic PowerManager tick would.
 *
 * Per Decision 5 of the global-install plan, per-symbiont enable/disable
 * is a project-level override surface — that UI lives on the
 * project-selected variant of this page (TODO follow-up). The base list
 * here is global by intent: no install/uninstall control (detection is
 * automatic by design); the affordances are observation + on-demand
 * re-detection.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { PageContainer } from '../components/ui/page-container';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { fetchJson } from '../lib/api';
import { useSymbionts, type SymbiontInfo } from '../hooks/use-symbionts';

export default function Symbionts() {
  const { data, isLoading, refetch } = useSymbionts();
  const queryClient = useQueryClient();
  const [detecting, setDetecting] = useState(false);
  const [lastDetectionAt, setLastDetectionAt] = useState<Date | null>(null);

  const symbionts = data?.symbionts ?? [];
  const detected = symbionts.filter((s) => s.detected);
  const notDetected = symbionts.filter((s) => !s.detected);

  async function redetect() {
    setDetecting(true);
    try {
      await fetchJson('/symbionts/detect', { method: 'POST' });
      setLastDetectionAt(new Date());
      await queryClient.invalidateQueries({ queryKey: ['symbionts'] });
      await refetch();
    } finally {
      setDetecting(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Symbionts"
        description="Every coding agent Myco knows about, with detection and global-install status for this machine."
        action={
          <Button onClick={redetect} disabled={detecting} variant="outline" size="sm">
            <RefreshCw className={`h-4 w-4 mr-1.5 ${detecting ? 'animate-spin' : ''}`} />
            {detecting ? 'Detecting…' : 'Re-detect now'}
          </Button>
        }
      />

      {isLoading ? (
        <p className="text-sm text-on-surface-variant">Loading…</p>
      ) : (
        <div className="space-y-6">
          <SymbiontSection
            title="Detected"
            description={`${detected.length} agent${detected.length === 1 ? '' : 's'} installed on this machine`}
            symbionts={detected}
            emptyMessage="No coding agents detected. Myco picks them up automatically once one is installed."
          />
          <SymbiontSection
            title="Not detected"
            description="Agents Myco supports but doesn't see on this machine"
            symbionts={notDetected}
            emptyMessage="Every supported agent is wired in."
            muted
          />
          {lastDetectionAt && (
            <p className="text-xs text-on-surface-variant">
              Last on-demand detection: {lastDetectionAt.toLocaleTimeString()}
            </p>
          )}
        </div>
      )}
    </PageContainer>
  );
}

interface SymbiontSectionProps {
  title: string;
  description: string;
  symbionts: SymbiontInfo[];
  emptyMessage: string;
  muted?: boolean;
}

function SymbiontSection({ title, description, symbionts, emptyMessage, muted }: SymbiontSectionProps) {
  return (
    <section className="space-y-3">
      <header>
        <h2 className="font-medium text-base text-on-surface">{title}</h2>
        <p className="text-sm text-on-surface-variant">{description}</p>
      </header>
      {symbionts.length === 0 ? (
        <p className="text-sm text-on-surface-variant italic">{emptyMessage}</p>
      ) : (
        <ul className={`space-y-2 ${muted ? 'opacity-70' : ''}`}>
          {symbionts.map((s) => (
            <SymbiontRow key={s.name} symbiont={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SymbiontRow({ symbiont }: { symbiont: SymbiontInfo }) {
  return (
    <li className="flex items-center justify-between gap-4 rounded-md border border-outline-variant bg-surface px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-on-surface">{symbiont.displayName}</span>
          <code className="text-xs text-on-surface-variant">{symbiont.name}</code>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {symbiont.detected ? (
          <Badge variant="outline" className="gap-1 border-green-700/30 text-green-700">
            <CheckCircle2 className="h-3 w-3" /> Detected
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-on-surface-variant">
            <XCircle className="h-3 w-3" /> Not on this machine
          </Badge>
        )}
        {symbiont.detected && (
          symbiont.globallyInstalled ? (
            <Badge variant="outline" className="gap-1 border-green-700/30 text-green-700">
              <CheckCircle2 className="h-3 w-3" /> Wired in
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-amber-700 border-amber-700/30">
              <XCircle className="h-3 w-3" /> Pending wire-in
            </Badge>
          )
        )}
      </div>
    </li>
  );
}
