import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, RefreshCw, ShieldCheck } from 'lucide-react';
import { Panel } from '../ui/panel';
import { Button } from '../ui/button';
import { StatusDot } from '../ui/status-dot';
import { parseOkfMaintainError, type OkfStatusResponse, type useOkfMaintain, type useOkfValidate } from '../../hooks/use-okf';

export interface OkfActionsPanelProps {
  status: OkfStatusResponse;
  maintain: ReturnType<typeof useOkfMaintain>;
  validate: ReturnType<typeof useOkfValidate>;
}

/**
 * Action buttons for the OKF page, plus the Maintain-error surface. A naive
 * first-time user clicking "Maintain Now" must always SEE the outcome — the
 * Phase-1 bug this fixes was a 422 publish-block the UI silently swallowed.
 * The publish-not-acknowledged block renders findings + an inline
 * "Acknowledge & publish" action right here on the Maintain path; every
 * other maintain failure (not_implemented, okf_validation_failed, etc.)
 * renders as a plain error message. "Reveal in Finder" is deliberately
 * dropped (Phase 1 deviation #4) — no reveal endpoint exists anywhere in
 * the daemon and none is planned; Copy path ships instead. One-shot export
 * is API/CLI-only and is not surfaced as a UI action here — the spec's
 * Controls list for this page omits it.
 *
 * This is also the SINGLE publish-block surface on the OKF page, fed from
 * two sources: a click-driven 422 on the mutation just attempted
 * (`maintainError`, above), and a load-time signal from `status` — a PRIOR
 * run can leave the bundle blocked (`status.publishEligibility.ok ===
 * false`), which must be visible on a plain page load/reload, not only
 * after a fresh click, or a blocked bundle silently reads as fine until the
 * next Maintain attempt. When a click-driven error is present it takes
 * priority (freshest); the load-time block only renders when there is no
 * active mutation error, so the two never double-render.
 */
export function OkfActionsPanel({ status, maintain, validate }: OkfActionsPanelProps) {
  const [copied, setCopied] = useState(false);
  const disabled = !status.enabled;
  const busy = maintain.isPending || validate.isPending;
  const maintainError = parseOkfMaintainError(maintain.error);
  const loadPublishBlocked = !maintainError && !status.publishEligibility.ok;

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
    <Panel eyebrow="Actions" title="Maintain & validate">
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

      {maintainError && (
        <div
          className="mt-3 flex flex-col gap-2 rounded-md border border-terracotta/30 bg-terracotta/5 p-3"
          data-testid="okf-maintain-error"
        >
          {maintainError.code === 'okf_publish_not_acknowledged' ? (
            <>
              <div className="flex items-center gap-1.5">
                <StatusDot tone="ochre" />
                <span className="text-sm font-medium text-on-surface">
                  Publish blocked — {(maintainError.findings ?? []).length} finding
                  {(maintainError.findings ?? []).length === 1 ? '' : 's'} need acknowledgement
                </span>
              </div>
              <p className="text-xs text-on-surface-variant">
                Maintain generated a bundle but publishing it needs review first. Acknowledge to
                publish anyway, or fix the flagged pages and try again.
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() => maintain.mutate({ acknowledgePublish: true })}
                disabled={maintain.isPending}
              >
                <CheckCircle2 className="h-4 w-4 mr-1.5" />
                {maintain.isPending ? 'Acknowledging…' : 'Acknowledge & publish'}
              </Button>
            </>
          ) : (
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-terracotta" />
              <div>
                <p className="text-sm font-medium text-on-surface">Maintain failed</p>
                <p className="text-xs text-on-surface-variant">
                  {maintainError.validationHint ?? maintainError.message}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {loadPublishBlocked && (
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
            A previous run left this bundle blocked from publishing. Review the findings, then
            acknowledge to allow it to publish.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => maintain.mutate({ acknowledgePublish: true })}
            disabled={maintain.isPending}
          >
            <CheckCircle2 className="h-4 w-4 mr-1.5" />
            {maintain.isPending ? 'Acknowledging…' : 'Acknowledge & publish'}
          </Button>
        </div>
      )}
    </Panel>
  );
}
