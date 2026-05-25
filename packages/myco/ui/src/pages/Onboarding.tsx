import { Terminal } from 'lucide-react';
import { PageContainer } from '../components/ui/page-container';

export default function Onboarding() {
  return (
    <PageContainer variant="narrow" className="min-h-full justify-center">
      <div className="flex flex-col gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Terminal className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-on-surface">No projects yet</h1>
          <p className="mt-2 max-w-xl text-sm text-on-surface-variant">
            This daemon hasn't seen a project yet. Open any git repository in a supported agent (Claude Code, Cursor, Codex, Copilot, Antigravity, Windsurf, OpenCode, or Pi) — Myco registers the project automatically on the first hook and it will appear here.
          </p>
        </div>
      </div>
    </PageContainer>
  );
}
