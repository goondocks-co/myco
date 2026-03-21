import type { MycoConfig } from '../../hooks/use-config';
import { ConfigSection } from './ConfigSection';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Field, SYNC_MODES, ToggleSwitch } from './config-helpers';

interface TeamSectionProps {
  team: MycoConfig['team'];
  isDirty: boolean;
  updateTeam: (key: string, value: unknown) => void;
}

export function TeamSection({ team, isDirty, updateTeam }: TeamSectionProps) {
  return (
    <ConfigSection
      title="Team"
      description="Multi-user collaboration settings"
      isDirty={isDirty}
    >
      <div className="space-y-4">
        <Field label="Enabled" description="Enable team knowledge sharing across vault users">
          <ToggleSwitch
            checked={team.enabled}
            onChange={(v) => updateTeam('enabled', v)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="User Name" description="Your display name for team attribution">
            <Input
              value={team.user}
              onChange={(e) => updateTeam('user', e.target.value)}
            />
          </Field>
          <Field label="Sync Mode" description="How team knowledge is synchronized between machines">
            <Select
              value={team.sync}
              onValueChange={(v) => updateTeam('sync', v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SYNC_MODES.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </div>
    </ConfigSection>
  );
}
