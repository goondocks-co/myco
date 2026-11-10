import { REVISION_KINDS } from '@myco-server-worker/db/search/ranking.js';
import { V723, V723_STATEMENTS } from '@myco-server-worker/db/schema-v723.js';
import { V727, V727_STATEMENTS } from '@myco-server-worker/db/schema-v727.js';
import { NEXT_S6, VNEXT_S6_INDEX_STEPS, VNEXT_S6_STATEMENTS } from '@myco-server-worker/db/schema-vNEXT-s6.js';
import { NEXT_S1C, VNEXT_S1C_STEPS } from '@myco-server-worker/db/schema-vNEXT-s1c.js';
import { headSchemaStatements } from '@myco-server-worker/db/runners/heads.js';
import { lineageHeadSchemaStatements } from '@myco-server-worker/db/identity/lineage-heads.js';
import { storageUsageSchemaStatements } from '@myco-server-worker/db/storage/usage.js';
import { SESSION_LIFECYCLE_STEPS, V730 } from '@myco-server-worker/db/schema-v728.js';
import { CARD_SETTLE_AND_LOCATOR_STEPS } from '@myco-server-worker/db/schema-vNEXT-s2b2.js';
import { VNEXT_S2C_STEPS } from '@myco-server-worker/db/schema-vNEXT-s2c.js';
import { NEXT_S6B, VNEXT_S6B_STEPS } from '@myco-server-worker/db/schema-vNEXT-s6b.js';
import { authorityRetentionSchemaStatements } from '@myco-server-worker/db/identity/authority-retention.js';
import { VNEXT_S2C2_STEPS } from '@myco-server-worker/db/schema-vNEXT-s2c2.js';
import { VNEXT_S7_STEPS } from '@myco-server-worker/db/schema-vNEXT-s7.js';
import { VNEXT_S8B_STEPS } from '@myco-server-worker/db/schema-steps-backup-retention.js';
import { VNEXT_S5D_STEPS } from '@myco-server-worker/db/schema-steps-release-provenance.js';
import { SESSION_LIFECYCLE_EVENTS_INDEX, sessionLifecycleSchema } from '@myco-server-worker/db/documents/lifecycle.js';
import { publicationPinSchema } from '@myco-server-worker/db/documents/pin-schema.js';
import { publicationFailureSchema } from '@myco-server-worker/db/documents/failure-head.js';
import { publicationRebuildSchema } from '@myco-server-worker/db/documents/rebuild.js';
import { V718, V718_STATEMENTS } from '@myco-server-worker/db/schema-v718.js';
import { publicationContributionSchema } from '@myco-server-worker/db/documents/contributions.js';
import { calibrationTriggers } from '@myco-server-worker/db/embeddings/calibration.js';
import { passedOverTriggers } from '@myco-server-worker/db/embeddings/passed-over.js';
import { sourceStateTriggers } from '@myco-server-worker/db/embeddings/state.js';
import { kpiTriggers } from '@myco-server-worker/db/insights/kpi-reconcile.js';
import { planCountSchemaStatements } from '@myco-server-worker/db/plans/counts.js';
import { spendSchemaStatements, spendTriggers } from '@myco-server-worker/db/runs/admission.js';
import { workSchemaStatements, workTriggers } from '@myco-server-worker/db/runs/history-schema.js';
import { liveSchemaStatements, liveTriggers } from '@myco-server-worker/db/runs/live.js';
import { sporeCountSchemaStatements } from '@myco-server-worker/db/spores/counts.js';
import { V720, V720_STATEMENTS } from '@myco-server-worker/db/schema-v720.js';
import { V721, V721_STATEMENTS } from '@myco-server-worker/db/schema-v721.js';
import { V722, V722_STATEMENTS } from '@myco-server-worker/db/schema-v722.js';
import { V725, V725_STATEMENTS } from '@myco-server-worker/db/schema-v725.js';
import { V715 as STORAGE_NEXT, V715_STATEMENTS as STORAGE_STATEMENTS } from '@myco-server-worker/db/schema-v715.js';
import { NEXT_S8A2, NEXT_S8A2_STATEMENTS } from '@myco-server-worker/db/schema-vNEXT-s8a2.js';
import { NEXT_S4B } from '@myco-server-worker/db/schema-vNEXT-s4b.js';
import { NEXT_S2D, VNEXT_S2D_STEPS } from '@myco-server-worker/db/schema-vNEXT-s2d.js';
import { NEXT_S4B2, VNEXT_S4B2_STEPS } from '@myco-server-worker/db/schema-vNEXT-s4b2.js';
import { VNEXT_S2E_STEPS } from '@myco-server-worker/db/schema-vNEXT-s2e.js';
import { V717, V717_STATEMENTS } from '@myco-server-worker/db/schema-v717.js';
import { V719, V719_STATEMENTS } from '@myco-server-worker/db/schema-v719.js';
import { V724, V724_STATEMENTS } from '@myco-server-worker/db/schema-v724.js';
import { V726, V726_STATEMENTS } from '@myco-server-worker/db/schema-v726.js';
import { V731, V731_INDEX_STEPS, V731_STATEMENTS } from '@myco-server-worker/db/schema-v731.js';
const S1B2_STEPS = [{ version: V731, statements: V731_STATEMENTS }, ...V731_INDEX_STEPS];
import { V712, V712_STATEMENTS } from '@myco-server-worker/db/schema-v712.js';
import { V714, V714_STATEMENTS } from '@myco-server-worker/db/schema-v714.js';
import { V716, V716_STATEMENTS } from '@myco-server-worker/db/schema-v716.js';
import { V710_STATEMENTS } from '@myco-server-worker/db/schema-v710.js';
import { V711, V711_STATEMENTS } from '@myco-server-worker/db/schema-v711.js';
import { V713 as CURSOR_INDEX_STEP, V713_STATEMENTS as CURSOR_INDEX_STATEMENTS } from '@myco-server-worker/db/schema-v713.js';
import { V708_STATEMENTS } from '@myco-server-worker/db/schema-v708.js';
import { LEARNING_QUIET_MARGIN_STEPS } from '@myco-server-worker/db/schema-v659.js';
import { LEARNING_QUIET_STEPS } from '@myco-server-worker/db/schema-v619.js';
import { LEARNING_SOURCE_STEPS } from '@myco-server-worker/db/schema-v546.js';
import { LEARNING_WORK_INDEX_STEPS } from '@myco-server-worker/db/schema-v617.js';
import { READ_COST_STEPS } from '@myco-server-worker/db/schema-v538.js';
import { PUBLICATION_QUEUE_STEPS } from '@myco-server-worker/db/schema-v501.js';
import { V466_STATEMENTS } from '@myco-server-worker/db/schema-v466.js';
import { PUBLICATION_FACT_STEPS } from '@myco-server-worker/db/schema-v467.js';
import { RETIREMENT_SCHEMA_STEPS } from '@myco-server-worker/db/schema-v117.js';
import { DROP_CONTENT_SCHEMA_STEPS } from '@myco-server-worker/db/schema-v265.js';
import { V255_STATEMENTS, UX_SCHEMA_STEPS } from '@myco-server-worker/db/schema-v255.js';
import { readdirSync } from 'node:fs';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { migrationFileName } from '@myco-server-worker/db/migrate.js';
import { expect, it } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import type { SchemaStep } from '@myco-server-worker/db/schema-step.js';
import { V695_STATEMENTS } from '@myco-server-worker/db/schema-v695.js';
import { V111_STATEMENTS } from '@myco-server-worker/db/schema-v111.js';
import { V115_STATEMENTS } from '@myco-server-worker/db/schema-v115.js';
import { V114_STATEMENTS } from '@myco-server-worker/db/schema-v114.js';

