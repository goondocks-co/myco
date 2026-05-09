import { useEffect, useState } from 'react';
import { Cpu, RefreshCw, ScrollText, ArrowUpCircle } from 'lucide-react';
import { useDaemon } from '../hooks/use-daemon';
import {
  useMachineConfig,
  useUpdateMachineConfig,
  type MachineConfig,
  type MachineConfigPatch,
} from '../hooks/use-machine-config';
import {
  useUpdateStatus,
  useUpdateCheck,
} from '../hooks/use-update-status';
import { PageHeader } from '../components/ui/page-header';
import { Surface } from '../components/ui/surface';
import { SectionHeader } from '../components/ui/section-header';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { FieldShell } from '../components/config/FieldShell';
import { cn } from '../lib/cn';

/* ---------- Helpers ---------- */

/**
 * Tiny field-row primitive used by every editable card on this page.
 * Thin wrapper over `FieldShell` that locks the scope badge to
 * 'machine' (toggle off via `badge={false}` for read-only stats rows
 * like the machine-id display).
 */
function Field({
  id,
  label,
  helper,
  badge = true,
  children,
}: {
  id?: string;
  label: string;
  helper?: string;
  badge?: boolean;
  children: React.ReactNode;
}) {
  return (
    <FieldShell id={id} label={label} helper={helper} scope={badge ? 'machine' : null}>
      {children}
    </FieldShell>
  );
}

/* ---------- Cards ---------- */

function DaemonConfigurationCard({
  config,
  onPatch,
  isSaving,
}: {
  config: MachineConfig;
  onPatch: (patch: MachineConfigPatch) => void;
  isSaving: boolean;
}) {
  const { data: stats } = useDaemon();
  const runningPort = stats?.daemon.port ?? null;
  const configuredPort = config.daemon.port;

  // Local string state so the user can clear the field while typing.
  const [draft, setDraft] = useState<string>(
    configuredPort === null ? '' : String(configuredPort),
  );
  useEffect(() => {
    setDraft(configuredPort === null ? '' : String(configuredPort));
  }, [configuredPort]);

  const portMismatch =
    configuredPort !== null && runningPort !== null && configuredPort !== runningPort;

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      if (configuredPort !== null) {
        onPatch({ daemon: { port: null } });
      }
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      // Reject — snap back to the saved value so the user sees that we
      // refused the change.
      setDraft(configuredPort === null ? '' : String(configuredPort));
      return;
    }
    if (parsed !== configuredPort) {
      onPatch({ daemon: { port: parsed } });
    }
  };

  return (
    <Surface level="low" className="rounded-lg p-6 space-y-5">
      <SectionHeader>Daemon Configuration</SectionHeader>
      <Field
        id="machine-daemon-port"
        label="Port"
        helper="Restart-required to take effect."
      >
        <div className="flex items-center gap-2">
          <Input
            id="machine-daemon-port"
            inputMode="numeric"
            placeholder="Auto"
            value={draft}
            disabled={isSaving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            className="max-w-[10rem]"
          />
          {portMismatch && (
            <Badge variant="warning">Restart required</Badge>
          )}
        </div>
      </Field>
    </Surface>
  );
}

function LoggingCard({
  config,
  onPatch,
  isSaving,
}: {
  config: MachineConfig;
  onPatch: (patch: MachineConfigPatch) => void;
  isSaving: boolean;
}) {
  const retention = config.daemon.log_retention_days;
  const [retentionDraft, setRetentionDraft] = useState<string>(String(retention));
  useEffect(() => {
    setRetentionDraft(String(retention));
  }, [retention]);

  const commitRetention = () => {
    const parsed = Number(retentionDraft.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
      setRetentionDraft(String(retention));
      return;
    }
    if (parsed !== retention) {
      onPatch({ daemon: { log_retention_days: parsed } });
    }
  };

  return (
    <Surface level="low" className="rounded-lg p-6 space-y-5">
      <div className="flex items-center gap-2">
        <ScrollText className="h-4 w-4 text-primary" />
        <SectionHeader>Logging</SectionHeader>
      </div>
      <Field id="machine-log-level" label="Log level">
        <Select
          value={config.daemon.log_level}
          onValueChange={(value) => {
            if (value !== config.daemon.log_level) {
              onPatch({
                daemon: { log_level: value as MachineConfig['daemon']['log_level'] },
              });
            }
          }}
          disabled={isSaving}
        >
          <SelectTrigger id="machine-log-level" className="max-w-[14rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="debug">debug</SelectItem>
            <SelectItem value="info">info</SelectItem>
            <SelectItem value="warn">warn</SelectItem>
            <SelectItem value="error">error</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        id="machine-log-retention"
        label="Log retention (days)"
        helper="Applies uniformly across every Grove DB on this machine."
      >
        <Input
          id="machine-log-retention"
          inputMode="numeric"
          value={retentionDraft}
          disabled={isSaving}
          onChange={(e) => setRetentionDraft(e.target.value)}
          onBlur={commitRetention}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          className="max-w-[10rem]"
        />
      </Field>
    </Surface>
  );
}

