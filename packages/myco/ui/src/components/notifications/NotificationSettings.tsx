import { useState, useCallback, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useConfig } from '../../hooks/use-config';
import { useNotificationRegistry } from '../../hooks/use-notifications';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Switch } from '../ui/switch';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

const MODE_LABELS = {
  banner: 'Banner',
  summary: 'Summary',
} as const;

interface NotifFormState {
  enabled: boolean;
  system_notifications: boolean;
  default_mode: 'banner' | 'summary';
  domains: Record<string, { enabled: boolean; mode?: 'banner' | 'summary' }>;
}

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <label className="font-sans text-sm font-medium text-on-surface">
      {children}
      {hint && (
        <span className="ml-1 font-sans text-xs text-on-surface-variant font-normal">({hint})</span>
      )}
    </label>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="font-sans text-xs text-on-surface-variant">{children}</p>;
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-outline-variant/20 bg-surface-container/40 p-4">{children}</div>;
}

export function NotificationSettings() {
  const { config, saveConfig, isSaving } = useConfig();
  const { data: registryData } = useNotificationRegistry();
  const [form, setForm] = useState<NotifFormState | null>(null);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Initialize form from config
  useEffect(() => {
    if (config && !form) {
      setForm({
        enabled: config.notifications?.enabled ?? true,
        system_notifications: config.notifications?.system_notifications ?? false,
        default_mode: config.notifications?.default_mode ?? 'summary',
        domains: config.notifications?.domains ?? {},
      });
    }
  }, [config, form]);

  const setField = useCallback(<K extends keyof NotifFormState>(key: K, value: NotifFormState[K]) => {
    setForm(prev => (prev ? { ...prev, [key]: value } : prev));
    setSaveMessage(null);
  }, []);

  const updateDomain = useCallback((domain: string, update: Partial<NotifFormState['domains'][string]>) => {
    setForm(prev => {
      if (!prev) return prev;
      const current = prev.domains[domain] ?? { enabled: true };
      return {
        ...prev,
        domains: { ...prev.domains, [domain]: { ...current, ...update } },
      };
    });
    setSaveMessage(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!form || !config) return;
    setSaveMessage(null);
    try {
      await saveConfig({ notifications: form });
      setSaveMessage({ type: 'success', text: 'Notification settings saved.' });
    } catch {
      setSaveMessage({ type: 'error', text: 'Failed to save notification settings.' });
    }
  }, [form, config, saveConfig]);

  if (!form || !config) return null;

  const domains = registryData?.domains ?? [];
  const controlsDisabled = !form.enabled;
  const isDirty = config ? (
    form.enabled !== (config.notifications?.enabled ?? true) ||
    form.system_notifications !== (config.notifications?.system_notifications ?? false) ||
    form.default_mode !== (config.notifications?.default_mode ?? 'summary') ||
    JSON.stringify(form.domains) !== JSON.stringify(config.notifications?.domains ?? {})
  ) : false;

  return (
    <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-sage">
      <SectionHeader>Notifications</SectionHeader>

      <div className="space-y-4">
        <SectionCard>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <FieldLabel>Notifications</FieldLabel>
              <FieldHint>Turn the notification system on or off for this project.</FieldHint>
            </div>
            <Switch checked={form.enabled} onCheckedChange={v => setField('enabled', v)} />
          </div>
        </SectionCard>

        <div className={controlsDisabled ? 'space-y-4 opacity-60' : 'space-y-4'}>
          <SectionCard>
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
              <div className="space-y-1.5">
                <FieldLabel>Default Display</FieldLabel>
                <FieldHint>
                  `Summary` keeps notifications in the panel only. `Banner` also shows a temporary in-app popup.
                </FieldHint>
              </div>
              <Select
                value={form.default_mode}
                onValueChange={v => setField('default_mode', v as 'banner' | 'summary')}
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
            </div>
          </SectionCard>

          <SectionCard>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <FieldLabel>Browser Notifications</FieldLabel>
                <FieldHint>
                  Use OS/browser popups when the Myco tab is not focused. Only banner-mode notifications use this.
                </FieldHint>
              </div>
              <Switch
                checked={form.system_notifications}
                onCheckedChange={v => setField('system_notifications', v)}
                disabled={controlsDisabled}
              />
            </div>
          </SectionCard>

          {domains.length > 0 && (
            <SectionCard>
              <div className="space-y-3">
                <div className="space-y-1">
                  <FieldLabel>Per-Domain Overrides</FieldLabel>
                  <FieldHint>Leave a domain on `Default` unless you want it to behave differently from the project-wide setting.</FieldHint>
                </div>

                <div className="space-y-2">
                  {domains.map(d => {
                    const domainConfig = form.domains[d.domain] ?? { enabled: true };
                    const domainEnabled = domainConfig.enabled;
                    const effectiveMode = domainConfig.mode ?? form.default_mode;
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
                            </div>
                            <p className="text-[11px] text-on-surface-variant">
                              {d.types.map(t => t.label).join(', ')}
                            </p>
                          </div>

                          <div className="flex items-center gap-2 self-start">
                            <Select
                              value={domainConfig.mode ?? 'default'}
                              onValueChange={v => updateDomain(d.domain, { mode: v === 'default' ? undefined : (v as 'banner' | 'summary') })}
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
                              onCheckedChange={v => updateDomain(d.domain, { enabled: v })}
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
            <FieldHint>Notifications are currently disabled, so display and domain settings are inactive.</FieldHint>
          )}
        </div>
      </div>

      {/* Save row */}
      <div className="flex items-center gap-4 pt-2">
        <Button onClick={handleSave} disabled={!isDirty || isSaving} size="sm">
          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Save Notifications
        </Button>
        {saveMessage && (
          <span className={saveMessage.type === 'success' ? 'font-sans text-sm text-primary' : 'font-sans text-sm text-tertiary'}>
            {saveMessage.text}
          </span>
        )}
      </div>
    </Surface>
  );
}
