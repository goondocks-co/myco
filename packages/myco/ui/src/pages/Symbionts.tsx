/**
 * Symbionts page — global view of every coding agent Myco knows about,
 * the machine-detection status, and whether Myco's global config is
 * actually wired into each detected agent. The on-demand "Re-detect now"
 * button invokes `runSymbiontDetection()` on the daemon, which installs
 * the global config into any newly-detected agent and emits the same
 * notifications the periodic PowerManager tick would.
 *
 * When a project is selected via the upper-left Grove/project switcher,
 * a per-project section renders below the global list: enable/disable
 * each symbiont in this project's myco.yaml, commit Myco config to the
 * repo (portable Grove identity + optional launcher/binary pinning),
 * and run the brownfield migration walker on demand.
 */

import { useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  XCircle,
  RefreshCw,
  GitCommitVertical,
  Trash2,
  Loader2,
} from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { PageContainer } from '../components/ui/page-container';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import { Input } from '../components/ui/input';
import { fetchJson } from '../lib/api';
import { useSymbionts, type SymbiontInfo } from '../hooks/use-symbionts';
import { useProjectSelection } from '../hooks/use-project-selection';
import { useGroves } from '../hooks/use-groves';
import {
  usePatchProjectSymbionts,
  useCommitToRepo,
  useUncommitFromRepo,
  useDrainMigration,
} from '../hooks/use-project-symbionts';

