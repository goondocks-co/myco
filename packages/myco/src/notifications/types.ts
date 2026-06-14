/**
 * Core notification types for the Myco notification system.
 *
 * Domains (agents, sessions, skills, mycelium) register their own
 * notification descriptors. Configuration becomes dynamic based on
 * what's registered.
 */

/** Display mode for a notification. */
export type NotificationMode = 'banner' | 'summary';

/** Severity / visual treatment. */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/** Persisted notification status. */
export type NotificationStatus = 'unread' | 'read' | 'dismissed';

/** A single notification type that a domain can emit. */
export interface NotificationTypeDescriptor {
  /** Unique type ID, e.g. 'agent.task.success'. */
  id: string;
  /** Human-readable label for settings UI. */
  label: string;
  /** Default display mode when not overridden by config. */
  defaultMode: NotificationMode;
  /** Default severity level. */
  defaultLevel: NotificationLevel;
}

/**
 * A domain descriptor — registered by each subsystem that emits notifications.
 * The registry aggregates these and exposes them to config/UI.
 */
export interface NotificationDomainDescriptor {
  /** Domain key, e.g. 'agents', 'sessions', 'skills', 'mycelium'. */
  domain: string;
  /** Human-readable domain label for the settings UI. */
  label: string;
  /** Notification types this domain can emit. */
  types: NotificationTypeDescriptor[];
}

/** Shape of a notification as stored in the DB and returned by the API. */
export interface Notification {
  id: string;
  domain: string;
  type: string;
  level: NotificationLevel;
  title: string;
  message: string | null;
  mode: NotificationMode;
  status: NotificationStatus;
  /** Link to navigate to when clicked (e.g. '/agent/abc'). */
  link: string | null;
  /** Arbitrary JSON metadata for domain-specific data. */
  metadata: Record<string, unknown> | null;
  created_at: number;
}

/** Payload for creating a notification (sent by any myco process). */
export interface CreateNotificationPayload {
  domain: string;
  type: string;
  level?: NotificationLevel;
  title: string;
  message?: string;
  mode?: NotificationMode;
  link?: string;
  metadata?: Record<string, unknown>;
}
