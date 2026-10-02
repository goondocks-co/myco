/**
 * The shapes Settings reads, as the server sends them: the Deployment's
 * leaves, its provider keys and where titling imported sessions stands.
 *
 * Declared here with no imports, since the dashboard cannot import the
 * server's declarations; `tests/myco-server/settings-wire.test.ts` holds each
 * to the server's own under `typecheck:tests`.
 */

/** `GET /api/settings`: one leaf and whatever is stored for it. */
export interface LeafRow {
  leaf: string;
  configured: boolean;
  value: unknown;
  updatedAt: number | null;
  updatedBy: string | null;
  /** Retired editable contract: stored values are read-only metadata. */
  retired: boolean;
  /** Present for execution profiles and derived metadata: the live value. */
  effectiveValue?: unknown;
  editableValue?: unknown;
  retiredValue?: Record<string, unknown>;
  source?: 'configured' | 'default' | 'unset' | 'invalid' | 'derived';
  error?: 'invalid_value';
  remedy?: string;
  repair?: 'reset-leaf';
}

export interface SettingsAnswer {
  leaves: LeafRow[];
  taskTiers: TaskTierRow[];
}

/** One worker outcome's effective reasoning tier. */
export type TaskTierRow =
  | { task: string; tier: 'low' | 'default' | 'high'; source: 'task' | 'task-override' }
  | { task: string; tier: null; source: 'invalid'; error: 'invalid_task_tier'; repair: 'reset-task' | 'reset-leaf'; remedy: string };

/** `GET /api/secrets`: one provider key's slot, described and never shown. */
export interface SecretRow {
  name: string;
  configured: boolean;
  /** False when the stored key will not open under this server's current key: it must be entered again. */
  readable: boolean;
  /** Its first and last characters only, or null when nothing is stored. */
  maskedValue: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
  /** Nothing on the server reads this key: the page lists it only while one is stored, under Older keys. */
  retired: boolean;
}

export interface SecretsAnswer {
  secrets: SecretRow[];
}

/** `GET` and `PUT /api/titling-backfill`: titling's policy, what is left to title, and how the trailing day went. */
export interface TitlingBackfillProgress {
  scheduledTasksEnabled: boolean;
  /** The switch "Title imported sessions" reads and writes. */
  backfillEnabled: boolean;
  runsPerDay: number | null;
  intervalSeconds: number;
  runIn: readonly string[];
  overlap: 'skip' | 'queue';
  enabled: boolean;
  remaining: number;
  owed: number;
  usedToday: number;
  inFlight: number;
  completedToday: number;
  failedToday: number;
  /** What holds the next title while sessions wait for one; null when nothing does. */
  waiting: { reason: 'interval' | 'overlap' | 'ceiling'; until: number | null } | null;
}
