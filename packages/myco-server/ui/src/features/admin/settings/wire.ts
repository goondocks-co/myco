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
}

export interface SettingsAnswer {
  leaves: LeafRow[];
}

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
