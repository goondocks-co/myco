/**
 * OKF (Open Knowledge Format) page — a focused read surface for the
 * repository-carried wiki. The wiki itself is plain markdown on the file
 * system, best browsed in an editor — this page deliberately does NOT render
 * page bodies. It holds:
 *
 *   1. The publish-block banner (conditional) — the ONE human decision OKF
 *      ever asks for. "Acknowledge & publish" ships the blocked run's
 *      preserved pages immediately (POST /api/okf/acknowledge).
 *   2. Bundle status — validity, freshness, page count, generation — with
 *      "Open in VS Code" (the bundle is files; the editor is the browser).
 *   3. The Publish panel (conditional) — every page whose lineage-latest
 *      generation hasn't been claimed-and-materialized to disk yet, each with
 *      its own claim-to-publish control (content-claim system, spec §7). This
 *      is where a synthesis run's DB-only write gets a visible next step.
 *   4. The bundle's directory structure, as it exists on disk.
 *   5. What OKF is, with a link to the spec. Agents maintain the wiki
 *      automatically (scheduled okf-synthesize + the managed AGENTS.md
 *      pointer); a pointer problem surfaces here only when something is
 *      actually wrong.
 *
 * Capability enable, synthesis scope, output path, and the AGENTS.md pointer
 * toggle are configured on the Settings page (`/settings#okf`) — this page
 * reads state, it doesn't own config.
 */

import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ExternalLink, FileText, Folder } from 'lucide-react';
import { getAtPath } from '@myco/utils/dot-path';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { Panel } from '../components/ui/panel';
import { Surface } from '../components/ui/surface';
import { Button } from '../components/ui/button';
import { MetricCard } from '../components/ui/metric-card';
import { StatusDot, type StatusTone } from '../components/ui/status-dot';
import { CapabilityIndicator } from '../components/config/CapabilityIndicator';
import { ClaimControl } from '../components/content-claims/ClaimControl';
import { formatTimeAgo } from '../lib/format';
import {
  useOkfAcknowledge,
  useOkfDocuments,
  useOkfStatus,
  useInvalidateOkfStatus,
  type OkfPageSummary,
  type OkfStatusResponse,
} from '../hooks/use-okf';
import { useContentClaims } from '../hooks/use-content-claims';
import { useScopedConfig } from '../hooks/use-scoped-config';

const OKF_SPEC_URL = 'https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md';

/**
 * "Failed" (lastResult) takes priority over invalid/valid so a broken last
 * run is never masked by an otherwise-current bundle.
 */
function describeBundleStatus(status: OkfStatusResponse): { label: string; tone: StatusTone } {
  if (!status.bundleExists) return { label: 'Not generated', tone: 'outline' };
  if (status.lastResult && status.lastResult !== 'published' && status.lastResult !== 'cleanup_pending') {
    return { label: 'Failed', tone: 'terracotta' };
  }
  if (status.validation && !status.validation.ok) return { label: 'Invalid', tone: 'terracotta' };
  return { label: 'Valid', tone: 'sage' };
}

interface TreeFolder {
  name: string;
  pages: OkfPageSummary[];
}

/** Group published pages into root pages + one folder per top-level directory, alphabetical like the on-disk tree. */
function buildTree(pages: OkfPageSummary[]): { rootPages: OkfPageSummary[]; folders: TreeFolder[] } {
  const rootPages: OkfPageSummary[] = [];
  const folderMap = new Map<string, OkfPageSummary[]>();
  for (const page of pages) {
    const slash = page.path.indexOf('/');
    if (slash === -1) {
      rootPages.push(page);
      continue;
    }
    const folder = page.path.slice(0, slash);
    const list = folderMap.get(folder) ?? [];
    list.push(page);
    folderMap.set(folder, list);
  }
  rootPages.sort((a, b) => a.path.localeCompare(b.path));
  const folders = [...folderMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => ({ name, pages: list.sort((a, b) => a.path.localeCompare(b.path)) }));
  return { rootPages, folders };
}

function TreeFileRow({ page, indent }: { page: OkfPageSummary; indent: boolean }) {
  const basename = page.path.slice(page.path.lastIndexOf('/') + 1);
  return (
    <div className={`flex items-baseline gap-3 py-1 ${indent ? 'pl-9' : 'pl-3'}`}>
      <span className="flex items-center gap-2 font-mono text-sm text-on-surface">
        <FileText className="h-3.5 w-3.5 shrink-0 self-center text-on-surface-variant" />
        {basename}
      </span>
      {page.title && (
        <span className="truncate text-xs text-on-surface-variant">{page.title}</span>
      )}
    </div>
  );
}

