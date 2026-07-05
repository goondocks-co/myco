import { useState } from 'react';
import { Copy, RefreshCw, ShieldCheck } from 'lucide-react';
import { Panel } from '../ui/panel';
import { Button } from '../ui/button';
import type { OkfStatusResponse, useOkfMaintain, useOkfValidate } from '../../hooks/use-okf';

export interface OkfActionsPanelProps {
  status: OkfStatusResponse;
  maintain: ReturnType<typeof useOkfMaintain>;
  validate: ReturnType<typeof useOkfValidate>;
}

/**
 * Action buttons for the OKF page. "Reveal in Finder" is deliberately
 * dropped (Phase 1 deviation #4) — no reveal endpoint exists anywhere in
 * the daemon and none is planned; Copy path ships instead. One-shot export
 * is API/CLI-only and is not surfaced as a UI action here — the spec's
 * Controls list for this page omits it.
 */
export function OkfActionsPanel({ status, maintain, validate }: OkfActionsPanelProps) {
  const [copied, setCopied] = useState(false);
  const disabled = !status.enabled;
  const busy = maintain.isPending || validate.isPending;

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(status.outputPath);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be unavailable (permissions, non-secure context);
      // failing silently is fine — the path is also visible as plain text.
    }
  }

  return (
    <Panel eyebrow="Actions" title="Maintenance">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={() => maintain.mutate(undefined)}
          disabled={disabled || busy}
        >
          <RefreshCw className={`h-4 w-4 mr-1.5 ${maintain.isPending ? 'animate-spin' : ''}`} />
          {maintain.isPending ? 'Maintaining…' : 'Maintain Now'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => validate.mutate(undefined)}
          disabled={disabled || busy}
        >
          <ShieldCheck className="h-4 w-4 mr-1.5" />
          {validate.isPending ? 'Validating…' : 'Validate'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void copyPath()}
          disabled={disabled}
        >
          <Copy className="h-4 w-4 mr-1.5" />
          {copied ? 'Copied' : 'Copy path'}
        </Button>
      </div>
    </Panel>
  );
}