interface Exception {
  step: number;
  object: string;
  table: string;
  reason: string;
}
const S1C_STATEMENTS = VNEXT_S1C_STEPS[0]!.statements;
const LISTED: readonly Exception[] = [
  ...['idx_learning_card_deadline', 'idx_learning_stage_deadline', 'idx_learning_card_ready', 'idx_learning_stage_ready', 'idx_learning_aging'].map((object, i) => ({
    step: NEXT_S4B2 + i + 1, object, table: 'learning_sessions', reason: 'Each learning relation is one bounded partial index, built alone in its own step.' })),
  ...[['turn_cards_learning_insert_pending', 'turn_cards'], ['turn_cards_learning_insert_carded', 'turn_cards'], ['turn_cards_learning_carded', 'turn_cards'], ['turn_cards_learning_reset', 'turn_cards'],
    ['turn_cards_learning_recarded', 'turn_cards'], ['turn_cards_learning_covered', 'turn_cards'], ['turn_cards_learning_due', 'turn_cards'], ['turn_cards_learning_delete_pending', 'turn_cards'], ['turn_cards_learning_delete_carded', 'turn_cards'],
    ['learning_session_counted', 'learning_sessions'], ['learning_counts_update', 'learning_sessions'], ['learning_counts_delete', 'learning_sessions'],
    ['learning_ready_project_update', 'learning_sessions'], ['learning_ready_project_delete', 'learning_sessions'], ['learning_source_refreshed', 'learning_sessions']].map(([object, table]) => ({
    step: NEXT_S4B2 + 6, object: object!, table: table!, reason: 'Each card write moves its session and Project counts in the same statement; deadlines keep their stage summary current.' })),
  { step: NEXT_S4B, object: 'spore_resolution_edge_insert', table: 'resolution_events', reason: 'Each new resolution event writes the lineage edge browsing reads.' },
  ...VNEXT_S6B_STEPS.flatMap(({ version, statements }) => statements.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null || match[2] === 'identity_link_redemptions' ? [] : [{ step: version, object: match[1]!, table: match[2]!,
      reason: match[2] === 'projects' ? 'Every Project write keeps the active count exact, restore included, so the limit never counts.'
        : 'A due-row deadline moves in the commit that finishes the row, and the job reads it by this index.' }];
  })),
  ...VNEXT_S2D_STEPS.at(-1)!.statements.flatMap(sql => {
    const match = /^CREATE TRIGGER(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null ? [] : [{ step: NEXT_S2D, object: match[1]!, table: match[2]!, reason: 'Turn cards and plans of a deleted session drop out of a ranked page on its tombstone, so a cursor over them restarts when one is written.' }];
  }),
  ...VNEXT_S2D_STEPS.slice(0, 3).flatMap(({ version, statements: [sql] }) => {
    const match = /^CREATE INDEX(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql!);
    return match === null ? [] : [{ step: version, object: match[1]!, table: match[2]!, reason: 'A deletion job pages these rows by the session they belong to, and a page must not walk the whole table.' }];
  }),
  ...S1C_STATEMENTS.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null ? [] : [{ step: NEXT_S1C, object: match[1]!, table: match[2]!,
      reason: sql.startsWith('CREATE TRIGGER') ? 'A contact, capture or runner attempt moves its one head row, so reads no longer walk contacts or attempt history.'
        : 'A member\'s machine page and a runner name lookup seek by key.' }];
  }),
  ...VNEXT_S6_INDEX_STEPS.flatMap(({ version, statements: [sql] }) => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql!);
    return match === null ? [] : [{ step: version, object: match[1]!, table: match[2]!, reason: 'Lineage heads re-derive from a lineage\'s unrevoked credentials, and a member\'s credential page reads newest lineage first.' }];
  }),
  ...VNEXT_S6_STATEMENTS.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null ? [] : [{ step: NEXT_S6, object: match[1]!, table: match[2]!,
      reason: sql.startsWith('CREATE TRIGGER') ? 'A person\'s credential change moves the one lineage head it belongs to, and a run credential writes no head.'
        : 'Member, invitation and head reads page and count by key instead of walking credential or authority history.' }];
  }),
  ...V727_STATEMENTS.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null ? [] : [{ step: V727, object: match[1]!, table: match[2]!,
      reason: sql.startsWith('CREATE TRIGGER') ? 'A registered blob moves the storage usage counters of its Project and the Deployment for every key the build has reached.'
        : 'The object-release drain reads its next page of each release queue from this order.' }];
  }),
  ...VNEXT_S7_STEPS.flatMap(({ version: step, statements }) => statements.flatMap(sql => {
    const match = /^CREATE TRIGGER(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null ? [] : [{ step, object: match[1]!, table: match[2]!,
      reason: 'A session\'s activity and new sessions compute their idle-close deadline from the policy generation, so a changed setting rewrites deadlines in pages and never in the write.' }];
  })),
  ...VNEXT_S8B_STEPS.flatMap(({ version: step, statements }) => statements.flatMap(sql => {
    const match = /^CREATE (?:UNIQUE )?(?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null ? [] : [{ step, object: match[1]!, table: match[2]!,
      reason: match[1]!.startsWith('idx_') ? 'Retention and object settlement seek a backup through these orders, and one object has at most one backup.'
        : 'A change to a backup moves its week head and the keep-set generation in the same commit.' }];
  })),
  ...VNEXT_S5D_STEPS.flatMap(({ version: step, statements }) => statements.flatMap(sql => {
    const match = /^CREATE (?:UNIQUE )?(?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null || match[2]!.startsWith('release_') ? [] : [{ step, object: match[1]!, table: match[2]!,
      reason: match[1]!.startsWith('idx_') ? 'A release state list walks newest checked first by key, and one current row per record is enforced for every row the catch-up has placed.'
        : 'A capture, a changed path, or a record naming a classified session moves its one due row, so the reconcile reads due rows instead of history.' }];
  })),
  ...VNEXT_S2C2_STEPS.flatMap(({ version: step, statements }) => statements.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null || match[2] === 'session_statistics' || match[2] === 'session_attachment_counts' || match[2] === 'context_placements' ? [] : [{ step, object: match[1]!, table: match[2]!,
      reason: match[1] === 'idx_prompt_context_answers_delivered' ? 'A prompt reaches the answers delivered to it by key, so a late prompt or a restore reads only the deliveries that name it.'
        : match[1]!.startsWith('idx_') ? 'A page across Projects and a page of uncaptured repositories walk a complete order with no sort, so a tie never moves across a boundary.'
        : match[1]!.startsWith('context_placement') ? 'A delivery and the prompts it names re-derive its placement row in the same commit, so the placement status reads day counters and never collapses unnamed and unavailable.'
        : 'The sources of a Project\'s statistics re-derive that session\'s row in the same commit, so the Project page reads counters instead of recounting history.' }];
  })),
  ...VNEXT_S2C_STEPS.flatMap(({ version: step, statements }) => statements.flatMap(sql => {
    const match = /^CREATE TRIGGER(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null || match[2] === 'session_title_work' ? [] : [{ step, object: match[1]!, table: match[2]!,
      reason: 'A session\'s own columns, its live document and its transcripts move its one title work row, so a pass reads due and ready rows instead of scanning sessions.' }];
  })),
  ...CARD_SETTLE_AND_LOCATOR_STEPS.flatMap(({ version: step, statements }) => statements.flatMap(sql => {
    const match = /^CREATE INDEX(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null || match[2] === 'document_locator_repair' ? [] : [{step,object:match[1]!,table:match[2]!,
      reason: match[2] === 'turn_cards' ? 'Card settlement reads its deadlines and its ready order from partial indexes instead of scanning every pending card.'
        : 'Locator repair reads the prompts whose page is unknown or held by none without scanning a document\'s prompts.'}];
  })),
  ...SESSION_LIFECYCLE_STEPS.flatMap(({ version: step, statements }) => statements.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null ? [] : [{step,object:match[1]!,table:match[2]!,
      reason: match[2] === 'events' ? 'Each lifecycle event applies its own contribution to the keyed facts of its session in the event commit, never recounting history.'
        : match[2] === 'transcripts' ? 'A transcript\'s import class moves its session\'s live-transcript count by the keyed delta.'
        : match[2] === 'session_prompts' ? 'The latest user prompt a live document holds is one seek, not a count of the session\'s prompts.'
        : 'Publication dependency rows keep their reverse lookups, totals and queue wake keyed.'}];
  })),
  ...V723_STATEMENTS.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null ? [] : [{step:V723,object:match[1]!,table:match[2]!,
      reason:'Publication maintains keyed pin and failure contributions; generation and version seeks bound catch-up and metadata reads.'}];
  }),
  ...[
    ['idx_publication_owner_pages', 'session_pages'], ['idx_publication_transcripts', 'transcripts'],
    ['idx_publication_reopen', 'transcript_publication'], ['idx_publish_ready', 'publish_queue'], ['idx_publish_sleeping', 'publish_queue'],
    ...['insert','update','delete'].map(action => [`publication_directory_transcripts_${action}`, 'transcripts']),
    ['publication_directory_generation', 'session_documents'], ['publication_directory_lifecycle', 'sessions'],
    ['publication_directory_frontier_rewind', 'transcript_publication'],
  ].map(([object, table]) => ({ step: V718, object: object!, table: table!, reason: 'Publication seeks bounded directories and due arms; keyed input changes restart their cursors.' })),

  { step: V719, object: 'idx_agent_runs_admission_catchup', table: 'agent_runs', reason: 'Admission catch-up seeks only in-flight source rows in Project/run order.' },
  { step: V719, object: 'run_admission_ready_mark', table: 'projection_catchup', reason: 'Admission readiness changes refresh the runs section.' },
  ...['insert', 'update', 'delete'].map(action => ({ step: V719, object: `run_live_${action}`, table: 'agent_runs', reason: 'Named run identities maintain admission contributions and queue heads.' })),
  ...V725_STATEMENTS.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null ? [] : [{ step: V725, object: match[1]!, table: match[2]!, reason: match[1]!.startsWith('idx_')
      ? 'Sealing seeks settled members still holding their vectors; releasing seeks stored pages no member names.'
      : 'A member moving on or off a stored page moves the live count that decides when the page is released.' }];
  }),
  ...V722_STATEMENTS.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null ? [] : [{ step: V722, object: match[1]!, table: match[2]!, reason: match[1]!.includes('_hubness_source_')
      ? 'A spore version or receipt change advances the calibration revision every page commit is fenced by.'
      : match[1] === 'idx_embedding_hubness_members_moments' ? 'Calibration reads the lowest and highest moment count of settled members in two seeks.'
      : match[1] === 'idx_embedding_source_rewriting' ? 'Spores being written again are counted from current source state, without reading stale receipts.'
      : match[1] === 'embedding_hubness_members_work_update' ? 'A membership change dirties calibration work; moment updates, which commit with the cursor, do not.'
      : 'Receipt, source version and membership changes maintain per-vector calibration state and its population.' }];
    }),
  ...S1B2_STEPS.flatMap(({ version, statements }) => statements.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null || !['agent_runs', 'agent_reports', 'agent_run_events', 'agent_run_attempts', 'run_served_material'].includes(match[2]!) ? [] : [{ step: version, object: match[1]!, table: match[2]!,
      reason: match[1]!.endsWith('_body_due') ? 'The body move seeks settled large bodies without reading the rest of the table.'
        : match[1] === 'idx_agent_run_events_write' ? 'Whether a run landed a write through a tool is one seek of its landed writes.'
        : match[1] === 'idx_run_served_material_session_record' ? 'A prompt\'s serving identity in a session is one keyed probe, and citation checks use the same path.'
        : 'An attempt or admitted call changes that run\'s kept counters by one.' }];
  })),
  ...V724_STATEMENTS.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null || !['agent_runs', 'spores', 'agent_run_events'].includes(match[2]!) ? [] : [{ step: V724, object: match[1]!, table: match[2]!,
      reason: sql.startsWith('CREATE INDEX') ? 'The run list seeks a Project\'s runs, newest first, by task or by effective time.'
        : 'A named run\'s terminal mutation or its output reconciles that run\'s Work history contribution.' }];
  }),
  ...['member_naming_failure_resolved', 'member_naming_failure_removed'].map(object => ({ step: V726, object, table: 'members', reason: 'A naming failure ends in the commit that names, revokes or removes its member.' })),
  ...V720_STATEMENTS.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null ? [] : [{ step: V720, object: match[1]!, table: match[2]!, reason: match[1] === 'idx_embedding_passed_over_current'
      ? 'Switch completion seeks a Project\'s current passed-over membership by model and expiry, never reading expired refusals.'
      : sql.startsWith('CREATE INDEX') ? 'Scheduling seeks the work rows whose wake time has come without reading every Project.'
      : match[2] === 'embedding_models' ? 'A model\'s registration, activation, initialization or epoch change re-arms its Project\'s work.'
      : 'A work mutation marks its Project for scheduling attention in the statement that dirties its work rows.' }];
  }),
  ...['insert', 'update', 'delete'].map(action => ({ step: V721, object: `spore_count_${action}`, table: 'spores', reason: 'Spore mutations re-derive the one count fact of the spore key they name.' })),
  ...['insert', 'update', 'delete'].map(action => ({ step: V721, object: `spore_count_fact_${action}`, table: 'spore_count_facts', reason: 'Each spore count fact moves the Project, session and UTC-day totals by its old and new dimensions.' })),
  ...['insert', 'update', 'delete'].map(action => ({ step: V721, object: `plan_count_${action}`, table: 'plans', reason: 'Plan mutations re-derive the one count fact of the plan key they name.' })),
  { step: V721, object: 'idx_spores_created_deployment', table: 'spores', reason: 'The spore list across Projects orders by the instant, the id and the Project, and walks this index with no sort.' },
  ...[['idx_spores_session', 'a session\'s spores'], ['idx_spores_status', 'a Project\'s spores of one status'], ['idx_spores_type', 'a Project\'s spores of one type'], ['idx_spores_author', 'one author\'s spores']]
    .map(([object, list]) => ({ step: V721, object: object!, table: 'spores', reason: `The list of ${list} walks this index newest first by instant and id, with no sort, rebuilt under its own name.` })),
  ...[['idx_spores_status_deployment', 'status'], ['idx_spores_type_deployment', 'type']].map(([object, by]) => ({ step: V721, object: object!, table: 'spores',
    reason: `The spore list across Projects narrowed to one ${by} walks this index newest first by instant, id and Project, with no sort.` })),
  ...Object.entries(REVISION_KINDS).flatMap(([kind, watched]) => watched.flatMap(({ table, rows }) => ['update', ...(rows ? ['insert', 'delete'] : [])].map(event => ({
    step: V721, object: `search_revision_${kind}_${table}_${event}`, table,
    reason: 'A change to what ranked search orders, filters or reaches by moves that search revision, which fences search cursors.' })))),
  { step: V721, object: 'idx_spores_project_created', table: 'spores', reason: 'A Project\'s spore list, unfiltered or over a window of days, walks its spores newest first by instant and id with no sort.' },
  ...['insert', 'update', 'delete'].map(action => ({ step: V721, object: `plan_count_fact_${action}`, table: 'plan_count_facts', reason: 'Each plan count fact moves its Project status total by its old and new status.' })),
  ...['insert', 'update', 'delete'].map(action => ({ step: V714, object: `attempt_spend_attempt_${action}`, table: 'agent_run_attempts', reason: 'Attempt claims, prices and settlements maintain their rolling spend contribution; a new claim expires due window rows.' })),
  { step: V714, object: 'attempt_spend_run_update', table: 'agent_runs', reason: 'Run status, dispatch and cost changes move the attempt dispatched before and after the change between live reservation and settled spend.' },
  { step: V714, object: 'attempt_spend_run_reclassify', table: 'agent_runs', reason: 'A run whose task or origin changes reclassifies its attempts’ spend.' },
  { step: STORAGE_NEXT, object: 'idx_backups_key', table: 'backups', reason: 'Object settlement seeks the backup that registers a physical key.' },
  { step: STORAGE_NEXT, object: 'idx_object_releases_retry', table: 'object_releases', reason: 'Each release has an independent indexed retry deadline.' },
  ...['insert', 'update', 'delete'].map(action => ({ step: V716, object: `embedding_state_version_${action}`, table: 'embedding_versions', reason: 'Version mutations reconcile the one source key they name under every active model.' })),
  ...['insert', 'update', 'delete'].map(action => ({ step: V716, object: `embedding_state_receipt_${action}`, table: 'embedding_receipts', reason: 'Receipt mutations move their source between unwritten, journaled, rewriting, ready and unavailable.' })),
  ...['insert', 'update', 'delete'].map(action => ({ step: V716, object: `embedding_state_proof_${action}`, table: 'processed_resources', reason: 'Plan proof eligibility reconciles only that plan’s source state.' })),
  ...['insert', 'update', 'delete'].map(action => ({ step: V716, object: `embedding_model_totals_${action}`, table: 'embedding_source_state', reason: 'Each source state row moves its model total by its old and new state.' })),
  ...['transcripts','transcript_publication','session_documents'].flatMap(table => ['insert','update','delete'].map(action => ({
    step: V717, object: `${table}_facts_${action}`, table, reason: 'Publication facts reconcile named source keys and generation totals.'
  }))),
  ...['transcripts','transcript_publication','publish_queue','session_tombstones'].flatMap(table => ['insert','update','delete'].map(action => ({
    step: V717, object: `publication_input_${table}_${action}`, table, reason: 'Publication input mutations advance the session concurrency revision.'
  }))),
  ...['publication_input_document_update','publication_ready_insert','publication_ready_update','publication_ready_delete'].map(object => ({
    step: V717, object, table: 'session_documents', reason: 'Document lifecycle maintains publication revision and contribution activation.'
  })),
  { step: V712, object: 'idx_agent_run_events_setup_output', table: 'agent_run_events', reason: 'Setup seeks recorded title and map output without scanning empty run history.' },
  { step: V712, object: 'idx_curation_failed', table: 'spore_curation_work', reason: 'Today seeks failed curation groups independently of successful groups.' },
  ...['insert', 'update', 'delete'].map(action => ({ step: V712, object: `passed_over_failure_${action}`, table: 'embedding_source_failures', reason: 'Failure mutations maintain current passed-over membership.' })),
  ...['insert', 'update', 'delete'].map(action => ({ step: V712, object: `passed_over_version_${action}`, table: 'embedding_versions', reason: 'Version mutations retract stale passed-over membership.' })),
  ...['insert','update','delete'].map(action => ({ step: V712, object: `passed_over_proof_${action}`, table: 'processed_resources', reason: 'Plan proof eligibility maintains only its source failure memberships.' })),
  ...[['agent_runs','runs'],['plans','plans'],['spore_curation_changes','curation']].flatMap(([table,kind]) =>
    ['insert','update','delete'].map(action => ({ step: V712, object: `change_mark_${kind}_${action}`, table: table!, reason: 'Source mutations advance the persistent Today mark.' }))),
  ...['deployment_settings', 'deployment_setting_resets', 'project_settings', 'project_capabilities'].flatMap(table =>
    ['insert', 'update', 'delete'].map(operation => ({ step: 710, object: `${table}_revision_${operation}`, table,
      reason: 'Setting mutations advance the persistent leaf revision in the same transaction.' }))),
  ...[
    { table: 'session_prompts', actions: ['insert', 'delete', 'update'], reason: 'Live prompts maintain their measures and receipt placement.' },
    { table: 'session_documents', actions: ['insert', 'delete', 'update'], reason: 'Document eligibility changes reconcile live prompts, calls and receipt placement.' },
    { table: 'myco_tool_calls', actions: ['insert', 'delete', 'update'], reason: 'Live Myco calls maintain their count and plan-read contribution.' },
    { table: 'spore_injections', actions: ['insert', 'delete', 'update'], reason: 'Receipts maintain delivery, served prompts and first-context lineage samples.' },
    { table: 'session_injections', actions: ['insert', 'delete', 'update'], reason: 'Session records maintain start blocks, served plan nudges and lineage samples.' },
    { table: 'sessions', actions: ['insert', 'update'], reason: 'Session receipt time and credential attribution maintain session and lineage measures.' },
    { table: 'transcripts', actions: ['insert', 'delete'], reason: 'Transcript membership maintains scheme measures and canonical harness attribution.' },
    { table: 'prompt_identity_conflicts', actions: ['insert', 'delete'], reason: 'Identity-conflict retention maintains keyed diagnostics.' },
    { table: 'prompt_context_answers', actions: ['insert', 'delete', 'update'], reason: 'Answer retention and skip evidence maintain duplicate-prompt diagnostics.' },
    { table: 'member_credentials', actions: ['delete'], reason: 'Credential removal retracts its lineage sample evidence.' },
  ].flatMap(({ table, actions, reason }) => actions.map(action => ({ step: V711, object: `kpi_${table}_${action}`, table, reason }))),
  ...[['idx_sessions_occurred_deployment', 'sessions'], ['idx_plans_updated_deployment', 'plans'], ['idx_events_token_only', 'events']].map(([object, table]) => ({
    step: CURSOR_INDEX_STEP, object: object!, table: table!, reason: 'Lists across Projects order by the instant, the id and the Project, and walk this index with no sort.',
  })),
  { step: 702, object: 'idx_sessions_credential', table: 'sessions', reason: 'First-context measurements seek the sessions attributed to each credential.' },
  { step: 703, object: 'idx_sessions_received', table: 'sessions', reason: 'KPI denominators seek session receipts in the selected time window.' },
  { step: 704, object: 'idx_transcripts_received', table: 'transcripts', reason: 'Prompt identity diagnostics seek transcript receipts in the selected time window.' },
  { step: 705, object: 'idx_spore_injections_delivery', table: 'spore_injections', reason: 'Delivery counts seek delivered injections in the selected time window.' },
  { step: 706, object: 'idx_agent_runs_worker_started', table: 'agent_runs', reason: 'Machine reads seek the latest run for each worker credential.' },
  ...['insert', 'update', 'reclassify', 'delete'].map(action => ({
    step: 708, object: `sessions_capture_head_${action}`, table: 'sessions',
    reason: 'Session mutations maintain the canonical machine and agent receipt head.',
  })),
  { step: 707, object: 'idx_sessions_unnamed_machine', table: 'sessions', reason: 'Unnamed-head classification seeks only the machine’s unnamed sessions.' },
  { step: 700, object: 'idx_curation_first_started', table: 'spore_curation_work', reason: 'Daily admission counts a bounded indexed window of first cluster attempts.' },
  ...['curation_inventory_map_move','curation_inventory_map_delete'].map(object=>({step:697,object,table:'canopy_maps',reason:'The map owns release of its previous committed inventory.'})),
  {step:697,object:'curation_inventory_run_end',table:'agent_runs',reason:'Terminal map runs release unreferenced repository evidence.'},
  { step: 696, object: 'idx_agent_runs_task_started', table: 'agent_runs', reason: 'Claim admission seeks recent starts of one task across the Deployment.' },
  { step: 701, object: 'idx_agent_run_events_failed', table: 'agent_run_events', reason: 'A failed run\'s own refusal is one seek, however many of its calls succeeded.' },
  { step: 695, object: 'idx_turn_cards_session_pending', table: 'turn_cards', reason: 'Pending recounts seek only the pending rows of one session.' },
  { step: 693, object: 'curation_capability_insert', table: 'project_capabilities', reason: 'Curation source and vector changes advance the durable discovery frontier.' },
  { step: 693, object: 'curation_capability_update', table: 'project_capabilities', reason: 'Curation source and vector changes advance the durable discovery frontier.' },
  { step: 693, object: 'curation_capability_delete', table: 'project_capabilities', reason: 'Curation source and vector changes advance the durable discovery frontier.' },
  { step: 694, object: 'card_run_retry', table: 'agent_runs', reason: 'Card retries retain task backoff while runner sign-in failures release their claim reservation.' },
  { step: 694, object: 'agent_run_login_retry', table: 'agent_runs', reason: 'A terminal sign-in failure returns only the retry reservation held by its dispatched attempt.' },
  { step: 693, object: 'curation_spore_insert', table: 'spores', reason: 'Curation source and vector changes advance the durable discovery frontier.' },
  { step: 693, object: 'curation_spore_update', table: 'spores', reason: 'Curation source and vector changes advance the durable discovery frontier.' },
  { step: 693, object: 'curation_spore_delete', table: 'spores', reason: 'Curation source and vector changes advance the durable discovery frontier.' },
  { step: 693, object: 'curation_vector_insert', table: 'embedding_receipts', reason: 'Curation source and vector changes advance the durable discovery frontier.' },
  { step: 693, object: 'curation_vector_update', table: 'embedding_receipts', reason: 'Curation source and vector changes advance the durable discovery frontier.' },
  { step: 693, object: 'curation_vector_delete', table: 'embedding_receipts', reason: 'Curation source and vector changes advance the durable discovery frontier.' },
  { step: 693, object: 'idx_spores_curation_seek', table: 'spores', reason: 'Curation discovery seeks a bounded active-spore page after its saved activity and id cursor.' },
  { step: 693, object: 'idx_curation_projects', table: 'project_capabilities', reason: 'Curation discovery seeks one opted-in Project after its saved Project cursor.' },
  { step: 693, object: 'idx_curation_runs_day', table: 'agent_runs', reason: 'Curation admission reads at most its daily ceiling of run entries.' },
  { step: 693, object: 'idx_curation_resolution_author', table: 'resolution_events', reason: 'A curation decision verifies this run’s lineage events by author and source.' },
  {step:116,object:'idx_transcript_publication_failed',table:'transcript_publication',reason:'Status counts the publications stopped for good without reading the others.'},
  {step:113,object:'idx_session_prompts_unlocated',table:'session_prompts',reason:'The locator backfill finds the prompts it has yet to locate without reading the located ones.'},
  {step:114,object:'idx_session_prompts_prompt',table:'session_prompts',reason:'A prompt cited by id alone is found in its Project without knowing its session.'},
  {step:114,object:'idx_session_prompts_created',table:'session_prompts',reason:'Prompt measures read a window of prompt times, not every prompt.'},
  {step:114,object:'idx_attachments_prompt_order',table:'attachments',reason:'A turn reads each prompt\'s first page of attachments, however many share a time.'},
  {step:114,object:'idx_prompt_context_answers_prompt_order',table:'prompt_context_answers',reason:'A turn reads each prompt\'s first page of context answers, however many share a time.'},
  {step:114,object:'idx_spore_injections_delivered_at',table:'spore_injections',reason:'A turn reads the latest receipt of each of its prompts without reading the others.'},
  {step:114,object:'turn_cards_fts_ai',table:'turn_cards',reason:'Card search follows every card written.'},
  {step:114,object:'turn_cards_fts_au',table:'turn_cards',reason:'Card search follows every card rewritten.'},
  {step:114,object:'turn_cards_fts_ad',table:'turn_cards',reason:'Card search drops every card deleted.'},
  {step:115,object:'idx_turn_cards_settle',table:'turn_cards',reason:'Card settlement reads the turns waiting for it across every Project without reading settled ones.'},
  {step:115,object:'idx_turn_cards_model_due',table:'turn_cards',reason:'A card claim reads one session\'s turns due for a model without reading its other cards.'},
  {step:112,object:'idx_session_documents_convert',table:'session_documents',reason:'Conversion finds the sessions still waiting for it without reading the converted ones.'},
  {step:111,object:'transcripts_document_insert',table:'transcripts',reason:'A transcript that arrives makes its live session due for publication and opens the document of a session first seen with it.'},
  {step:111,object:'transcripts_document_size',table:'transcripts',reason:'A transcript that grows makes its live session due for publication.'},
  {step:111,object:'events_document_queue',table:'events',reason:'A member content event is queued for its session\'s document in the statement that inserts it, by ingest and by restore alike, and makes its live session due.'},
  {step:106,object:'prompt_batches_legacy_class_insert',table:'prompt_batches',reason:'A parser row is classified as the legacy derivation in the statement that writes it.'},
  {step:106,object:'prompt_batches_legacy_class_update',table:'prompt_batches',reason:'A change to a row\'s class evidence reclassifies it in the same statement.'},
  {step:106,object:'responses_legacy_class_insert',table:'responses',reason:'A parser row is classified as the legacy derivation in the statement that writes it.'},
  {step:106,object:'responses_legacy_class_update',table:'responses',reason:'A change to a row\'s class evidence reclassifies it in the same statement.'},
  {step:106,object:'tool_calls_legacy_class_insert',table:'tool_calls',reason:'A parser row is classified as the legacy derivation in the statement that writes it.'},
  {step:106,object:'tool_calls_legacy_class_update',table:'tool_calls',reason:'A change to a row\'s class evidence reclassifies it in the same statement.'},
  {step:106,object:'plans_legacy_class_insert',table:'plans',reason:'A parser row is classified as the legacy derivation in the statement that writes it.'},
  {step:106,object:'plans_legacy_class_update',table:'plans',reason:'A change to a row\'s class evidence reclassifies it in the same statement.'},
  {step:106,object:'tags_plan_legacy_class_insert',table:'tags',reason:'A tag edit is plan edit evidence and reclassifies the plan.'},
  {step:106,object:'tags_plan_legacy_class_delete',table:'tags',reason:'A tag removal is plan edit evidence and reclassifies the plan.'},
  {step:103,object:'agent_attempt_settled_insert',table:'agent_run_attempts',reason:'New known costs receive Deployment-local settlement order.'},
  {step:103,object:'agent_attempt_settled_update',table:'agent_run_attempts',reason:'Newly known costs receive Deployment-local settlement order.'},
  {step:103,object:'agent_attempt_settlement_fixed',table:'agent_run_attempts',reason:'Settlement order remains stable for incremental estimate seeks.'},
  {step:103,object:'agent_attempt_cost_fixed',table:'agent_run_attempts',reason:'Settled attempt prices and known sources are immutable.'},
  {step:103,object:'agent_attempt_machine_fixed',table:'agent_run_attempts',reason:'Known attempt claim machine attribution is immutable.'},
  {step:103,object:'agent_runs_origin_insert',table:'agent_runs',reason:'Omitted dispatch origins must be classified before queue-head admission.'},
  {step:103,object:'agent_runs_origin_fixed',table:'agent_runs',reason:'Persisted dispatch origin is immutable.'},
  {step:103,object:'agent_attempt_claim_fixed',table:'agent_run_attempts',reason:'Claim time, estimate and profile are immutable attempt evidence.'},

  ...['prompts', 'responses', 'tool_calls', 'plans'].map((kind) => ({
    step: 105,
    object: 'idx_view_' + kind + '_identity',
    table: 'view_' + kind,
    reason: 'The writer extension requires empty instance storage.',
  })),
  {
    step: 105,
    object: 'idx_view_active_leases',
    table: 'view_instances',
    reason: 'Build slot admission indexes empty instance storage.',
  },
  {
    step: 105,
    object: 'idx_view_stale',
    table: 'view_instances',
    reason: 'Stale generation admission indexes empty instance storage.',
  },
  {
    step: 105,
    object: 'idx_view_promotions_pending',
    table: 'plan_promotions',
    reason: 'Publication admission indexes empty promotion storage.',
  },
  {
    step: 105,
    object: 'idx_view_prompt_source',
    table: 'view_prompts',
    reason: 'Coverage counterpart admission indexes empty material storage.',
  },
  {
    step: 107,
    object: 'idx_view_prompts_source_range',
    table: 'view_prompts',
    reason: 'Source-range acknowledgement indexes prompt storage of at most one row per captured prompt.',
  },
];
const EXCEPTIONS: readonly Exception[] = [
  ...[...LEARNING_SOURCE_STEPS, ...LEARNING_WORK_INDEX_STEPS, ...LEARNING_QUIET_STEPS, ...LEARNING_QUIET_MARGIN_STEPS].flatMap(step => step.statements.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null ? [] : [{ step: step.version, object: match[1]!, table: match[2]!,
      reason: 'Learning source activity, quiet eligibility and retry deadlines stay in indexed work queues.' }];
  })),
  { step: 536, object: 'publish_queue_facts_insert', table: 'publish_queue', reason: 'Queue status totals count active events across insertion, removal and terminal-state transitions.' },
  { step: 536, object: 'publish_queue_facts_delete', table: 'publish_queue', reason: 'Queue status totals count active events across insertion, removal and terminal-state transitions.' },
  { step: 536, object: 'publish_queue_facts_update', table: 'publish_queue', reason: 'Queue status totals count active events across insertion, removal and terminal-state transitions.' },
  ...[{version:466,statements:V466_STATEMENTS},...PUBLICATION_FACT_STEPS,...PUBLICATION_QUEUE_STEPS].flatMap(step => step.statements.flatMap(sql => {
    const match=/^CREATE TRIGGER(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    const existing=['embedding_switches','document_publication_facts','embedding_versions','embedding_receipts','embedding_hubness_members','deployment_settings','deployment_secrets',
      'embedding_source_failures','processed_resources','session_documents','transcripts','transcript_publication','publish_queue','retired_objects'];
    return match === null || !existing.includes(match[2]!) ? [] : [{step:step.version,object:match[1]!,table:match[2]!,
      reason:'Catalog mutations maintain embedding and publication facts atomically.'}];
  })),
  { step: 536, object: 'idx_publish_queue_read_retries', table: 'publish_queue', reason: 'Independent prompt read retries retain their order through a partial queue index.' },
  { step: 535, object: 'idx_publish_queue_active', table: 'publish_queue', reason: 'Publication selection skips retained terminal holds through its active queue index.' },
  ...READ_COST_STEPS.flatMap(step=>step.statements.flatMap(sql=>{
    const match=/^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match===null?[]:[{step:step.version,object:match[1]!,table:match[2]!,
      reason:sql.startsWith('CREATE INDEX')?'Bounded history pages seek their complete scope and cursor order.':'Source changes queue affected retirement identities atomically.'}];
  })),
  ...LISTED,
  ...UX_SCHEMA_STEPS.flatMap(step => step.statements.flatMap(sql => {
    const match = /^CREATE (?:INDEX|TRIGGER)(?: IF NOT EXISTS)? (\w+).*?\bON (\w+)/s.exec(sql);
    return match === null || /session_turn_entries/.test(match[2]!) ? [] : [{
      step: step.version, object: match[1]!, table: match[2]!, reason: 'Session outline and file reads use stored summaries and bounded catch-up indexes.',
    }];
  })),
  ...LISTED.filter((exception) => exception.step === 106).map((exception) => ({ ...exception, step: 108 })),
  ...['idx_learning_eligible', 'idx_learning_eligible_all', 'idx_learning_completed', 'idx_learning_init_pending'].map((object) => ({
    step: 110,
    object,
    table: 'learning_sessions',
    reason: 'Learning progress columns are indexed where their claim, status and initialization reads seek them.',
  })),
  ...[
    ['prompt_batches_learning_session', 'prompt_batches'],
    ['prompt_batches_turn_card_open', 'prompt_batches'],
    ['prompt_batches_turn_card_insert', 'prompt_batches'],
    ['prompt_batches_turn_card_update', 'prompt_batches'],
    ['responses_turn_card_insert', 'responses'],
    ['tool_calls_turn_card_insert', 'tool_calls'],
    ['tool_calls_turn_card_update', 'tool_calls'],
    ['plans_turn_card_insert', 'plans'],
    ['plans_turn_card_update', 'plans'],
  ].map(([object, table]) => ({
    step: 110,
    object: object!,
    table: table!,
    reason: 'A record written into a turn makes that turn due for its card in the same statement.',
  })),
  ...['session_views_learning_insert', 'session_views_learning_update'].map((object) => ({
    step: 110,
    object,
    table: 'session_views',
    reason: 'A session becomes due for learning in the batch that publishes its views.',
  })),
];
interface StatementException {
  step: number;
  sql: string;
  reason: string;
}
const STATEMENT_EXCEPTIONS: readonly StatementException[] = [
  ...VNEXT_S6B_STEPS.flatMap(({ version: step, statements }) => statements.filter(sql => /^(ALTER TABLE|INSERT INTO|DROP TABLE)/.test(sql)).map(sql => ({
    step, sql, reason: 'Authority retention adds its deadline, registers the catch-up, seeds the active Project count, and retires the last unused authority table.'
  }))),
  ...VNEXT_S4B2_STEPS.flatMap(({ version: step, statements }) => statements.filter(sql => /^(ALTER TABLE|INSERT INTO change_marks|INSERT INTO projection_catchup|DROP TRIGGER|DROP INDEX)/.test(sql)).map(sql => ({
    step, sql, reason: 'A learning session records its counted contributions and deadlines, the old pending trigger is replaced by the keyed contribution triggers, the counting catch-up is registered, and the scheduling indexes with no reader left go.'
  }))),
  ...S1C_STATEMENTS.filter(sql => !/^CREATE (INDEX|TABLE|TRIGGER)/.test(sql)).map(sql => ({ step: NEXT_S1C, sql,
    reason: 'Fleet tables: catalog metadata, the harness report split into per-harness rows, and the head seed phases; no history-sized table is rewritten.' })),
  ...VNEXT_S6_STATEMENTS.filter(sql => /^INSERT INTO projection_catchup/.test(sql)).map(sql => ({
    step: NEXT_S6, sql, reason: 'Runtime counts stay building until the catch-up has given every existing lineage its head.'
  })),
  ...VNEXT_S7_STEPS.flatMap(({ version: step, statements }) => statements.filter(sql => /^(INSERT INTO learning_quiet_policy|DROP TRIGGER)/.test(sql)).map(sql => ({
    step, sql, reason: 'Existing deadlines already hold the stored idle close, so the first generation is seeded as active; the triggers that rewrote every session in a settings write go, and the per-row triggers are replaced to follow the generation.'
  }))),
  ...VNEXT_S8B_STEPS.flatMap(({ version: step, statements }) => statements.filter(sql => /^(ALTER TABLE|INSERT INTO (?:projection_catchup|backup_retention_state)|DROP INDEX|SELECT CASE)/.test(sql)).map(sql => ({
    step, sql, reason: 'Each backup carries a verification state, its week heads are built through the shared catch-up, the upgrade names a duplicate key instead of guessing, and the unique index replaces the non-unique one.'
  }))),
  ...VNEXT_S5D_STEPS.flatMap(({ version: step, statements }) => statements.filter(sql => /^(ALTER TABLE|INSERT INTO projection_catchup)/.test(sql)).map(sql => ({
    step, sql, reason: 'A release state carries its current key and comparison fields as columns, a Project its work generation, and the catch-up that fills them stays building until every existing row is placed.'
  }))),
  ...VNEXT_S2C2_STEPS.flatMap(({ version: step, statements }) => statements.filter(sql => /^(ALTER TABLE|INSERT INTO projection_catchup|DROP INDEX)/.test(sql)).map(sql => ({
    step, sql, reason: 'The session and uncaptured indexes go once a complete order replaces them, and Project statistics add counter columns and are seeded through the shared catch-up.'
  }))),
  ...VNEXT_S2C_STEPS.flatMap(({ version: step, statements }) => statements.filter(sql => /^(INSERT INTO projection_catchup|DROP INDEX)/.test(sql)).map(sql => ({
    step, sql, reason: 'Title work is seeded through the shared catch-up, and the four titling scan indexes go once their readers read title work.'
  }))),
  ...CARD_SETTLE_AND_LOCATOR_STEPS.flatMap(({ version: step, statements }) => statements.filter(sql => /^(ALTER TABLE|INSERT INTO projection_catchup|DROP INDEX)/.test(sql)).map(sql => ({
    step, sql, reason: 'A pending card records the deadline it was promoted at, the two scan indexes go with their reader, and the locator repair catch-up is registered.'
  }))),
  ...V727_STATEMENTS.filter(sql => /^(ALTER TABLE|INSERT INTO projection_catchup|UPDATE object_releases|DROP INDEX)/.test(sql)).map(sql => ({
    step: V727, sql, reason: 'Each release key carries when it is next due, and storage usage stays building until the catch-up has counted every registered blob.'
  })),
  ...SESSION_LIFECYCLE_STEPS.flatMap(({ version: step, statements }) => statements.filter(sql => /^(ALTER TABLE|INSERT INTO)/.test(sql)).map(sql => ({
    step, sql, reason: 'Events gain their acting member, the wake continuation and totals row are seeded, and catch-up phases are registered.'
  }))),
  ...V723_STATEMENTS.filter(sql => /^(ALTER TABLE|INSERT INTO projection_catchup)/.test(sql)).map(sql => ({
    step: V723, sql, reason: 'Document metadata remains in source blobs with a keyed directory and an explicit chunk class.'
  })),
  ...V718_STATEMENTS.filter(sql => /^ALTER TABLE/.test(sql)).map(sql => ({
    step: V718, sql, reason: 'Publication records its directory cursor and committed revision without backfilling history.'
  })),

  ...V725_STATEMENTS.filter(sql => sql.startsWith('ALTER TABLE')).map(sql => ({ step: V725, sql,
    reason: 'A member names the stored page and frame holding its vector; a row with none still holds its own bytes.' })),

  ...V722_STATEMENTS.filter(sql => sql.startsWith('DROP ') || sql.startsWith('ALTER TABLE') || sql.startsWith('INSERT INTO projection_catchup')).map(sql => ({ step: V722, sql,
    reason: sql.startsWith('ALTER') ? 'The lost-vector probe retains the last write of the vector it stopped at, the order abandoned vectors are walked in.'
      : sql.startsWith('INSERT') ? 'Calibration state is initialized through the shared projection catch-up.'
      : sql.includes('embedding_hubness_population') || sql.includes('embedding_hubness_work') || sql.includes('_population_') ? 'The population snapshot and the in-flight work table are retired: nothing reads either.'
      : 'Each trigger is replaced by a narrower one that still advances the same revision or dirties the same work.' })),
  ...V720_STATEMENTS.filter(sql => sql.startsWith('DROP TRIGGER')).map(sql => ({ step: V720, sql,
    reason: 'Each work trigger is replaced by the same body plus the attention mark.' })),
  ...V721_STATEMENTS.filter(sql => sql.startsWith('INSERT OR IGNORE INTO search_revisions')).map(sql => ({ step: V721, sql, reason: 'Each searched kind starts at search revision 0.' })),
  ...V721_STATEMENTS.filter(sql => sql.startsWith('DROP INDEX')).map(sql => ({ step: V721, sql, reason: 'The Deployment-wide spore index is replaced under its own name with the Project after the id.' })),
  ...V721_STATEMENTS.filter(sql => sql.startsWith('INSERT INTO projection_catchup')).map(sql => ({ step: V721, sql, reason: 'Spore and plan totals record whether existing rows need counting by the catch-up.' })),
  ...VNEXT_S2E_STEPS.flatMap(step => step.statements.map(sql => ({ step: step.version, sql,
    reason: sql.startsWith('CREATE INDEX') ? 'The hot event archive seeks due rows by receipt age: one index over the table it reads, in its own step.'
      : sql.startsWith('ALTER') ? 'The archive sweep cursor orders hot rows by receipt age alone, so the session columns of the retired walk go.'
      : 'A cursor from the retired walk has no meaning in the new order, so it restarts at the head of the due path.' }))),
  ...NEXT_S8A2_STATEMENTS.filter(sql => sql.startsWith('INSERT')).map(sql => ({ step: NEXT_S8A2, sql, reason: 'The walk over the object store seeds its one position row.' })),
  { step: NEXT_S4B, sql: "INSERT INTO projection_catchup(projection,phase,done) SELECT 'spore_resolution_edges','sporeResolutionEdges',NOT EXISTS(SELECT 1 FROM resolution_events) ON CONFLICT DO NOTHING", reason: 'Lineage edges record whether existing resolution events need replaying by the catch-up.' },
  ...VNEXT_S2D_STEPS.at(-1)!.statements.filter(sql => /^(ALTER TABLE|DROP INDEX)/.test(sql)).map(sql => ({ step: NEXT_S2D, sql, reason:
    sql.startsWith('DROP') ? 'Nothing reads the deletion-window index once the orphan audit replaced its gate.'
      : 'The orphan audit keeps the floor it may release from and when its next pass begins beside the cursor it already holds.' })),
  ...STORAGE_STATEMENTS.filter(sql => sql.startsWith('ALTER') || sql.startsWith('INSERT')).map(sql => ({ step: STORAGE_NEXT, sql, reason: 'The release owner persists retry deadlines and the settlement reconciliation cursor.' })),
  ...V716_STATEMENTS.filter(sql => sql.startsWith('ALTER TABLE')).map(sql => ({ step: V716, sql,
    reason: sql.includes('epoch') ? 'Each Project model carries the epoch a reset advances.'
      : sql.includes('projection_catchup') ? 'Each catch-up phase carries the generation a restart advances, which fences page settlement.'
      : 'Receipts, failures and provider holds record the attempt that wrote them, which fences their settlement.' })),
  ...V716_STATEMENTS.filter(sql => sql.startsWith('INSERT INTO')).map(sql => ({ step: V716, sql,
    reason: sql.includes('embedding_attempt_clock') ? 'The attempt clock starts once, before any attempt.'
      : sql.includes('embedding_reset') ? 'Reset retirement phases start finished, with no reset admitted.' : 'Source state records whether existing versions need catch-up.' })),
  ...V717_STATEMENTS.filter(sql => /^(ALTER TABLE|DROP TRIGGER|INSERT INTO projection_catchup)/.test(sql)).map(sql => ({
    step: V717, sql, reason: 'Add the input revision, replace recount triggers and seed bounded contribution catch-up without rewriting source history.'
  })),
  ...V731_STATEMENTS.filter(sql => sql.startsWith('INSERT INTO projection_catchup')).map(sql => ({ step: V731, sql, reason: 'Run evidence counts remain building until the bounded catch-up has counted every run and attempt.' })),
  ...S1B2_STEPS.flatMap(({ version, statements }) => statements.filter(sql => sql.startsWith('DROP INDEX')).map(sql => ({ step: version, sql, reason: 'The session and record covering index, built in its own earlier step, serves every statement this prefix served.' }))),
  ...V724_STATEMENTS.filter(sql => sql.startsWith('INSERT INTO projection_catchup')).map(sql => ({ step: V724, sql, reason: 'Work history remains building until the bounded catch-up has read every terminal run.' })),
  ...V726_STATEMENTS.filter(sql => sql.startsWith('INSERT OR IGNORE INTO change_marks')).map(sql => ({ step: V726, sql, reason: 'The Attention revision exists before its first transition, so an open page has a value to compare.' })),
  ...V719_STATEMENTS.filter(sql => sql.startsWith('INSERT INTO projection_catchup')).map(sql => ({ step: V719, sql, reason: 'Run admission counts remain building until the bounded run catch-up completes.' })),
  ...V710_STATEMENTS.filter(sql => sql.startsWith('INSERT')).map(sql => ({
    step: 710, sql, reason: 'Existing configured values and reset receipts seed persistent leaf revisions once.',
  })),
  ...V714_STATEMENTS.filter(sql => sql.startsWith('INSERT INTO projection_catchup')).map(sql => ({ step: V714, sql, reason: 'Spend accounting records whether existing attempt history needs catch-up.' })),
  ...V712_STATEMENTS.filter(sql => sql.startsWith('INSERT INTO')).map(sql => ({ step: V712, sql, reason: 'Derived readiness and change revisions initialize without changing sources.' })),
  ...V711_STATEMENTS.filter(sql => sql.startsWith('INSERT INTO projection_catchup')).map(sql => ({ step: V711, sql, reason: 'Projection phases record whether existing source history needs catch-up.' })),
  ...V708_STATEMENTS.filter(sql => sql.startsWith('INSERT')).map(sql => ({
    step: 708, sql, reason: 'Receipt heads initialize once from each machine and agent’s latest canonical session.',
  })),
  {
    step: 698,
    sql: `INSERT OR IGNORE INTO retired_deployment_settings (leaf,value,updated_at,updated_by,retired_at)
    SELECT leaf,value,updated_at,updated_by,unixepoch()*1000
    FROM deployment_settings WHERE leaf='cortex.canopy.refresh.background_enabled'`,
    reason: 'Retired map refresh preferences retain their exact stored value and attribution.',
  },
  {
    step: 698,
    sql: `INSERT INTO _v698_guard_retired_settings(ok) SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM deployment_settings live WHERE leaf='cortex.canopy.refresh.background_enabled'
    AND NOT EXISTS (SELECT 1 FROM retired_deployment_settings saved WHERE saved.leaf=live.leaf
      AND saved.value=live.value AND saved.updated_at=live.updated_at AND saved.updated_by=live.updated_by)
    ) THEN 1 ELSE 0 END`,
    reason: 'The archive must match the complete active preference before deletion.',
  },
  { step: 698, sql: 'DROP TABLE _v698_guard_retired_settings', reason: 'The temporary archive guard is released after admission.' },
  {
    step: 698,
    sql: "DELETE FROM deployment_settings WHERE leaf='cortex.canopy.refresh.background_enabled'",
    reason: 'The archived map refresh switch has no active consumer.',
  },
  ...['curation_inventory_map_move','curation_inventory_map_delete','curation_inventory_run_end'].map(name => ({
    step: 709, sql: `DROP TRIGGER IF EXISTS ${name}`, reason: 'Curation retains no file-inventory evidence.',
  })),
  ...['agent_runs DROP COLUMN repository_files','spore_curation_candidates DROP COLUMN currency'].map(target => ({
    step: 709, sql: `ALTER TABLE ${target}`, reason: 'Knowledge validity has no stored file-existence facts.',
  })),
  { step: 700, sql: 'ALTER TABLE spore_curation_work ADD COLUMN first_started_at INTEGER', reason: 'A cluster retains the time of its first admitted attempt across retries.' },
  { step: 700, sql: `UPDATE spore_curation_work AS w SET first_started_at=firsts.started_at FROM
    (SELECT project_id,subject,MIN(started_at) AS started_at FROM agent_runs WHERE task='curate-spores' AND started_at IS NOT NULL GROUP BY project_id,subject) AS firsts
    WHERE firsts.project_id=w.project_id AND firsts.subject='curation:'||w.project_id||':'||w.cluster_key`, reason: 'Existing clusters retain their first start through their canonical run subjects.' },
  { step: 699, sql: 'ALTER TABLE spore_curation_work ADD COLUMN write_refusal TEXT CHECK(write_refusal IS NULL OR json_valid(write_refusal))', reason: 'The assignment retains its outstanding lifecycle refusal until a corrected write commits.' },
  { step: 697, sql: 'ALTER TABLE agent_runs ADD COLUMN repository_files TEXT CHECK(repository_files IS NULL OR json_valid(repository_files))', reason: 'Map preparation retains its complete committed file inventory.' },
  { step: 697, sql: 'ALTER TABLE spore_curation_candidates ADD COLUMN currency TEXT CHECK(currency IS NULL OR json_valid(currency))', reason: 'Whole-read candidates retain the server currency fact for their revision.' },
  ...V695_STATEMENTS.filter(sql => !sql.startsWith('CREATE')).map(sql => ({step:695,sql,
    reason: 'Retired pause markers are removed.' })),
  { step: 693, sql: "INSERT INTO spore_curation_changes SELECT project_id,1,1,0 FROM project_capabilities WHERE capability='spore_curation' AND enabled=1", reason: "Enabled Projects begin a cluster discovery pass." },
  { step: 693, sql: 'INSERT OR IGNORE INTO spore_curation_clock(id) VALUES(1)', reason: 'The curation clock starts its Project traversal at the first opted-in Project.' },
  ...[...LEARNING_SOURCE_STEPS, ...LEARNING_QUIET_STEPS, ...LEARNING_QUIET_MARGIN_STEPS].flatMap(({ version: step, statements }) => statements.filter(sql => !sql.startsWith('CREATE')).map(sql => ({ step, sql,
    reason: 'Learning queue metadata backfills in disjoint rowid transactions while preserving cards and coverage.' }))),
  { step: 694, sql: 'DROP TRIGGER IF EXISTS card_run_retry', reason: 'The replacement terminal trigger excludes runner sign-in failures from card backoff.' },
  { step: 536, sql: 'DROP TRIGGER IF EXISTS publish_queue_facts_insert', reason: 'Active queue contributions replace the existing insertion and removal status counters in the same migration.' },
  { step: 536, sql: 'DROP TRIGGER IF EXISTS publish_queue_facts_delete', reason: 'Active queue contributions replace the existing insertion and removal status counters in the same migration.' },
  { step: 536, sql: 'ALTER TABLE publish_queue ADD COLUMN retry_cause TEXT CHECK (retry_cause IS NULL OR json_valid(retry_cause))', reason: 'Publication waits retain read and parent dependency causes independently of their retry deadline.' },
  { step: 465, sql: 'ALTER TABLE turn_cards ADD COLUMN fields TEXT', reason: 'Cards retain their structured fields in a nullable column added without rewriting rows or rebuilding search.' },
  ...V466_STATEMENTS.filter(sql=>sql.startsWith('INSERT OR IGNORE INTO schema_meta')).map(sql=>({step:466,sql,
    reason:'Provider configuration changes fence pending provider failures.'})),
  ...PUBLICATION_QUEUE_STEPS.flatMap(({version:step,statements})=>statements.filter(sql=>!sql.startsWith('CREATE')).map(sql=>({step,sql,
    reason:'Calibration cursors carry their publication revision; publication queue identities enter disjoint rowid ranges, catalog triggers net changed facts and switch lifecycle changes release model holds.'}))),
  ...PUBLICATION_FACT_STEPS.flatMap(({version:step,statements})=>statements.filter(sql=>!sql.startsWith('CREATE')).map(sql=>({step,sql,
    reason:'Publication facts initialize from disjoint document rowid ranges, with queue counts and the range boundary captured once.'}))),
  { step: 535, sql: 'ALTER TABLE publish_queue ADD COLUMN failure TEXT', reason: 'The publication owner retains a named failure on an unreadable queued event.' },
  { step: 535, sql: 'ALTER TABLE publish_queue ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0', reason: 'Each queued event waits for its own retry deadline while other content publishes.' },
  ...DROP_CONTENT_SCHEMA_STEPS.flatMap(({version:step,statements})=>statements.filter(sql=>!/^CREATE TABLE/.test(sql)).map(sql=>({step,sql,reason:'Retired content storage leaves in bounded transactions: triggers, then indexes, then rowid ranges, then the tables.'}))),
  ...RETIREMENT_SCHEMA_STEPS.flatMap(({version:step,statements})=>statements.filter(sql=>!/^CREATE (?:TABLE|INDEX)/.test(sql)).map(sql=>({step,sql,reason:'Retained documents and raw blob holders are required until relational content storage is retired.'}))),
  ...V255_STATEMENTS.filter(sql => sql.startsWith('ALTER TABLE') || sql.startsWith('UPDATE session_documents')).map(sql => ({
    step:255,sql,reason:'Existing documents retain their catalog and catch up summary fields within the publisher budget.',
  })),
  ...CURSOR_INDEX_STATEMENTS.filter(sql => sql.startsWith('DROP INDEX')).map(sql => ({
    step: CURSOR_INDEX_STEP, sql, reason: 'Each Deployment-wide list index is replaced under its own name with the Project after the id.',
  })),
  ...UX_SCHEMA_STEPS.flatMap(step => step.statements.filter(sql => sql.startsWith('DROP INDEX')).map(sql => ({
    step: step.version, sql, reason: 'The ordered turn index is replaced in its own transaction.',
  }))),

  ...V115_STATEMENTS.filter((sql) => !sql.startsWith('CREATE INDEX')).map((sql) => ({
    step: 115, sql, reason: 'Learning reads documents: the legacy card triggers go, cards wait for settlement, and every live session and turn gets its learning and card rows.',
  })),
  ...V114_STATEMENTS.filter((sql) => sql.includes('turn_cards_fts USING fts5') || sql.startsWith("INSERT INTO turn_cards_fts(turn_cards_fts)")).map((sql) => ({
    step: 114, sql, reason: 'Card search is an external-content index over the cards already written.',
  })),
  {
    step: 111,
    sql: V111_STATEMENTS.find((sql) => sql.startsWith('INSERT OR IGNORE INTO session_documents'))!,
    reason: 'Every session present before the step waits for conversion; a session first seen after it is published from its first byte.',
  },
  ...LISTED.filter((exception) => exception.step === 106).map((exception) => ({
    step: 108,
    sql: 'DROP TRIGGER IF EXISTS ' + exception.object,
    reason: 'The step replaces the trigger it drops.',
  })),
  {
    step: 105,
    sql: 'INSERT INTO _v105_empty SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM view_instances) THEN 1 ELSE 0 END',
    reason: 'Writer extensions require empty instance storage.',
  },
  { step: 105, sql: 'DROP TABLE IF EXISTS _v105_empty', reason: 'The admission table is temporary.' },
  ...['view_prompts', 'view_responses', 'view_tool_calls', 'view_plans'].flatMap((table) =>
    [
      'material_seq INTEGER CHECK(material_seq IS NULL OR material_seq>0)',
      'view_content_hash TEXT',
      'hash_scheme TEXT',
      'canonical_identity TEXT',
    ].map((column) => ({
      step: 105,
      sql: 'ALTER TABLE ' + table + ' ADD COLUMN ' + column,
      reason: 'Empty material storage carries publication identity and sequence.',
    })),
  ),
  ...['outcome_source TEXT', 'call_source TEXT'].map((column) => ({
    step: 105,
    sql: 'ALTER TABLE view_tool_calls ADD COLUMN ' + column,
    reason: 'Tool assembly persists canonical source order in empty storage.',
  })),
  {
    step: 105,
    sql: "ALTER TABLE view_plans ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'",
    reason: 'Empty plan storage retains the complete logical tag set.',
  },
  ...[
    'parsed_at INTEGER',
    'parser_version INTEGER',
    'fidelity TEXT',
    'parse_segment_lines INTEGER',
    'prompt_generation INTEGER',
    'parse_failed_at INTEGER',
  ].map((column) => ({
    step: 105,
    sql: 'ALTER TABLE view_checkpoints ADD COLUMN ' + column,
    reason: 'Empty checkpoints carry the complete live frontier.',
  })),
  ...[
    'learned_seq INTEGER NOT NULL DEFAULT 0',
    "init_state TEXT NOT NULL DEFAULT 'pending' CHECK (init_state IN ('pending','awaiting_publication','ready'))",
    'eligible_at INTEGER',
    'pending_cards INTEGER NOT NULL DEFAULT 0',
    'due_cards INTEGER NOT NULL DEFAULT 0',
    'failures INTEGER NOT NULL DEFAULT 0',
    'skipped_by_owner INTEGER NOT NULL DEFAULT 0',
    'handoff TEXT CHECK (handoff IS NULL OR length(CAST(handoff AS BLOB)) <= 4096)',
    'carded_seq INTEGER NOT NULL DEFAULT 0',
    'last_completed_at INTEGER',
    'last_completed_reason TEXT',
  ].map((column) => ({
    step: 110,
    sql: 'ALTER TABLE learning_sessions ADD COLUMN ' + column,
    reason: 'Each session carries its learning progress, eligibility and last completion.',
  })),
  {
    step: 545,
    sql: 'ALTER TABLE learning_sessions ADD COLUMN last_completed_run TEXT',
    reason: 'Dependent learning writes belong to the run that completed the guarded revision.',
  },
  {
    step: 110,
    sql: `INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('learning_resumed_at', CAST(unixepoch() * 1000 AS TEXT))`,
    reason: 'The Deployment records when whole-session learning resumed.',
  },
  {
    step: 101,
    sql: 'ALTER TABLE spores ADD COLUMN revision INTEGER NOT NULL DEFAULT 0',
    reason: 'Each existing spore carries its revision.',
  },
  {
    step: 101,
    sql: `INSERT OR IGNORE INTO schema_meta (key, value)
     VALUES ('guard_enabled_at', CAST(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS TEXT))`,
    reason: 'The Deployment records its revision-guard dispatch boundary.',
  },
  {
    step: 102,
    sql: `INSERT OR IGNORE INTO retired_deployment_settings (leaf,value,updated_at,updated_by,retired_at)
    SELECT 'agent.tasks.extract-curate.schedule',value,updated_at,updated_by,unixepoch()*1000
    FROM deployment_settings WHERE leaf='agent.tasks' AND CASE WHEN json_valid(value) THEN json_type(value, '$."extract-curate".schedule') IS NOT NULL ELSE 1 END`,
    reason: 'The Deployment retains the original extraction schedule preferences.',
  },
  {
    step: 102,
    sql: `INSERT INTO _v102_guard_learning_settings(ok) SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM deployment_settings live WHERE leaf='agent.tasks' AND CASE WHEN json_valid(value) THEN json_type(value, '$."extract-curate".schedule') IS NOT NULL ELSE 1 END
    AND NOT EXISTS (SELECT 1 FROM retired_deployment_settings saved WHERE saved.leaf='agent.tasks.extract-curate.schedule'
      AND saved.value=live.value AND saved.updated_at=live.updated_at AND saved.updated_by=live.updated_by)
    ) THEN 1 ELSE 0 END`,
    reason: 'The settings guard requires the complete retired preference record.',
  },
  {
    step: 102,
    sql: `DROP TABLE _v102_guard_learning_settings`,
    reason: 'The temporary settings guard is released after admission.',
  },
  {
    step: 102,
    sql: `UPDATE deployment_settings
    SET value=json_set(value, '$."extract-curate".enabled', json(value -> '$."extract-curate".schedule.enabled')),
      write_id=lower(hex(randomblob(16)))
    WHERE leaf='agent.tasks' AND CASE WHEN json_valid(value) THEN
      json_type(value)='object' AND json_type(value, '$."extract-curate"')='object'
      AND json_type(value, '$."extract-curate".schedule')='object'
      AND json_type(value, '$."extract-curate".schedule.enabled') IS NOT NULL
      AND json_type(value, '$."extract-curate".enabled') IS NULL ELSE 0 END`,
    reason: 'The extraction enabled preference retains its stored value.',
  },
  {
    step: 102,
    sql: `UPDATE deployment_settings
    SET value=json_set(value, '$."extract-curate".memberRunsPerDay', json(value -> '$."extract-curate".schedule.memberRunsPerDay')),
      write_id=lower(hex(randomblob(16)))
    WHERE leaf='agent.tasks' AND CASE WHEN json_valid(value) THEN
      json_type(value)='object' AND json_type(value, '$."extract-curate"')='object'
      AND json_type(value, '$."extract-curate".schedule')='object'
      AND json_type(value, '$."extract-curate".schedule.memberRunsPerDay') IS NOT NULL
      AND json_type(value, '$."extract-curate".memberRunsPerDay') IS NULL ELSE 0 END`,
    reason: 'The extraction member allowance retains its stored value.',
  },
  {
    step: 102,
    sql: `UPDATE deployment_settings SET value=json_remove(value, '$."extract-curate".schedule'),write_id=lower(hex(randomblob(16)))
    WHERE leaf='agent.tasks' AND CASE WHEN json_valid(value) THEN
      json_type(value)='object' AND json_type(value, '$."extract-curate"')='object'
      AND json_type(value, '$."extract-curate".schedule')='object' ELSE 0 END`,
    reason: 'The extraction task uses flat preferences.',
  },
  {
    step: 102,
    sql: `INSERT OR IGNORE INTO schema_meta(key,value) VALUES ('learning_paused_at',CAST(unixepoch()*1000 AS TEXT))`,
    reason: 'The Deployment records its learning pause boundary.',
  },
  {
    step: 102,
    sql: `UPDATE member_credentials SET revoked_at=(SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='learning_paused_at'),
      revoked_by='mem_harness'
    WHERE member_id='mem_harness' AND revoked_at IS NULL AND EXISTS (
      SELECT 1 FROM agent_runs WHERE status='queued' AND task='extract-curate' AND dispatched_by=member_credentials.id)`,
    reason: 'Queued extraction credentials are revoked at the pause boundary.',
  },
  {
    step: 102,
    sql: `UPDATE agent_runs SET status='skipped',
    completed_at=(SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='learning_paused_at'),
    run_context='{"reason":"learning_paused"}',held_by=NULL,dispatch_spec=NULL
    WHERE status='queued' AND task='extract-curate'`,
    reason: 'Queued extraction attempts close with their learning pause reason.' },
  { step: 103, sql: "ALTER TABLE agent_run_attempts ADD COLUMN estimate_usd REAL CHECK(estimate_usd IS NULL OR estimate_usd>=0)",
    reason: "Attempts retain the forecast recorded at claim time." },
  { step: 103, sql: "ALTER TABLE agent_run_attempts ADD COLUMN cost_usd REAL CHECK(cost_usd IS NULL OR cost_usd>=0)",
    reason: "Attempts retain their settled price." },
  { step: 103, sql: "ALTER TABLE agent_run_attempts ADD COLUMN cost_source TEXT",
    reason: "Attempts retain their settled price source." },
  { step: 103, sql: "ALTER TABLE agent_run_attempts ADD COLUMN profile_json TEXT",
    reason: "Attempts retain their immutable model and harness profile." },
  { step: 103, sql: "ALTER TABLE agent_run_attempts ADD COLUMN settled_seq INTEGER CHECK(settled_seq IS NULL OR settled_seq>0)",
    reason: "Known attempt costs retain Deployment-local settlement order." },
  { step: 103, sql: "INSERT OR IGNORE INTO schema_meta(key,value) VALUES('budget.settlement_sequence','0')",
    reason: "The Deployment records its monotonic settlement sequence." },
  { step: 103, sql: "ALTER TABLE agent_runs ADD COLUMN origin TEXT CHECK(origin IN ('manual','automatic'))",
    reason: "Dispatches retain their automatic or manual origin." },
  { step: 103, sql: "UPDATE agent_runs SET origin=COALESCE(origin,CASE WHEN CASE WHEN json_valid(dispatch_spec) THEN CASE WHEN json_type(dispatch_spec, '$.actor') = 'text' THEN NULLIF(json_extract(dispatch_spec, '$.actor'), '') END END IN ('clock','backfill','deployment') THEN 'automatic' ELSE 'manual' END) WHERE status IN ('pending', 'running', 'queued') AND origin IS NULL",
    reason: "Live dispatches receive the origin fixed by their persisted actor." },
  { step: 104, sql: `INSERT INTO _v104_guard_thin_learning(pause_required,not_drained)
    SELECT CASE WHEN refusal='thin_learning_pause_required' THEN 1 ELSE 0 END,
      CASE WHEN refusal='thin_learning_not_drained' THEN 1 ELSE 0 END FROM (WITH thin_learning_runs AS (SELECT task,status,queued_at,started_at FROM agent_runs) SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM schema_meta WHERE key='learning_paused_at' AND typeof(value)='text' AND length(value)>0
  AND value NOT GLOB '*[^0-9]*' AND CAST(value AS INTEGER)>0
  AND CAST(value AS INTEGER)<=9007199254740991
  AND CAST(CAST(value AS INTEGER) AS TEXT)=value) THEN 'thin_learning_pause_required'
    WHEN EXISTS (SELECT 1 FROM thin_learning_runs WHERE task='extract-curate' AND status IN ('pending', 'running', 'queued')
      AND (COALESCE(queued_at,started_at) IS NULL
        OR typeof(COALESCE(queued_at,started_at))!='integer'
        OR COALESCE(queued_at,started_at)<=(SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='learning_paused_at')))
      THEN 'thin_learning_not_drained'
    ELSE NULL END AS refusal)`,
    reason: 'Activation requires a valid pause boundary and drained thin extraction dispatches.' },
  { step: 104, sql: 'DROP TABLE _v104_guard_thin_learning',
    reason: 'The temporary admission guard is released after validation.' },
  { step: 116, sql: `UPDATE session_documents SET due_at = 0 WHERE state = 'live' AND due_at IS NULL AND (project_id, session_id, generation) IN
    (SELECT project_id, session_id, generation FROM transcript_publication WHERE state = 'failed' AND failure IN ('blob_absent', 'receipt_absent'))`, reason: 'A quiet session whose publication stands stopped on a fault that can clear is due again, so the publisher reads that stop as a fault to retry.' },
  { step: 116, sql: 'ALTER TABLE transcript_publication ADD COLUMN placed_records INTEGER', reason: 'A line too wide for one commit keeps the count of its records already placed, so every pass advances.' },
  { step: 116, sql: 'ALTER TABLE transcript_publication ADD COLUMN placed_digest TEXT', reason: 'A resumed line skips its placed records only while the derivation still holds what was placed.' },
  { step: 116, sql: 'ALTER TABLE session_pages ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0', reason: 'A page whose record ids the catalog holds leaves the search for a record, so placing into a wide owner stays bounded.' },
  { step: 113, sql: 'ALTER TABLE session_prompts ADD COLUMN page INTEGER', reason: 'A prompt read by name opens the page of its owner that holds its record.' },
  { step: 113, sql: 'ALTER TABLE session_documents ADD COLUMN locate_after INTEGER', reason: 'The locator backfill resumes after the last page chunk it read.' },
  { step: 114, sql: 'ALTER TABLE session_documents ADD COLUMN restore_hold TEXT', reason: 'A restore holds the sessions it converts from conversion, and from other restores, under its own identity.' },
  { step: 109, sql: 'ALTER TABLE agent_runs ADD COLUMN subject TEXT',
    reason: 'Runs retain the single-flight subject a pulled or subject-bearing claim writes.' },
];
const IDENTIFIER = '(?:[a-zA-Z_][a-zA-Z_0-9]*|"[^"]+"|`[^`]+`|\\[[^\\]]+\\])';
const QUALIFIED_IDENTIFIER = `(?:${IDENTIFIER}\\s*\\.\\s*)?${IDENTIFIER}`;
const name = (value: string) => value.replace(/^["`\[]|["`\]]$/g, '').toLowerCase();
const createTable = new RegExp(
  `^CREATE\\s+(?:VIRTUAL\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})(?:\\s|\\()`,
  'i',
);
const createIndex = new RegExp(
  `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})\\s+ON\\s+(${QUALIFIED_IDENTIFIER})\\s*\\(`,
  'i',
);
const createTrigger = new RegExp(
  `^CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER})\\s+(?:BEFORE|AFTER|INSTEAD\\s+OF)\\s+(?:INSERT|DELETE|UPDATE(?:\\s+OF\\s+${IDENTIFIER}(?:\\s*,\\s*${IDENTIFIER})*)?)\\s+ON\\s+(${QUALIFIED_IDENTIFIER})\\s`,
  'i',
);

function withoutLeadingComments(sql: string): string | null {
  let rest = sql.trimStart();
  while (rest.startsWith('--') || rest.startsWith('/*')) {
    if (rest.startsWith('--')) {
      const end = rest.indexOf('\n');
      rest = end === -1 ? '' : rest.slice(end + 1).trimStart();
    } else {
      const end = rest.indexOf('*/', 2);
      if (end === -1) return null;
      rest = rest.slice(end + 2).trimStart();
    }
  }
  return rest;
}

function ownershipViolations(
  steps: readonly SchemaStep[],
  exceptions = EXCEPTIONS,
  statementExceptions = STATEMENT_EXCEPTIONS,
): string[] {
  const errors: string[] = [];
  for (const exception of exceptions) {
    if (!exception.reason.trim())
      errors.push(`step ${exception.step}: ${exception.object} requires an exception reason`);
  }
  for (const exception of statementExceptions) {
    if (!exception.reason.trim()) errors.push(`step ${exception.step}: statement requires an exception reason`);
  }
  const createdBefore = new Set<string>();
  for (const step of [...steps].sort((a, b) => a.version - b.version)) {
    const statements = step.statements.map((sql) => withoutLeadingComments(sql));
    const declared = statements.flatMap((sql) => {
      const match = sql === null ? null : createTable.exec(sql);
      return match ? [name(match[1]!)] : [];
    });
    const tables = new Set(declared.filter((table) => !createdBefore.has(table)));
    for (const table of declared) createdBefore.add(table);
    if (step.version < 100) continue;
    const check = (object: string, table: string) => {
      if (
        !tables.has(table) &&
        !exceptions.some(
          (exception) =>
            exception.step === step.version &&
            exception.object === object &&
            exception.table === table &&
            exception.reason.trim(),
        )
      ) {
        errors.push(`step ${step.version}: ${object} targets existing table ${table}`);
      }
    };
    for (const [index, sql] of statements.entries()) {
      if (sql === `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '${step.version}')`) continue;
      if (
        statementExceptions.some(
          (exception) =>
            exception.step === step.version && exception.sql === step.statements[index] && exception.reason.trim(),
        )
      )
        continue;
      if (sql === null || (!createTable.test(sql) && !/^CREATE\s+(?:UNIQUE\s+)?(?:INDEX|TRIGGER)\b/i.test(sql))) {
        errors.push(`step ${step.version}: unclassifiable statement: ${sql}`);
        continue;
      }
      if (/^CREATE\s+(?:UNIQUE\s+)?(?:INDEX|TRIGGER)\b/i.test(sql)) {
        const match = createIndex.exec(sql) ?? createTrigger.exec(sql);
        if (!match) errors.push(`step ${step.version}: unrecognized index or trigger: ${sql}`);
        else check(name(match[1]!), name(match[2]!.split('.').at(-1)!.trim()));
      }
      if (/^CREATE\s+VIRTUAL\s+TABLE\b/i.test(sql) && /\bUSING\s+fts5\s*\(/i.test(sql)) {
        const table = createTable.exec(sql);
        const content = /\bcontent\s*=\s*(['"])(.*?)\1/i.exec(sql);
        if (/\bcontent\s*=/i.test(sql) && !content)
          errors.push(`step ${step.version}: unrecognized FTS content: ${sql}`);
        else if (content?.[2]) check(name(table![1]!), name(content[2]));
      }
    }
  }
  return errors;
}

it('schema steps from 100 index, trigger and search only tables they create', () => {
  expect(ownershipViolations(SCHEMA_STEPS)).toEqual([]);
});

it('ownership classifies every later statement after leading comments and rejects unresolved targets', () => {
  const index = 'CREATE INDEX idx_probe ON sessions (session_id)';
  for (const prefix of ['', '-- x\n', '/* x */', '\n -- x\n /* y */ -- z\n']) {
    expect(ownershipViolations([{ version: 101, statements: [prefix + index] }])).toHaveLength(1);
    expect(
      ownershipViolations([
        {
          version: 101,
          statements: [prefix + 'CREATE TABLE new_rows(id INTEGER)', prefix + 'CREATE INDEX idx_new ON new_rows(id)'],
        },
      ]),
    ).toEqual([]);
  }
  for (const sql of [
    'CREATE /* x */ INDEX idx_probe ON sessions(session_id)',
    'CREATE INDEX idx_probe ON main.sessions(session_id)',
    '/* unterminated',
    '-- comment only',
    'SELECT 1',
    'CREATE INDEX idx_probe ON',
  ]) {
    expect(ownershipViolations([{ version: 101, statements: [sql] }])).toHaveLength(1);
  }
});

it('ownership rejects index, trigger and FTS bypasses in later schema steps', () => {
  const create = 'CREATE TABLE IF NOT EXISTS new_rows (id INTEGER PRIMARY KEY)';
  const bypasses = [
    'CREATE INDEX IF NOT EXISTS idx_sessions_m1_probe ON sessions (project_id, ended_at, session_id)',
    'CREATE TRIGGER IF NOT EXISTS old_rows_ai AFTER INSERT ON sessions BEGIN SELECT 1; END',
    "CREATE VIRTUAL TABLE IF NOT EXISTS new_fts USING fts5(text,content='sessions')",
  ];
  for (const sql of bypasses)
    expect(ownershipViolations([{ version: 101, statements: [create, sql] }])).toHaveLength(1);
  expect(
    ownershipViolations([
      { version: 99, statements: ['CREATE TABLE IF NOT EXISTS sessions (session_id TEXT)'] },
      { version: 101, statements: ['CREATE TABLE IF NOT EXISTS sessions (session_id TEXT)', bypasses[0]!] },
    ]),
  ).toHaveLength(1);
  expect(
    ownershipViolations([
      {
        version: 101,
        statements: [
          create,
          'CREATE INDEX IF NOT EXISTS idx_new_rows ON new_rows (id)',
          'CREATE TRIGGER IF NOT EXISTS new_rows_ai AFTER INSERT ON new_rows BEGIN SELECT 1; END',
          "CREATE VIRTUAL TABLE IF NOT EXISTS new_fts USING fts5(text,content='new_rows')",
        ],
      },
    ]),
  ).toEqual([]);
});

it('existing-table exceptions name their step, object, table and reason', () => {
  const step = { version: 101, statements: ['CREATE INDEX IF NOT EXISTS idx_old ON sessions (session_id)'] };
  const exception = {
    step: 101,
    object: 'idx_old',
    table: 'sessions',
    reason: 'Explicitly admitted existing-table maintenance.',
  };
  expect(ownershipViolations([step], [exception])).toEqual([]);
  expect(ownershipViolations([step], [{ ...exception, reason: '' }])).toHaveLength(2);
  expect(ownershipViolations([{ ...step, version: 102 }], [exception])).toHaveLength(1);
});

it('maintenance statement exceptions pin the step, exact SQL and reason', () => {
  for (const exception of STATEMENT_EXCEPTIONS) {
    const step = { version: exception.step, statements: [exception.sql] };
    expect(ownershipViolations([step], [], [exception])).toEqual([]);
    expect(ownershipViolations([{ ...step, version: exception.step + 1 }], [], [exception])).toHaveLength(1);
    for (const sql of [exception.sql + ' ', ' ' + exception.sql, '-- x\n' + exception.sql, '/* x */' + exception.sql]) {
      expect(ownershipViolations([{ ...step, statements: [sql] }], [], [exception])).toHaveLength(1);
    }
    expect(ownershipViolations([step], [], [{ ...exception, reason: '' }])).toHaveLength(2);
  }
});

it('schema steps are contiguous from one through the server version and migration names match exactly', () => {
  expect(SCHEMA_STEPS.map((step) => step.version)).toEqual(
    Array.from({ length: SERVER_SCHEMA_VERSION }, (_, index) => index + 1),
  );
  expect(
    readdirSync('packages/myco-server/migrations')
      .filter((name) => name.endsWith('.sql'))
      .sort(),
  ).toEqual(SCHEMA_STEPS.map(migrationFileName));
});

/**
 * Each generator whose SQL runtime code shares, and the frozen step that holds what it emits: a change to the shared
 * SQL fails here instead of leaving the trigger behind the catch-up that repeats it.
 */
const triggerSql = (triggers: readonly { sql: string }[]) => triggers.map(trigger => trigger.sql);
const GENERATOR_PINS: readonly (readonly [step: number, generated: () => readonly string[]])[] = [
  [NEXT_S6, lineageHeadSchemaStatements],
  [NEXT_S6B + 4, authorityRetentionSchemaStatements],
  [NEXT_S1C, headSchemaStatements],
  [V711, () => triggerSql(kpiTriggers())],
  [V712, () => triggerSql(passedOverTriggers())],
  [V714, spendSchemaStatements],
  [V714, () => triggerSql(spendTriggers())],
  [V716, () => triggerSql(sourceStateTriggers())],
  [V717, publicationContributionSchema],
  [V719, liveSchemaStatements],
  [V719, () => triggerSql(liveTriggers())],
  [V721, planCountSchemaStatements],
  [V721, sporeCountSchemaStatements],
  [V722, () => triggerSql(calibrationTriggers())],
  [V723, publicationPinSchema],
  [V723, publicationFailureSchema],
  [V723, publicationRebuildSchema],
  [V724, workSchemaStatements],
  [V724, () => triggerSql(workTriggers())],
  [V727, storageUsageSchemaStatements],
  [SESSION_LIFECYCLE_STEPS[0]!.version, () => [SESSION_LIFECYCLE_EVENTS_INDEX]],
  [V730, sessionLifecycleSchema],
];

it('every generator the runtime keeps is still verbatim in its frozen step', () => {
  for (const [step, generated] of GENERATOR_PINS) {
    const frozen = SCHEMA_STEPS.find(candidate => candidate.version === step)?.statements ?? [];
    expect({ step, drifted: generated().filter(sql => !frozen.includes(sql)) }).toEqual({ step, drifted: [] });
  }
});
