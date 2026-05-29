import { Terminal, CheckCircle2, ArrowRight } from 'lucide-react';
import { Navigate, Link, useSearchParams } from 'react-router-dom';
import { PageContainer } from '../components/ui/page-container';
import { useDaemon } from '../hooks/use-daemon';
import { useSymbionts } from '../hooks/use-symbionts';
import { useGroves } from '../hooks/use-groves';
import { selectionFromLast, defaultSelection, projectPath } from '../lib/selection';

export default function Onboarding() {
  const [searchParams] = useSearchParams();
  // `?preview` keeps this screen reachable even after projects exist — handy
  // for testing the first-run experience. Without it, a registered project
  // redirects straight to its dashboard (the real first-run behavior).
  const preview = searchParams.has('preview');

  const daemon = useDaemon();
  const symbionts = useSymbionts();
  // Poll so a fresh install advances into the project dashboard the moment the
  // first hook registers a project — no reload required. Skip polling in
  // preview so the intentionally-held view doesn't redirect out from under you.
  const groves = useGroves({ refetchInterval: preview ? undefined : 4_000 });

  const groveList = groves.data?.groves ?? [];
  const selection = selectionFromLast(groveList) ?? defaultSelection(groveList);
  if (selection && !preview) return <Navigate to={projectPath(selection)} replace />;

  const hasProjects = !!selection;
  const projectCount = groveList.reduce((sum, g) => sum + g.projects.length, 0);
  const detected = (symbionts.data?.symbionts ?? []).filter((s) => s.detected);
  const version = daemon.data?.daemon.version;
  const port = daemon.data?.daemon.port;

  return (
    <PageContainer variant="narrow" className="min-h-full justify-center">
      <div className="flex max-w-xl flex-col gap-6">
        <div className="flex flex-col gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Terminal className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-on-surface">
              {hasProjects ? "You're all set — Myco is capturing" : "You're set up — waiting for your first session"}
            </h1>
            <p className="mt-2 text-sm text-on-surface-variant">
              Open any git repository in a supported agent (Claude Code, Cursor, Codex, Copilot,
              Antigravity, Windsurf, OpenCode, or Pi). Myco registers the project automatically on the
              first hook and this page opens its dashboard. Capture is scoped to git repositories —
              work in a non-git folder isn't recorded.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-outline/40 bg-surface-container/40 p-4 text-sm">
          <div className="flex items-center gap-2 text-on-surface">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
            <span>
              Myco is running
              {version ? <span className="text-on-surface-variant"> · v{version}</span> : null}
              {port ? <span className="text-on-surface-variant"> · port {port}</span> : null}
            </span>
          </div>

          <div className="flex items-start gap-2 text-on-surface-variant">
            <span className="mt-px font-medium text-on-surface">Agents</span>
            <span>
              {detected.length > 0
                ? `${detected.length} detected — ${detected.map((s) => s.displayName).join(', ')}`
                : 'No supported coding agents detected on this machine yet'}
            </span>
          </div>

          {hasProjects && selection ? (
            <Link
              to={projectPath(selection)}
              className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
            >
              {projectCount} project{projectCount === 1 ? '' : 's'} registered — go to dashboard
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <div className="flex items-center gap-2 text-on-surface-variant">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
              <span>Waiting for your first session…</span>
            </div>
          )}
        </div>
      </div>
    </PageContainer>
  );
}