function GeneratedFileRow({ name, indent }: { name: string; indent: boolean }) {
  return (
    <div className={`flex items-baseline gap-3 py-1 ${indent ? 'pl-9' : 'pl-3'}`}>
      <span className="flex items-center gap-2 font-mono text-sm text-on-surface-variant/70">
        <FileText className="h-3.5 w-3.5 shrink-0 self-center opacity-50" />
        {name}
      </span>
      <span className="text-xs text-on-surface-variant/70">generated</span>
    </div>
  );
}

/** The bundle's on-disk directory structure: content pages plus the generated index/log files. */
function OkfStructure() {
  const { data, isLoading } = useOkfDocuments();
  const tree = useMemo(() => buildTree(data?.pages ?? []), [data?.pages]);

  if (isLoading) {
    return <p className="px-3 py-2 text-sm text-on-surface-variant">Loading structure…</p>;
  }
  if (tree.rootPages.length === 0 && tree.folders.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-on-surface-variant">
        No pages published yet — the scheduled okf-synthesize task writes the first ones.
      </p>
    );
  }

  return (
    <div className="py-1" data-testid="okf-structure">
      <GeneratedFileRow name="index.md" indent={false} />
      <GeneratedFileRow name="log.md" indent={false} />
      {tree.rootPages.map((page) => (
        <TreeFileRow key={page.path} page={page} indent={false} />
      ))}
      {tree.folders.map((folder) => (
        <div key={folder.name}>
          <div className="flex items-center gap-2 py-1 pl-3 font-mono text-sm text-on-surface">
            <Folder className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />
            {folder.name}/
          </div>
          <GeneratedFileRow name="index.md" indent />
          {folder.pages.map((page) => (
            <TreeFileRow key={page.path} page={page} indent />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The claim-to-publish surface (spec §7): every OKF page whose lineage-latest
 * generation hasn't been published yet, one `ClaimControl` per page. This is
 * where the okf-synthesize task's DB-only write (§0 — "one mechanism...
 * synthesize DB-only everywhere") gets a visible next step instead of ending
 * silently — a run that stages new page generations makes them show up here,
 * each with its own Publish / Release affordance. Renders
 * nothing once every page is caught up with what's published.
 */
function OkfClaimsPanel() {
  const { data, isLoading } = useContentClaims();
  const pages = (data?.claimable ?? []).filter((c) => c.artifact_kind === 'okf_page');

  if (isLoading || pages.length === 0) return null;

  return (
    <Panel eyebrow="Publish" title="Pages ready to publish" data-testid="okf-claims-panel">
      <div className="space-y-3">
        {pages.map((page) => (
          <div key={page.artifact_id} className="space-y-2">
            <p className="font-sans text-sm text-on-surface m-0">{page.label}</p>
            <ClaimControl artifactKind="okf_page" artifactId={page.artifact_id} />
          </div>
        ))}
      </div>
    </Panel>
  );
}

export default function Okf() {
  const { data: status, isLoading, isError } = useOkfStatus();
  const { effective: config } = useScopedConfig();
  const invalidateOkfStatus = useInvalidateOkfStatus();
  const acknowledge = useOkfAcknowledge();

  // Gate on the live merged config — Settings' Enable OKF field writes
  // `okf.enabled` through ScopedField, which invalidates the merged-config
  // query, so this flips reactively without a manual reload (the status
  // query's `enabled` field lags behind that write). Refetch status on the
  // transition so bundle metadata reflects the new state too.
  const configEnabled = getAtPath((config ?? {}) as Record<string, unknown>, 'okf.enabled') === true;
  useEffect(() => {
    invalidateOkfStatus();
  }, [configEnabled, invalidateOkfStatus]);

  const unresolved = isLoading || isError || !status;
  const enabled = !unresolved && configEnabled;
  const chip = status ? describeBundleStatus(status) : null;
  const publishBlocked = !!status && !status.publishEligibility.ok;
  const pointerProblem = !!status && (!status.agentsPointer.present || status.agentsPointer.stale);

  return (
    <PageContainer>
      <PageHeader
        title="OKF"
        subtitle="Repository-carried Open Knowledge Format wiki"
        actions={<CapabilityIndicator capability="okf" />}
      />

      {isLoading && (
        <Surface className="px-4 py-6 text-sm text-on-surface-variant">Loading OKF status…</Surface>
      )}

      {isError && !isLoading && (
        <Surface className="px-4 py-6 text-sm text-on-surface-variant" data-testid="okf-status-error">
          Couldn't load OKF status.
        </Surface>
      )}

      {!unresolved && !enabled && (
        <Panel eyebrow="Opt-in" title="OKF is disabled for this project">
          <p className="text-sm text-on-surface-variant">
            OKF publishes a portable, repository-carried knowledge wiki any agent can read and
            maintain without Myco. Enable it from the capability indicator above (capabilities are
            managed per project on the Groves page); advanced knobs live on the{' '}
            <Link to="/settings#okf" className="text-primary hover:underline">
              Settings
            </Link>{' '}
            page.
          </p>
          {status?.bundleExists && (
            <p className="mt-2 text-xs text-on-surface-variant">
              A bundle already exists at <span className="font-mono">{status.outputPath}</span> from a
              previous run — re-enable to resume maintaining it.
            </p>
          )}
        </Panel>
      )}

      {!unresolved && enabled && (
        <>
          {publishBlocked && (
            <Surface
              className="flex flex-col gap-2 border border-ochre/30 bg-ochre/5 px-4 py-3"
              data-testid="okf-publish-eligibility-block"
            >
              <div className="flex items-center gap-1.5">
                <StatusDot tone="ochre" />
                <span className="text-sm font-medium text-on-surface">
                  Publish blocked — {status.publishEligibility.findings.length} finding
                  {status.publishEligibility.findings.length === 1 ? '' : 's'} need review
                </span>
              </div>
              <ul className="space-y-0.5 pl-4 text-xs text-on-surface-variant">
                {status.publishEligibility.findings.map((f, i) => (
                  <li key={`${f.code}-${f.path}-${i}`} className="font-mono">
                    {f.code} · {f.path}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-on-surface-variant">
                The blocked run's pages are preserved — acknowledging publishes them immediately, no
                re-synthesis.
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() => acknowledge.mutate(undefined)}
                disabled={acknowledge.isPending}
              >
                <CheckCircle2 className="h-4 w-4 mr-1.5" />
                {acknowledge.isPending ? 'Publishing…' : 'Acknowledge & publish'}
              </Button>
            </Surface>
          )}

          <Panel
            eyebrow="Bundle"
            title="Status"
            actions={
              <div className="flex items-center gap-3">
                {chip && (
                  <div className="flex items-center gap-1.5" data-testid="okf-status-chip">
                    <StatusDot tone={chip.tone} />
                    <span className="font-mono text-xs text-on-surface-variant">{chip.label}</span>
                  </div>
                )}
                {status.claimedBundleExists && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      window.location.href = `vscode://file${status.outputRoot}`;
                    }}
                    data-testid="okf-open-in-editor"
                  >
                    <ExternalLink className="h-4 w-4 mr-1.5" />
                    Open in VS Code
                  </Button>
                )}
              </div>
            }
          >
            <div className="grid grid-cols-3 gap-3">
              <MetricCard
                label="Generated"
                value={status.generatedAt ? formatTimeAgo(status.generatedAt) : 'Never'}
              />
              <MetricCard label="Pages" value={status.pageCount ?? '—'} />
              <MetricCard label="Generation" value={status.bundleGeneration ?? '—'} />
            </div>
          </Panel>

          <OkfClaimsPanel />

          <Panel eyebrow="Structure" title={<span className="font-mono">{status.outputPath}/</span>} padded={false}>
            <OkfStructure />
          </Panel>

          <Panel eyebrow="About" title="What is OKF?">
            <p className="text-sm text-on-surface-variant">
              The{' '}
              <a
                href={OKF_SPEC_URL}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                Open Knowledge Format
              </a>{' '}
              is an open specification for a plain-markdown knowledge wiki that lives inside the
              repository. Because it's just files, every contributor and coding agent can read it —
              with or without Myco. Myco synthesizes and maintains it automatically from the
              project's accumulated intelligence via the scheduled okf-synthesize task, and a
              managed pointer in AGENTS.md tells other agents where to find and how to maintain it.
            </p>
            {pointerProblem && (
              <p className="mt-2 text-xs text-ochre" data-testid="okf-pointer-warning">
                The AGENTS.md pointer is {status.agentsPointer.present ? 'stale' : 'missing'} — run
                `myco update` (or toggle the pointer on Settings) to restore it.
              </p>
            )}
          </Panel>
        </>
      )}
    </PageContainer>
  );
}
