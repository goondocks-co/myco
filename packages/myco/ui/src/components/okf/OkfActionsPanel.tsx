import { useState } from 'react';
import { CheckCircle2, Copy, ShieldCheck } from 'lucide-react';
import { Panel } from '../ui/panel';
import { Button } from '../ui/button';
import { StatusDot } from '../ui/status-dot';
import { type OkfStatusResponse, type useOkfAcknowledge, type useOkfValidate } from '../../hooks/use-okf';

export interface OkfActionsPanelProps {
  status: OkfStatusResponse;
  acknowledge: ReturnType<typeof useOkfAcknowledge>;
  validate: ReturnType<typeof useOkfValidate>;
}

/**
 * Action buttons for the OKF page, plus the publish-block surface.
 * Maintenance is the async `okf-synthesize` scheduled task, not a
 * UI-triggered mutation — this panel only offers Validate (an on-demand
 * strict-validation check) and Copy path. "Reveal in Finder" is
 * deliberately dropped (Phase 1 deviation #4) — no reveal endpoint exists
 * anywhere in the daemon and none is planned. One-shot export is API/CLI-only
 * and is not surfaced as a UI action here — the spec's Controls list for
 * this page omits it.
 *
 * This is also the SINGLE publish-block surface on the OKF page, and it is
 * PURELY status-driven: a blocked synthesis run persists its findings to the
 * manifest, which `handleOkfStatus` folds into `status.publishEligibility`,
 * so a prior blocked run is visible on a plain page load/reload — no click
 * required to reveal it. "Acknowledge & publish" posts to
 * `/api/okf/acknowledge`, draining the pending findings so the next
 * `okf-synthesize` run publishes.
 */
export function OkfActionsPanel({ status, acknowledge, validate }: OkfActionsPanelProps) {
  const [copied, setCopied] = useState(false);
  const disabled = !status.enabled;
  const busy = validate.isPending || acknowledge.isPending;
  const publishBlocked = !status.publishEligibility.ok;

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
    <Panel eyebrow="Actions" title="Validate & publish">
      <div className="flex flex-wrap items-center gap-2">
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

      {publishBlocked && (
        <div
          className="mt-3 flex flex-col gap-2 rounded-md border border-ochre/30 bg-ochre/5 p-3"
          data-testid="okf-publish-eligibility-block"
        >
          <div className="flex items-center gap-1.5">
            <StatusDot tone="ochre" />
            <span className="text-sm font-medium text-on-surface">
              Publish blocked — {status.publishEligibility.findings.length} finding
              {status.publishEligibility.findings.length === 1 ? '' : 's'} need acknowledgement
            </span>
          </div>
          <p className="text-xs text-on-surface-variant">
            A synthesis run left this bundle blocked from publishing. Review the findings, then
            acknowledge to let the next run publish.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => acknowledge.mutate(undefined)}
            disabled={acknowledge.isPending}
          >
            <CheckCircle2 className="h-4 w-4 mr-1.5" />
            {acknowledge.isPending ? 'Acknowledging…' : 'Acknowledge & publish'}
          </Button>
        </div>
      )}
    </Panel>
  );
}
