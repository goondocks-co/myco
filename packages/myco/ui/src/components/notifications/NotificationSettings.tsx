import { useCallback } from 'react';
import { useScopedConfig } from '../../hooks/use-scoped-config';
import { useNotificationRegistry } from '../../hooks/use-notifications';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Switch } from '../ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { ScopedField } from '../config/ScopedField';
import { ScopePill } from '../config/ScopePill';

const MODE_LABELS = {
  banner: 'Banner',
  summary: 'Summary',
} as const;

type Mode = 'banner' | 'summary';

function SectionCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-outline-variant/20 bg-surface-container/40 p-4">{children}</div>;
}

/**
 * Notifications — personal-default throughout. Notification preferences are
 * deeply personal (noise tolerance, per-domain filtering), so every field
 * writes to the local scope unless the user promotes it via the Personal pill.
 */
export function NotificationSettings() {
  const { effective, setField, resetField, promoteField, isLocalOverride } = useScopedConfig();
  const { data: registryData } = useNotificationRegistry();
  const domains = registryData?.domains ?? [];

  const notifEnabled = effective?.notifications?.enabled ?? true;
  const defaultMode = effective?.notifications?.default_mode ?? 'summary';
  const controlsDisabled = !notifEnabled;

  const handleDomainMode = useCallback(
    async (domain: string, value: string) => {
      const path = `notifications.domains.${domain}.mode`;
      if (value === 'default') {
        await resetField(path);
      } else {
        await setField(path, value as Mode, 'local');
      }
    },
    [resetField, setField],
  );

  const handleDomainEnabled = useCallback(
    async (domain: string, enabled: boolean) => {
      await setField(`notifications.domains.${domain}.enabled`, enabled, 'local');
    },
    [setField],
  );

  if (!effective) return null;

  return (
    <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-sage">
      <SectionHeader>Notifications</SectionHeader>

      <div className="space-y-4">
        <SectionCard>
          <ScopedField
            path="notifications.enabled"
            label="Notifications"
            hint="master switch for this project"
            defaultScope="local"
          >
            {({ value, onChange }) => (
              <Switch checked={value ?? true} onCheckedChange={onChange} />
            )}
          </ScopedField>
        </SectionCard>

        <div className={controlsDisabled ? 'space-y-4 opacity-60' : 'space-y-4'}>
          <SectionCard>
            <ScopedField
              path="notifications.default_mode"
              label="Default Display"
              hint="summary = panel only; banner = temporary popup"
              defaultScope="local"
            >
              {({ value, onChange }) => (
                <Select
                  value={value ?? 'summary'}
                  onValueChange={(v) => onChange(v as Mode)}
                  disabled={controlsDisabled}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="summary">Summary</SelectItem>
                    <SelectItem value="banner">Banner</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </ScopedField>
          </SectionCard>

          <SectionCard>
            <ScopedField
              path="notifications.system_notifications"
              label="Browser Notifications"
              hint="OS popups when tab unfocused; only for banner mode"
              defaultScope="local"
            >
              {({ value, onChange }) => (
                <Switch checked={value ?? false} onCheckedChange={onChange} disabled={controlsDisabled} />
              )}
            </ScopedField>
          </SectionCard>

          {domains.length > 0 && (
            <SectionCard>
              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="font-sans text-sm font-medium text-on-surface">Per-Domain Overrides</label>
                  <p className="font-sans text-xs text-on-surface-variant">
                    Leave on `Default` unless a domain should behave differently from the project-wide setting.
                  </p>
                </div>

                <div className="space-y-2">
                  {domains.map((d) => {
                    const domainConfig = effective.notifications?.domains?.[d.domain] ?? { enabled: true };
                    const domainEnabled = domainConfig.enabled;
                    const effectiveMode = (domainConfig.mode ?? defaultMode) as Mode;
                    const modeValue = domainConfig.mode ?? 'default';
                    const domainPath = `notifications.domains.${d.domain}`;
                    const personal = isLocalOverride(domainPath);

                    return (
                      <div
                        key={d.domain}
                        className="rounded-md border border-outline-variant/20 bg-surface-container-low/40 px-3 py-3"
                      >
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-on-surface">{d.label}</span>
                              <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[11px] text-on-surface-variant">
                                {domainEnabled ? MODE_LABELS[effectiveMode] : 'Off'}
                              </span>
                              {personal && (
                                <ScopePill
                                  onPromote={() => promoteField(domainPath)}
                                  onReset={() => resetField(domainPath)}
                                />
                              )}
                            </div>
                            <p className="text-[11px] text-on-surface-variant">
                              {d.types.map((t) => t.label).join(', ')}
                            </p>
                          </div>

                          <div className="flex items-center gap-2 self-start">
                            <Select
                              value={modeValue}
                              onValueChange={(v) => { void handleDomainMode(d.domain, v); }}
                              disabled={controlsDisabled || !domainEnabled}
                            >
                              <SelectTrigger className="h-8 w-[120px] text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="default">Default</SelectItem>
                                <SelectItem value="summary">Summary</SelectItem>
                                <SelectItem value="banner">Banner</SelectItem>
                              </SelectContent>
                            </Select>
                            <Switch
                              checked={domainEnabled}
                              onCheckedChange={(v) => { void handleDomainEnabled(d.domain, v); }}
                              disabled={controlsDisabled}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </SectionCard>
          )}

          {controlsDisabled && (
            <p className="font-sans text-xs text-on-surface-variant">Notifications are currently disabled, so display and domain settings are inactive.</p>
          )}
        </div>
      </div>
    </Surface>
  );
}