export default function Symbionts() {
  const { data, isLoading, refetch } = useSymbionts();
  const queryClient = useQueryClient();
  const selection = useProjectSelection();
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
        actions={
          <Button onClick={redetect} disabled={detecting} variant="outline" size="sm">
            <RefreshCw className={`h-4 w-4 mr-1.5 ${detecting ? 'animate-spin' : ''}`} />
            {detecting ? 'Detecting…' : 'Re-detect now'}
          </Button>
        }
      />

      {isLoading ? (
        <p className="text-sm text-on-surface-variant">Loading…</p>
      ) : (
        <div className="space-y-8">
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
            emptyMessage="Every supported agent is installed on this machine."
            muted
          />
          {selection && (
            <ProjectOverridesSection
              detectedSymbionts={detected}
            />
          )}
          <OperationalActionsSection />
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

function ProjectOverridesSection({ detectedSymbionts }: { detectedSymbionts: SymbiontInfo[] }) {
  const selection = useProjectSelection();
  if (!selection) return null;

  return (
    <section className="space-y-3 pt-6 border-t border-outline-variant/40">
      <header>
        <h2 className="font-medium text-base text-on-surface">In {selection.project.name}</h2>
        <p className="text-sm text-on-surface-variant">
          Per-project overrides written to <code>.myco/myco.yaml</code>. Toggling off here keeps the
          agent wired globally but skips this project.
        </p>
      </header>
      {detectedSymbionts.length === 0 ? (
        <p className="text-sm text-on-surface-variant italic">
          No detected agents on this machine yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {detectedSymbionts.map((s) => (
            <ProjectSymbiontRow key={s.name} symbiont={s} />
          ))}
        </ul>
      )}
      <CommitToRepoCard />
    </section>
  );
}

function ProjectSymbiontRow({ symbiont }: { symbiont: SymbiontInfo }) {
  const patch = usePatchProjectSymbionts();
  const onToggle = (next: boolean) => {
    patch.mutate({ symbionts: { [symbiont.name]: { enabled: next } } });
  };
  return (
    <li className="flex items-center justify-between gap-4 rounded-md border border-outline-variant bg-surface px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-on-surface">{symbiont.displayName}</span>
          <code className="text-xs text-on-surface-variant">{symbiont.name}</code>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {patch.isError && (
          <Badge variant="outline" className="text-red-700 border-red-700/30">
            Failed
          </Badge>
        )}
        <Switch
          checked={symbiont.enabled}
          onCheckedChange={onToggle}
          disabled={patch.isPending}
        />
      </div>
    </li>
  );
}

function CommitToRepoCard() {
  const selection = useProjectSelection();
  const { data: groves } = useGroves();
  const commit = useCommitToRepo();
  const uncommit = useUncommitFromRepo();

  const [writeLaunchers, setWriteLaunchers] = useState(false);
  const [runtimeCommand, setRuntimeCommand] = useState('');
  const [preserveLaunchers, setPreserveLaunchers] = useState(false);
  const [preserveRuntimeCommand, setPreserveRuntimeCommand] = useState(false);

  if (!selection) return null;

  const project = groves?.groves
    .find((g) => g.id === selection.grove.id)
    ?.projects.find((p) => p.project_id === selection.project.project_id);
  const committed = project?.manifest_state === 'present';
  const invalid = project?.manifest_state === 'invalid';

  const onCommit = () => {
    const body: { write_launchers?: boolean; runtime_command?: string } = {};
    if (writeLaunchers) body.write_launchers = true;
    if (runtimeCommand.trim().length > 0) body.runtime_command = runtimeCommand.trim();
    commit.mutate(body);
  };

  const onUncommit = () => {
    const body: { remove_launchers?: boolean; remove_runtime_command?: boolean } = {};
    if (preserveLaunchers) body.remove_launchers = false;
    if (preserveRuntimeCommand) body.remove_runtime_command = false;
    uncommit.mutate(body);
  };

  return (
    <div className="rounded-md border border-outline-variant bg-surface px-4 py-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-on-surface">
            Commit Myco config to this repo
          </h3>
          <p className="text-xs text-on-surface-variant">
            Writes <code>.myco/project.toml</code> so teammates cloning the repo resolve to the same
            Grove identity on their own machines.
          </p>
        </div>
        {committed && (
          <Badge variant="outline" className="gap-1 border-green-700/30 text-green-700 shrink-0">
            <CheckCircle2 className="h-3 w-3" /> Committed
          </Badge>
        )}
        {invalid && (
          <Badge variant="outline" className="gap-1 border-red-700/30 text-red-700 shrink-0">
            <XCircle className="h-3 w-3" /> Manifest invalid
          </Badge>
        )}
      </div>

      {!committed && (
        <div className="space-y-3 pt-2">
          <details className="text-xs">
            <summary className="cursor-pointer text-on-surface-variant select-none">
              Advanced (dogfood/dev)
            </summary>
            <div className="space-y-3 pt-3 pl-4">
              <label className="flex items-center gap-2">
                <Switch checked={writeLaunchers} onCheckedChange={setWriteLaunchers} />
                <span className="text-on-surface">
                  Write project-local launchers
                  <span className="text-on-surface-variant">
                    {' '}— <code>.agents/myco-run.cjs</code> + <code>myco-cli.cjs</code>
                  </span>
                </span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-on-surface">
                  Pin Myco binary
                  <span className="text-on-surface-variant"> — writes <code>.myco/runtime.command</code></span>
                </span>
                <Input
                  type="text"
                  placeholder="/absolute/path/to/myco-dev"
                  value={runtimeCommand}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setRuntimeCommand(e.target.value)}
                />
              </label>
            </div>
          </details>
          <div className="flex items-center gap-2">
            <Button onClick={onCommit} disabled={commit.isPending} size="sm">
              {commit.isPending ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <GitCommitVertical className="h-4 w-4 mr-1.5" />
              )}
              Commit to repo
            </Button>
            {commit.isError && (
              <span className="text-xs text-red-700">
                {(commit.error as Error)?.message ?? 'Commit failed'}
              </span>
            )}
            {commit.data && commit.data.wrote.length > 0 && (
              <span className="text-xs text-on-surface-variant">
                Wrote {commit.data.wrote.length} file{commit.data.wrote.length === 1 ? '' : 's'}.
              </span>
            )}
          </div>
        </div>
      )}

      {committed && (
        <div className="space-y-3 pt-2">
          <details className="text-xs">
            <summary className="cursor-pointer text-on-surface-variant select-none">
              Advanced (dogfood/dev)
            </summary>
            <div className="space-y-3 pt-3 pl-4">
              <label className="flex items-center gap-2">
                <Switch checked={preserveLaunchers} onCheckedChange={setPreserveLaunchers} />
                <span className="text-on-surface">
                  Preserve project-local launchers
                  <span className="text-on-surface-variant">
                    {' '}— keep <code>.agents/myco-run.cjs</code> + <code>myco-cli.cjs</code>
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={preserveRuntimeCommand} onCheckedChange={setPreserveRuntimeCommand} />
                <span className="text-on-surface">
                  Preserve binary pin
                  <span className="text-on-surface-variant"> — keep <code>.myco/runtime.command</code></span>
                </span>
              </label>
            </div>
          </details>
          <div className="flex items-center gap-2">
            <Button onClick={onUncommit} disabled={uncommit.isPending} variant="outline" size="sm">
              {uncommit.isPending ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1.5" />
              )}
              Remove from repo
            </Button>
            {uncommit.isError && (
              <span className="text-xs text-red-700">
                {(uncommit.error as Error)?.message ?? 'Remove failed'}
              </span>
            )}
            {uncommit.data && (
              <span className="text-xs text-on-surface-variant">
                Removed {uncommit.data.removed.length} file{uncommit.data.removed.length === 1 ? '' : 's'}.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function OperationalActionsSection() {
  const drain = useDrainMigration();
  return (
    <section className="space-y-2 pt-4 border-t border-outline-variant/40">
      <header>
        <h2 className="font-medium text-base text-on-surface">Operational actions</h2>
        <p className="text-sm text-on-surface-variant">
          Manual triggers for the daemon's housekeeping. The PowerManager periodic tick runs these
          automatically; the buttons let you fire them on demand.
        </p>
      </header>
      <div className="flex items-center gap-2 pt-1">
        <Button
          onClick={() => drain.mutate()}
          disabled={drain.isPending}
          variant="outline"
          size="sm"
        >
          {drain.isPending ? (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-1.5" />
          )}
          {drain.isPending ? 'Running…' : 'Run migration sweep'}
        </Button>
        {drain.isError && (
          <span className="text-xs text-red-700">
            {(drain.error as Error)?.message ?? 'Sweep failed'}
          </span>
        )}
        {drain.data && (
          <span className="text-xs text-on-surface-variant">
            Visited {drain.data.migration.projectsVisited} project
            {drain.data.migration.projectsVisited === 1 ? '' : 's'}, cleaned{' '}
            {drain.data.migration.projectsCleaned}.
          </span>
        )}
      </div>
    </section>
  );
}
