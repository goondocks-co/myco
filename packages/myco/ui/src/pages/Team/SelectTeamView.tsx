import { Network } from 'lucide-react';
import { Panel } from '../../components/ui/panel';
import { IconEyebrow } from '../../components/ui/icon-eyebrow';

/**
 * Shown on the team-scoped tabs (Status/Sync/Members) when no team is selected.
 * The Team page no longer auto-picks the first registered team, so an explicit
 * selection is required before any local-vs-cloud comparison is made.
 */
export function SelectTeamView({ hasTeams }: { hasTeams: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <Panel
        tone="sage"
        eyebrow={<IconEyebrow Icon={Network}>No team selected</IconEyebrow>}
        title="Select a team to view sync status"
      >
        <p className="text-sm text-on-surface-variant m-0">
          {hasTeams
            ? 'Choose a team from the selector in the header to view its status, sync state, and members.'
            : 'No teams are registered on this machine yet. Provision or join a team on the Teams tab, then return here.'}
        </p>
      </Panel>
    </div>
  );
}