function UpdatesCard({
  config,
  onPatch,
  isSaving,
}: {
  config: MachineConfig;
  onPatch: (patch: MachineConfigPatch) => void;
  isSaving: boolean;
}) {
  const { data: status } = useUpdateStatus();
  const checkMutation = useUpdateCheck();
  return (
    <Surface level="low" className="rounded-lg p-6 space-y-5">
      <div className="flex items-center gap-2">
        <ArrowUpCircle className="h-4 w-4 text-primary" />
        <SectionHeader>Updates</SectionHeader>
      </div>
      <Field
        id="machine-update-channel"
        label="Update channel"
        helper="Channel determines which release lane the daemon pulls from on the next update check."
      >
        <Select
          value={config.daemon.update_channel}
          onValueChange={(value) => {
            if (value !== config.daemon.update_channel) {
              onPatch({
                daemon: {
                  update_channel: value as MachineConfig['daemon']['update_channel'],
                },
              });
            }
          }}
          disabled={isSaving}
        >
          <SelectTrigger id="machine-update-channel" className="max-w-[14rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">stable</SelectItem>
            <SelectItem value="beta">beta</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <div className="flex items-center gap-3 pt-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => checkMutation.mutate()}
          disabled={checkMutation.isPending}
        >
          <RefreshCw
            className={cn(
              'mr-1.5 h-3.5 w-3.5',
              checkMutation.isPending && 'animate-spin',
            )}
          />
          Check Now
        </Button>
        {status?.running_version && (
          <span className="font-mono text-xs text-outline">
            {status.running_version}
          </span>
        )}
      </div>
    </Surface>
  );
}

function MachineIdentityCard() {
  const { data: stats } = useDaemon();
  const machineId = stats?.context.request.machine_id ?? '—';
  return (
    <Surface level="low" className="rounded-lg p-6 space-y-5">
      <SectionHeader>Machine identity</SectionHeader>
      <Field label="Machine ID" badge={false}>
        <div className="font-mono text-sm text-on-surface break-all">
          {machineId}
        </div>
      </Field>
    </Surface>
  );
}

/* ---------- Page ---------- */

export default function MachineSettings() {
  const { data, isLoading } = useMachineConfig();
  const update = useUpdateMachineConfig();

  if (isLoading || !data) {
    return (
      <div className="p-6">
        <PageHeader
          title="Machine settings"
          subtitle="Machine-wide configuration for the Myco daemon. These apply to every Grove on this machine."
        />
        <p className="font-sans text-sm text-on-surface-variant mt-2">
          Loading machine configuration…
        </p>
      </div>
    );
  }

  const config = data.config;
  const onPatch = (patch: MachineConfigPatch) => {
    update.mutate(patch);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Cpu className="h-5 w-5 text-primary" />
        <PageHeader
          title="Machine settings"
          subtitle="Machine-wide configuration for the Myco daemon. These apply to every Grove on this machine."
          className="flex-1 pb-0"
        />
      </div>

      <DaemonConfigurationCard
        config={config}
        onPatch={onPatch}
        isSaving={update.isPending}
      />
      <LoggingCard
        config={config}
        onPatch={onPatch}
        isSaving={update.isPending}
      />
      <UpdatesCard
        config={config}
        onPatch={onPatch}
        isSaving={update.isPending}
      />
      <MachineIdentityCard />
    </div>
  );
}
