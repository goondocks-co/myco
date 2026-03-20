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
import { Field, LOG_LEVELS, numChange } from './config-helpers';

interface DaemonSectionProps {
  daemon: MycoConfig['daemon'];
  isDirty: boolean;
  updateDaemon: (key: string, value: unknown) => void;
}

export function DaemonSection({ daemon, isDirty, updateDaemon }: DaemonSectionProps) {
  return (
    <ConfigSection
      title="Daemon"
      description="Daemon process settings"
      isDirty={isDirty}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Port" description="Leave empty for auto-assigned port">
          <Input
            type="number"
            value={daemon.port ?? ''}
            placeholder="Auto"
            onChange={(e) => {
              const val = e.target.value ? parseInt(e.target.value, 10) : null;
              updateDaemon('port', val !== null && !isNaN(val) ? val : null);
            }}
          />
        </Field>
        <Field label="Log Level">
          <Select
            value={daemon.log_level}
            onValueChange={(v) => updateDaemon('log_level', v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOG_LEVELS.map((l) => (
                <SelectItem key={l} value={l}>{l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Grace Period (sec)" description="Seconds to wait before shutting down idle daemon">
          <Input
            type="number"
            value={daemon.grace_period}
            onChange={numChange(updateDaemon as (k: string, v: number) => void, 'grace_period')}
          />
        </Field>
        <Field label="Max Log Size (bytes)">
          <Input
            type="number"
            value={daemon.max_log_size}
            onChange={numChange(updateDaemon as (k: string, v: number) => void, 'max_log_size')}
          />
        </Field>
      </div>
    </ConfigSection>
  );
}
