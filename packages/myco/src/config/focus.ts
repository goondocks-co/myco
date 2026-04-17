export const CONFIG_FOCUS_SECTION_PARAM = 'configSection';
export const CONFIG_FOCUS_FIELD_PARAM = 'configField';
export const CONFIG_FOCUS_TAB_PARAM = 'tab';

const FIELD_ID_PREFIX = 'config-field-';

export const CONFIG_SECTION_IDS = {
  appearance: 'config-section-appearance',
  cortexInstructions: 'config-section-cortex-instructions',
  cortexBuilder: 'config-section-cortex-builder',
  cortexDigest: 'config-section-cortex-digest',
  settingsAgent: 'config-section-settings-agent',
  settingsEmbedding: 'config-section-settings-embedding',
  settingsNotifications: 'config-section-settings-notifications',
  settingsPlanCapture: 'config-section-settings-plan-capture',
  settingsProject: 'config-section-settings-project',
  agentOperations: 'config-section-agent-operations',
  operationsMaintenance: 'config-section-operations-maintenance',
  operationsBackup: 'config-section-operations-backup',
} as const;

type ConfigPagePath = '/settings' | '/agent' | '/operations' | '/cortex';

interface ConfigSectionTarget {
  page: ConfigPagePath;
  sectionId: string;
  sectionLabel: string;
  searchParams?: Record<string, string>;
}

export interface ConfigFocusTarget extends ConfigSectionTarget {
  fieldPath: string;
  fieldLabel: string;
}

interface PrefixRule extends ConfigSectionTarget {
  prefix: string;
}

const SECTION_RULES: PrefixRule[] = [
  {
    prefix: 'appearance',
    page: '/settings',
    sectionId: CONFIG_SECTION_IDS.appearance,
    sectionLabel: 'Appearance',
  },
  {
    prefix: 'agent.provider',
    page: '/settings',
    sectionId: CONFIG_SECTION_IDS.settingsAgent,
    sectionLabel: 'Myco Agent',
  },
  {
    prefix: 'embedding',
    page: '/settings',
    sectionId: CONFIG_SECTION_IDS.settingsEmbedding,
    sectionLabel: 'Embedding',
  },
  {
    prefix: 'context.digest_tier',
    page: '/cortex',
    sectionId: CONFIG_SECTION_IDS.cortexDigest,
    sectionLabel: 'Digest',
    searchParams: { [CONFIG_FOCUS_TAB_PARAM]: 'digest' },
  },
  {
    prefix: 'context.operating_brief',
    page: '/cortex',
    sectionId: CONFIG_SECTION_IDS.cortexInstructions,
    sectionLabel: 'Instructions',
  },
  {
    prefix: 'context.prompt',
    page: '/cortex',
    sectionId: CONFIG_SECTION_IDS.cortexInstructions,
    sectionLabel: 'Instructions',
  },
  {
    prefix: 'context',
    page: '/cortex',
    sectionId: CONFIG_SECTION_IDS.cortexInstructions,
    sectionLabel: 'Instructions',
  },
  {
    prefix: 'notifications',
    page: '/settings',
    sectionId: CONFIG_SECTION_IDS.settingsNotifications,
    sectionLabel: 'Notifications',
  },
  {
    prefix: 'capture',
    page: '/settings',
    sectionId: CONFIG_SECTION_IDS.settingsPlanCapture,
    sectionLabel: 'Plan Capture',
  },
  {
    prefix: 'daemon',
    page: '/settings',
    sectionId: CONFIG_SECTION_IDS.settingsProject,
    sectionLabel: 'Project',
  },
  {
    prefix: 'agent.scheduled_tasks_enabled',
    page: '/agent',
    sectionId: CONFIG_SECTION_IDS.agentOperations,
    sectionLabel: 'Agent Operations',
    searchParams: { tab: 'config' },
  },
  {
    prefix: 'agent.event_tasks_enabled',
    page: '/agent',
    sectionId: CONFIG_SECTION_IDS.agentOperations,
    sectionLabel: 'Agent Operations',
    searchParams: { tab: 'config' },
  },
  {
    prefix: 'agent.summary_batch_interval',
    page: '/agent',
    sectionId: CONFIG_SECTION_IDS.agentOperations,
    sectionLabel: 'Agent Operations',
    searchParams: { tab: 'config' },
  },
  {
    prefix: 'maintenance',
    page: '/operations',
    sectionId: CONFIG_SECTION_IDS.operationsMaintenance,
    sectionLabel: 'Scheduled Maintenance',
  },
  {
    prefix: 'backup',
    page: '/operations',
    sectionId: CONFIG_SECTION_IDS.operationsBackup,
    sectionLabel: 'Backup & Restore',
  },
];

