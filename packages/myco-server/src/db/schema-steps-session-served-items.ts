import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { changing, reaching, type SchemaStep } from './schema-step.js';
import { NEXT_S4C } from './schema-vNEXT-s4c.js';
import { SERVED_ITEMS_PHASE, SERVED_ITEMS_PROJECTION, SERVED_ITEMS_TRIGGER } from './context/served-items.js';

/**
 * What each session has been served, one row per spore or plan, so a prompt asks whether its own candidates were served
 * instead of reading every receipt the session holds. A trigger adds each receipt's items as any writer inserts it;
 * receipts written before this step are added by the catch-up, which replays the trigger's statement and is done at
 * once on a store holding none.
 */
export const VNEXT_S4C_STEPS: readonly SchemaStep[] = [
  { version: NEXT_S4C, statements: [
    `CREATE TABLE IF NOT EXISTS session_served_items (
       project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
       session_id TEXT NOT NULL,
       kind TEXT NOT NULL CHECK (kind IN ('spore', 'plan')),
       item_id TEXT NOT NULL,
       PRIMARY KEY (project_id, session_id, kind, item_id)) WITHOUT ROWID`,
    SERVED_ITEMS_TRIGGER.sql,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${SERVED_ITEMS_PROJECTION}','${SERVED_ITEMS_PHASE}',NOT EXISTS(SELECT 1 FROM spore_injections) ON CONFLICT DO NOTHING`,
  ], reaches: [
    ...reaching(['spore_injections'], 'Each receipt adds the spores and plans it served to its session as it is inserted, by any writer.'),
    ...changing(['projection_catchup'], 'The catch-up that adds the items of receipts written before the membership is registered, done at once where there are none.'),
  ] },
];
