/** Machine pages seek contacts by reported machine. */
export const V706_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_worker_contacts_machine ON worker_contacts(machine_id,last_seen_at DESC)",
];