const EXACT_FIELD_LABELS: Record<string, string> = {
  'appearance.theme': 'Color Theme',
  'appearance.mode': 'Mode',
  'appearance.font': 'Font',
  'appearance.density': 'Density',
  'agent.provider': 'Provider',
  'agent.provider.type': 'Provider',
  'agent.provider.model': 'Model',
  'agent.provider.base_url': 'Base URL',
  'agent.provider.context_length': 'Context Length',
  'embedding.provider': 'Provider',
  'embedding.model': 'Model',
  'embedding.base_url': 'Base URL',
  'context.digest_tier': 'Preferred Digest Tier',
  'context.operating_brief_enabled': 'Session-Start Instructions',
  'context.operating_brief_inject_on': 'Inject On',
  'context.operating_brief_max_tokens': 'Instructions Token Budget',
  'context.prompt_search': 'Prompt Search',
  'context.prompt_max_spores': 'Max Spores per Prompt',
  'notifications.enabled': 'Notifications',
  'notifications.default_mode': 'Default Display',
  'notifications.system_notifications': 'Browser Notifications',
  'capture.ignore_plan_dirs_in_git': 'Ignore Custom Plan Dirs In Git',
  'capture.plan_dirs': 'Custom Directories',
  'daemon.port': 'Daemon Port',
  'daemon.log_level': 'Log Level',
  'daemon.log_retention_days': 'Log Retention (days)',
  'agent.scheduled_tasks_enabled': 'Scheduled Tasks',
  'agent.event_tasks_enabled': 'Event-Driven Tasks',
  'agent.summary_batch_interval': 'Title & Summary Batch Interval',
  'maintenance.auto_optimize': 'Auto-optimize',
  'maintenance.auto_optimize_interval_hours': 'Auto-optimize Interval',
  'backup.dir': 'Backup Directory',
};

const DYNAMIC_FIELD_LABEL_RULES: Array<{
  prefix: string;
  format: (path: string) => string | null;
}> = [
  {
    prefix: 'notifications.domains.',
    format: (path) => {
      const match = /^notifications\.domains\.([^.]+)\.(enabled|mode)$/.exec(path);
      if (!match) return null;
      const [, domain, leaf] = match;
      const domainLabel = humanizeToken(domain);
      return leaf === 'mode' ? `${domainLabel} Display` : `${domainLabel} Notifications`;
    },
  },
];

const SAVE_MESSAGE_LABEL_LIMIT = 3;

export function configFieldId(path: string): string {
  return `${FIELD_ID_PREFIX}${path.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

export function resolveConfigFocusTarget(path: string): ConfigFocusTarget | null {
  const section = findSectionRule(path);
  if (!section) return null;
  return {
    ...section,
    fieldPath: path,
    fieldLabel: resolveFieldLabel(path),
  };
}

export function buildConfigFocusLink(target: ConfigFocusTarget): string {
  const params = new URLSearchParams(target.searchParams);
  params.set(CONFIG_FOCUS_SECTION_PARAM, target.sectionId);
  params.set(CONFIG_FOCUS_FIELD_PARAM, target.fieldPath);
  return `${target.page}?${params.toString()}`;
}

export function buildScopedConfigSaveNotification(scope: 'project' | 'local', touchedPaths: string[]) {
  const uniquePaths = [...new Set(touchedPaths)];
  const scopeLabel = scope === 'local' ? 'Personal' : 'Project';
  const focusTarget = uniquePaths.map(resolveConfigFocusTarget).find((target) => target !== null) ?? null;
  const fieldLabels = uniquePaths.map(resolveFieldLabel);
  const primaryLabel = fieldLabels[0] ?? 'Setting';
  const labelList = fieldLabels.slice(0, SAVE_MESSAGE_LABEL_LIMIT).join(', ');
  const remainingCount = Math.max(0, fieldLabels.length - SAVE_MESSAGE_LABEL_LIMIT);
  const messageLabel = remainingCount > 0 ? `${labelList}, +${remainingCount} more` : labelList;

  return {
    title: uniquePaths.length === 1 ? `${primaryLabel} saved` : `${uniquePaths.length} settings saved`,
    message: focusTarget
      ? `${focusTarget.sectionLabel} · ${messageLabel} · ${scopeLabel}`
      : `${messageLabel} · ${scopeLabel}`,
    link: focusTarget ? buildConfigFocusLink(focusTarget) : null,
    metadata: {
      scope,
      touched_paths: uniquePaths,
      field_labels: fieldLabels,
      focus_target: focusTarget
        ? {
            page: focusTarget.page,
            section_id: focusTarget.sectionId,
            field_path: focusTarget.fieldPath,
            field_label: focusTarget.fieldLabel,
          }
        : null,
    },
  };
}

function findSectionRule(path: string): ConfigSectionTarget | null {
  for (const rule of SECTION_RULES) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) {
      const { page, sectionId, sectionLabel, searchParams } = rule;
      return { page, sectionId, sectionLabel, searchParams };
    }
  }
  return null;
}

function resolveFieldLabel(path: string): string {
  const exact = EXACT_FIELD_LABELS[path];
  if (exact) return exact;

  for (const rule of DYNAMIC_FIELD_LABEL_RULES) {
    if (path === rule.prefix || path.startsWith(rule.prefix)) {
      const label = rule.format(path);
      if (label) return label;
    }
  }

  return humanizeToken(path.split('.').pop() ?? 'setting');
}

function humanizeToken(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
