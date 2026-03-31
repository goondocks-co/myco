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

interface NotifFormState {
  enabled: boolean;
  system_notifications: boolean;
  default_mode: 'banner' | 'summary';
  domains: Record<string, { enabled: boolean }>;
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
        default_mode: config.notifications?.default_mode ?? 'banner',
        domains: config.notifications?.domains ?? {},
      });
    }
  }, [config, form]);

  const setField = useCallback(<K extends keyof NotifFormState>(key: K, value: NotifFormState[K]) => {
    setForm(prev => (prev ? { ...prev, [key]: value } : prev));
    setSaveMessage(null);
  }, []);

  const setDomainEnabled = useCallback((domain: string, enabled: boolean) => {
    setForm(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        domains: { ...prev.domains, [domain]: { enabled } },
      };
    });
    setSaveMessage(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!form || !config) return;
    setSaveMessage(null);
    try {
      await saveConfig({
        ...config,
        notifications: form,
      });
      setSaveMessage({ type: 'success', text: 'Notification settings saved.' });
    } catch {
      setSaveMessage({ type: 'error', text: 'Failed to save notification settings.' });
    }
  }, [form, config, saveConfig]);

  if (!form || !config) return null;

  const domains = registryData?.domains ?? [];
  const isDirty = config ? (
    form.enabled !== (config.notifications?.enabled ?? true) ||
    form.system_notifications !== (config.notifications?.system_notifications ?? false) ||
    form.default_mode !== (config.notifications?.default_mode ?? 'banner') ||
    JSON.stringify(form.domains) !== JSON.stringify(config.notifications?.domains ?? {})
  ) : false;

  return (
    <Surface level="low" className="p-6 space-y-5 border-t-2 border-t-sage">
      <SectionHeader>Notifications</SectionHeader>

      <div className="space-y-4">
        {/* Master toggle */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <FieldLabel>Enabled</FieldLabel>
            <FieldHint>Master switch for all notification types.</FieldHint>
          </div>
          <Switch checked={form.enabled} onCheckedChange={v => setField('enabled', v)} />
        </div>

        {/* System notifications */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <FieldLabel>System Notifications</FieldLabel>
            <FieldHint>Show browser notifications when the tab is not focused.</FieldHint>
          </div>
          <Switch
            checked={form.system_notifications}
            onCheckedChange={v => setField('system_notifications', v)}
            disabled={!form.enabled}
          />
        </div>

        {/* Default mode */}
        <div className="space-y-1.5">
          <FieldLabel>Default Mode</FieldLabel>
          <Select
            value={form.default_mode}
            onValueChange={v => setField('default_mode', v as 'banner' | 'summary')}
            disabled={!form.enabled}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="banner">Banner</SelectItem>
              <SelectItem value="summary">Summary</SelectItem>
            </SelectContent>
          </Select>
          <FieldHint>Banner shows as a pop-up overlay. Summary shows only in the notification panel.</FieldHint>
        </div>

        {/* Per-domain toggles */}
        {domains.length > 0 && (
          <div className="space-y-3 pt-2">
            <FieldLabel>Domain Notifications</FieldLabel>
            <div className="space-y-2">
              {domains.map(d => {
                const domainEnabled = form.domains[d.domain]?.enabled ?? true;
                return (
                  <div key={d.domain} className="flex items-center justify-between py-1">
                    <div className="space-y-0.5">
                      <span className="text-sm text-on-surface">{d.label}</span>
                      <p className="text-[11px] text-on-surface-variant">
                        {d.types.map(t => t.label).join(', ')}
                      </p>
                    </div>
                    <Switch
                      checked={domainEnabled}
                      onCheckedChange={v => setDomainEnabled(d.domain, v)}
                      disabled={!form.enabled}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
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
