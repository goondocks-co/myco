/**
 * Built-in domain notification registrations.
 *
 * Each domain registers its notification types here. External/plugin
 * domains can call register() directly.
 */

import { register } from './registry.js';

/** Register all built-in domain notifications. Called once at daemon startup. */
export function registerBuiltinDomains(): void {
  register({
    domain: 'agents',
    label: 'Agent Tasks',
    types: [
      { id: 'agent.task.success', label: 'Task completed', defaultMode: 'summary', defaultLevel: 'success' },
      { id: 'agent.task.failure', label: 'Task failed', defaultMode: 'summary', defaultLevel: 'error' },
      { id: 'agent.write.flagged', label: 'Destructive write flagged', defaultMode: 'banner', defaultLevel: 'error' },
      { id: 'agent.harness-health.findings', label: 'Harness health findings', defaultMode: 'summary', defaultLevel: 'warning' },
    ],
  });

  register({
    domain: 'sessions',
    label: 'Sessions',
    types: [
      { id: 'session.started', label: 'Session started', defaultMode: 'summary', defaultLevel: 'info' },
      { id: 'session.ended', label: 'Session ended', defaultMode: 'summary', defaultLevel: 'info' },
    ],
  });

  register({
    domain: 'skills',
    label: 'Skills',
    types: [
      { id: 'skill.surveyed', label: 'Skill candidate surveyed', defaultMode: 'summary', defaultLevel: 'info' },
      { id: 'skill.created', label: 'Skill created', defaultMode: 'summary', defaultLevel: 'success' },
      { id: 'skill.evolved', label: 'Skill evolved', defaultMode: 'summary', defaultLevel: 'info' },
    ],
  });

  register({
    domain: 'mycelium',
    label: 'Mycelium',
    types: [
      { id: 'mycelium.digest.completed', label: 'Digest cycle completed', defaultMode: 'summary', defaultLevel: 'info' },
      { id: 'mycelium.spore.created', label: 'New spore extracted', defaultMode: 'summary', defaultLevel: 'info' },
    ],
  });

  register({
    domain: 'okf',
    label: 'OKF',
    types: [
      { id: 'okf.publish_blocked', label: 'Bundle publish blocked', defaultMode: 'summary', defaultLevel: 'warning' },
    ],
  });

  register({
    domain: 'daemon',
    label: 'Daemon',
    types: [
      { id: 'daemon.version_sync', label: 'Version sync restart', defaultMode: 'summary', defaultLevel: 'info' },
      { id: 'daemon.backup_failed', label: 'Backup failed', defaultMode: 'banner', defaultLevel: 'error' },
      { id: 'daemon.integrity_issues', label: 'Database integrity issues', defaultMode: 'banner', defaultLevel: 'error' },
      { id: 'daemon.optimize_failed', label: 'Database optimize failed', defaultMode: 'summary', defaultLevel: 'warning' },
    ],
  });

  register({
    domain: 'settings',
    label: 'Settings',
    types: [
      { id: 'settings.saved', label: 'Settings saved', defaultMode: 'banner', defaultLevel: 'success' },
      { id: 'settings.config_unreadable', label: 'Config file unreadable', defaultMode: 'banner', defaultLevel: 'error' },
    ],
  });
}
