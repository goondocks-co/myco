/** Delivery counts use the delivery-time window. */
export const V705_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_spore_injections_delivery ON spore_injections(project_id,delivered_at) WHERE delivered_at IS NOT NULL",
];
