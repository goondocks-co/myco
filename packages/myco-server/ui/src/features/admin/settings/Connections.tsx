import { useState } from 'react';
import { SECRET_SLOTS } from '@goondocks/myco-shared/secret-slots';
import { ActionLink, Button, Dialog, DialogContent, ErrorState, LoadingState, Select } from '../../../design';
import { useAgentPayers } from '../../../hooks/use-fleet';
import { useProjects } from '../../../hooks/use-projects';
import { useSecrets, useSettings } from '../../../hooks/use-settings';
import { isArchived } from '../../../lib/api';
import { PROJECT_SETTINGS_ANCHORS, PROJECT_SETTINGS_SUFFIX, projectPath } from '../../../routes/nav';
import { AdminSection, RowCard, useAnchorScroll } from '../AdminFrame';
import { CREDENTIALS_ANCHOR } from './Credentials';
import { TELEMETRY_ANCHOR } from './TelemetryKeys';
import { useGitHubAppSetup } from '../../../hooks/use-settings';
import { KeyRows } from './Credentials';
import { GitHubRow } from './GitHubApp';
import { KeyForm } from './KeyDialog';
import { TelemetryKeyForm, TelemetryRows, useTelemetryKeys } from './TelemetryKeys';

/** The kinds of connection a person can add, each with only its own fields. */
const KINDS = [
  { id: 'key', label: 'A model key', detail: 'A key for an AI account, used where you choose it: agent work, quick jobs or search.' },
  { id: 'launcher', label: 'A launcher that reports activity', detail: 'A tool that starts agents and reports which session started which.' },
  { id: 'project', label: 'An agent that reads one project from outside', detail: 'A key for one project, made in that project’s settings.' },
] as const;
type Kind = (typeof KINDS)[number]['id'];

/**
 * Connections: one list of everything Myco holds a credential for — GitHub, each stored key and each telemetry key —
 * each saying what it is for and whether it works, with one way to add another.
 */
export function Connections() {
  const secrets = useSecrets();
  const settings = useSettings();
  const payers = useAgentPayers();
  const telemetry = useTelemetryKeys();
  const github = useGitHubAppSetup();
  const [adding, setAdding] = useState(false);
  useAnchorScroll(!secrets.isPending && !telemetry.isPending && !github.isPending);
  const uses = { payers: payers.data?.agents ?? [], quickJobs: settings.data?.quickJobs ?? null, embedding: settings.data?.embedding ?? null };
  return (
    <AdminSection id="connections" title="Everything Myco is connected to" description="One list. Each row says what it’s for and whether it’s working.">
      <RowCard label="Connections">
        <GitHubRow />
        <div id={CREDENTIALS_ANCHOR} className="scroll-mt-s6" />
        {secrets.isPending ? <LoadingState label="Loading keys" count={2} />
          : secrets.isError ? <ErrorState error={secrets.error} onRetry={() => void secrets.refetch()} />
          : <KeyRows secrets={secrets.data.secrets} uses={uses} />}
        <div id={TELEMETRY_ANCHOR} className="scroll-mt-s6" />
        {telemetry.isPending ? <LoadingState label="Loading telemetry keys" />
          : telemetry.isError ? <ErrorState error={telemetry.error} onRetry={() => void telemetry.refetch()} />
          : <TelemetryRows endpoint={telemetry.data.endpoint} keys={telemetry.data.keys} />}
        <div className="flex flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-center sm:justify-between sm:gap-s6">
          <p className="max-w-measure t-small text-muted">Add a model key, an agent that reads one project from outside, or a launcher that reports activity.</p>
          <Button variant="primary" className="shrink-0" onClick={() => setAdding(true)}>Add a connection</Button>
        </div>
      </RowCard>
      <AddConnection open={adding} onClose={() => setAdding(false)} />
    </AdminSection>
  );
}

/** "Add a connection": first what kind, then only that kind's fields. */
export function AddConnection({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const close = () => { setKind(null); onClose(); };
  const chosen = KINDS.find((k) => k.id === kind);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent title={chosen === undefined ? 'Add a connection' : chosen.label} description={chosen === undefined ? 'What are you connecting?' : chosen.detail}>
        {kind === null && (
          <ul className="flex flex-col gap-s2" aria-label="Kinds of connection">
            {KINDS.map((k) => (
              <li key={k.id}>
                <Button className="h-auto w-full justify-start py-s3 text-left" onClick={() => setKind(k.id)}>
                  <span className="flex flex-col items-start gap-s1">
                    <span className="t-body font-medium text-ink">{k.label}</span>
                    <span className="t-small text-muted whitespace-normal">{k.detail}</span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {kind === 'key' && <AddKey onDone={close} />}
        {kind === 'launcher' && <TelemetryKeyForm onDone={close} />}
        {kind === 'project' && <ProjectKeys />}
      </DialogContent>
    </Dialog>
  );
}

/** Which account the key is for, then the key. Choosing an account that has a key replaces it. */
function AddKey({ onDone }: { onDone: () => void }) {
  const secrets = useSecrets();
  const [name, setName] = useState<string>('');
  const stored = new Set((secrets.data?.secrets ?? []).filter((secret) => secret.configured).map((secret) => secret.name));
  return (
    <div className="flex flex-col gap-s3">
      <Select
        id="add-key-account"
        label="Whose key"
        value={name}
        placeholder="Choose the account"
        options={SECRET_SLOTS.map((slot) => ({ value: slot.name, label: stored.has(slot.name) ? `${slot.label} (replaces the stored key)` : slot.label }))}
        onValueChange={setName}
      />
      {name !== '' && <KeyForm key={name} name={name} onDone={onDone} onCancel={onDone} />}
    </div>
  );
}

/** Each live project, leading to its access keys: a project key is made where the project's other settings are. */
function ProjectKeys() {
  const projects = useProjects();
  const live = (projects.data?.projects ?? []).filter((project) => !isArchived(project));
  if (projects.isPending) return <LoadingState label="Loading projects" count={2} />;
  if (projects.isError) return <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />;
  if (live.length === 0) return <p className="t-small text-muted">No project accepts capture yet.</p>;
  return (
    <ul className="flex flex-col divide-y divide-line" aria-label="Projects">
      {live.map((project) => (
        <li key={project.projectId} className="flex items-center justify-between gap-s3 py-s2">
          <span className="t-body text-ink">{project.name}</span>
          <ActionLink to={`${projectPath(project.projectId, PROJECT_SETTINGS_SUFFIX)}#${PROJECT_SETTINGS_ANCHORS.accessKeys}`}>Its access keys →</ActionLink>
        </li>
      ))}
    </ul>
  );
}
