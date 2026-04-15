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
    domain: 'daemon',
    label: 'Daemon',
    types: [
      { id: 'daemon.version_sync', label: 'Version sync restart', defaultMode: 'summary', defaultLevel: 'info' },
    ],
  });

  register({
    domain: 'settings',
    label: 'Settings',
    types: [
      { id: 'settings.saved', label: 'Settings saved', defaultMode: 'banner', defaultLevel: 'success' },
    ],
  });
}
