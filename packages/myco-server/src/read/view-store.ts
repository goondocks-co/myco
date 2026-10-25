import { unreadPromptSql as extraction_coverage_unreadPromptSql } from '../db/session-read-model.js';
import type { RelationalStore as hook_placement_import_RelationalStore } from "../core/adapters.js";
import { subagentContextIdentities } from './hook-placement.js';
import { binaryOrder as hook_placement_import_binaryOrder } from "./scope.js";
import { keyset as hook_placement_import_keyset } from "./scope.js";
import { page as hook_placement_import_page } from "./scope.js";
import type { ReadScope as hook_placement_import_ReadScope } from "./scope.js";
import { registeredObjectKeySql as plans_import_registeredObjectKeySql } from "../core/blob-objects.js";
import { processedResourceProofSql as plans_import_processedResourceProofSql } from "../core/processed-resources.js";
import type { RelationalStore as plans_import_RelationalStore } from "../core/adapters.js";
import { PLAN_STATUSES as plans_import_PLAN_STATUSES } from "../ingest/kinds.js";
import { clampLimit as plans_import_clampLimit } from "./scope.js";
import { containsPattern as plans_import_containsPattern } from "./scope.js";
import { encodeCursor as plans_import_encodeCursor } from "./scope.js";
import { inListChunks as plans_import_inListChunks } from "./scope.js";
import { keyset as plans_import_keyset } from "./scope.js";
import { projectsDriving as plans_import_projectsDriving } from "./scope.js";
import { projectsFiltering as plans_import_projectsFiltering } from "./scope.js";
import type { Page as plans_import_Page } from "./scope.js";
import type { ProjectSet as plans_import_ProjectSet } from "./scope.js";
import type { ReadScope as plans_import_ReadScope } from "./scope.js";
import type { PreparedStatement as sessions_import_PreparedStatement } from "../core/adapters.js";
import type { RelationalStore as sessions_import_RelationalStore } from "../core/adapters.js";
import type { RunResult as sessions_import_RunResult } from "../core/adapters.js";
import { occurredAt as sessions_import_occurredAt } from "../db/session-dates.js";
import { presentedEndedAt as sessions_import_presentedEndedAt } from "../db/session-dates.js";
import { presentedStartedAt as sessions_import_presentedStartedAt } from "../db/session-dates.js";
import { containsPattern as sessions_import_containsPattern } from "./scope.js";
import { inListChunks as sessions_import_inListChunks } from "./scope.js";
import { keyset as sessions_import_keyset } from "./scope.js";
import { page as sessions_import_page } from "./scope.js";
import { projectsFiltering as sessions_import_projectsFiltering } from "./scope.js";
import type { Page as sessions_import_Page } from "./scope.js";
import type { ProjectSet as sessions_import_ProjectSet } from "./scope.js";
import type { ReadScope as sessions_import_ReadScope } from "./scope.js";
import { notTombstonedSql as sessions_import_notTombstonedSql } from "../core/tombstones.js";
import { NOT_TOMBSTONED_PARAMS as sessions_import_NOT_TOMBSTONED_PARAMS } from "../core/tombstones.js";
import { sessionMaterialReadySql as sessions_import_sessionMaterialReadySql } from "./material-readiness.js";
import { CAPTURE_RULE_BUNDLES as sessions_import_CAPTURE_RULE_BUNDLES } from "@goondocks/myco-shared/capture-rules-data";
import { sourceTimestampsRecorded as sessions_import_sourceTimestampsRecorded } from "@goondocks/myco-shared/capture-rules";
import type { RelationalStore as children_import_RelationalStore } from "../core/adapters.js";
import { assertSessionMaterialReady as children_import_assertSessionMaterialReady } from "./material-readiness.js";
import { sessionMaterialReadySql as children_import_sessionMaterialReadySql } from "./material-readiness.js";
import { titlingClaimAvailableSql as children_import_titlingClaimAvailableSql } from "./material-readiness.js";
import { notTombstonedSql as children_import_notTombstonedSql } from "../core/tombstones.js";
import { titleRunInFlightSql as children_import_titleRunInFlightSql } from "../db/session-read-model.js";
import { TITLING_MAX_ATTEMPTS as children_import_TITLING_MAX_ATTEMPTS } from "../constants.js";
import { TOOL_INPUT_PREVIEW_BYTES as children_import_TOOL_INPUT_PREVIEW_BYTES } from "../core/tool-input.js";
import { toolInputPreview as children_import_toolInputPreview } from "../core/tool-input.js";
import { containsPattern as children_import_containsPattern } from "./scope.js";
import { keyset as children_import_keyset } from "./scope.js";
import { page as children_import_page } from "./scope.js";
import type { Page as children_import_Page } from "./scope.js";
import type { ReadScope as children_import_ReadScope } from "./scope.js";
import type { RelationalStore as lineage_import_RelationalStore } from "../core/adapters.js";
import { notTombstonedSql as lineage_import_notTombstonedSql } from "../core/tombstones.js";
import { inListChunks as lineage_import_inListChunks } from "./scope.js";
import type { ReadScope as lineage_import_ReadScope } from "./scope.js";
import type { RelationalStore as activity_import_RelationalStore } from "../core/adapters.js";
import type { ReadScope as activity_import_ReadScope } from "./scope.js";
import { notTombstonedSql as activity_import_notTombstonedSql } from "../core/tombstones.js";
import type { ToolResultReason as session_activity_import_ToolResultReason } from "@goondocks/myco-shared/member-protocol";
import type { RelationalStore as session_activity_import_RelationalStore } from "../core/adapters.js";
import { notTombstonedSql as session_activity_import_notTombstonedSql } from "../core/tombstones.js";
import { occurredAt as session_activity_import_occurredAt } from "../db/session-dates.js";
import { binaryOrder as session_activity_import_binaryOrder } from "./scope.js";
import { keyset as session_activity_import_keyset } from "./scope.js";
import { page as session_activity_import_page } from "./scope.js";
import type { Page as session_activity_import_Page } from "./scope.js";
import type { ReadScope as session_activity_import_ReadScope } from "./scope.js";
import type { RelationalStore as injection_served_items_import_RelationalStore } from "../core/adapters.js";
import { inListChunks as injection_served_items_import_inListChunks } from "./scope.js";
import type { ReadScope as injection_served_items_import_ReadScope } from "./scope.js";
import type { ServerEnv as processed_import_ServerEnv } from "../core/adapters.js";
import { registeredObjectKeySql as processed_import_registeredObjectKeySql } from "../core/blob-objects.js";
import { PROCESSED_FIELDS as processed_import_PROCESSED_FIELDS } from "../core/processed-resources.js";
import { processedResourceProofSql as processed_import_processedResourceProofSql } from "../core/processed-resources.js";
import { utf8 as processed_import_utf8 } from "../hash.js";
import type { ReadScope as processed_import_ReadScope } from "./scope.js";
import { sourceTimestampsRecorded as turns_import_sourceTimestampsRecorded } from "@goondocks/myco-shared/capture-rules";
import { CAPTURE_RULE_BUNDLES as turns_import_CAPTURE_RULE_BUNDLES } from "@goondocks/myco-shared/capture-rules-data";
import type { RelationalStore as turns_import_RelationalStore } from "../core/adapters.js";
import { oneLine as turns_import_oneLine } from "../core/injection.js";
import type { PromptInjection as turns_import_PromptInjection } from "../core/injection.js";
import { listSporesByIds as turns_import_listSporesByIds } from "../core/spores.js";
import { MAX_SPORE_LIMIT as turns_import_MAX_SPORE_LIMIT } from "../core/spores.js";
import { PROMPT_ORIGINS as turns_import_PROMPT_ORIGINS } from "../ingest/kinds.js";
import { keyset as turns_import_keyset } from "./scope.js";
import { page as turns_import_page } from "./scope.js";
import type { Page as turns_import_Page } from "./scope.js";
import type { ReadScope as turns_import_ReadScope } from "./scope.js";
import type { RelationalStore as embedding_import_RelationalStore } from "../core/adapters.js";
import type { EmbeddingProvider as embedding_import_EmbeddingProvider } from "../core/embedding/provider.js";
import { VECTOR_QUERY_LIMIT as embedding_import_VECTOR_QUERY_LIMIT } from "../core/embedding/vectors.js";
import { VECTOR_TYPES as embedding_import_VECTOR_TYPES } from "../core/embedding/vectors.js";
import { vectorMatches as embedding_import_vectorMatches } from "../core/embedding/vectors.js";
import type { VectorFilters as embedding_import_VectorFilters } from "../core/embedding/vectors.js";
import type { VectorMetadata as embedding_import_VectorMetadata } from "../core/embedding/vectors.js";
import type { VectorStore as embedding_import_VectorStore } from "../core/embedding/vectors.js";
import type { VectorType as embedding_import_VectorType } from "../core/embedding/vectors.js";
import { inListChunks as embedding_import_inListChunks } from "./scope.js";
import type { ReadScope as embedding_import_ReadScope } from "./scope.js";
import { SEARCH_PREVIEW_CHARS as embedding_import_SEARCH_PREVIEW_CHARS } from "@goondocks/myco-shared/search-types";
import type { SearchOptions as embedding_import_SearchOptions } from "@goondocks/myco-shared/search-types";
import type { SearchResult as embedding_import_SearchResult } from "@goondocks/myco-shared/search-types";
import { notTombstonedSql as embedding_import_notTombstonedSql } from "../core/tombstones.js";
import { CURRENT_EMBEDDING_SOURCES as embedding_import_CURRENT_EMBEDDING_SOURCES } from "../db/embedding-sources.js";
import { EMBEDDING_RELEASE_COLUMNS as embedding_import_EMBEDDING_RELEASE_COLUMNS } from "../db/embedding-sources.js";
import { embeddingSourceSelect as embedding_import_embeddingSourceSelect } from "../db/embedding-sources.js";
import { settledAll as embedding_import_settledAll } from "../core/settled.js";
import { READ_ORIGINS as extraction_coverage_import_READ_ORIGINS } from "./extraction-origins.js";
import type { RelationalStore as extraction_coverage_import_RelationalStore } from "../core/adapters.js";
import type { ReadScope as extraction_coverage_import_ReadScope } from "./scope.js";
import type { RelationalStore as kpis_import_RelationalStore } from "../core/adapters.js";
import { CAPTURE_RULE_BUNDLES as kpis_import_CAPTURE_RULE_BUNDLES } from "@goondocks/myco-shared/capture-rules-data";
import { recallQuality as kpis_import_recallQuality } from "../evals/recall-baseline.js";
import { caseCount as kpis_import_caseCount } from "../evals/recall-baseline.js";
import type { RelationalStore as prompts_import_RelationalStore } from "../core/adapters.js";
import { READ_ORIGINS as prompts_import_READ_ORIGINS } from "./extraction-origins.js";
import { notTombstonedSql as prompts_import_notTombstonedSql } from "../core/tombstones.js";
import type { ReadScope as prompts_import_ReadScope } from "./scope.js";
import { displayPrompt as search_import_displayPrompt } from "@goondocks/myco-shared/prompt-text";
import { processedResourceProofSql as search_import_processedResourceProofSql } from "../core/processed-resources.js";
import type { RelationalStore as search_import_RelationalStore } from "../core/adapters.js";
import { occurredAt as search_import_occurredAt } from "../db/session-dates.js";
import { presentedStatus as search_import_presentedStatus } from "../db/session-dates.js";
import { SEARCH_QUERY_MAX_CHARS as search_import_SEARCH_QUERY_MAX_CHARS } from "../core/search-index.js";
import { projectsBoundOnce as search_import_projectsBoundOnce } from "./scope.js";
import type { ProjectSet as search_import_ProjectSet } from "./scope.js";
import type { ReadScope as search_import_ReadScope } from "./scope.js";
import { EmbeddingUnavailable as search_import_EmbeddingUnavailable } from "../core/embedding/provider.js";
import { notTombstonedSql as search_import_notTombstonedSql } from "../core/tombstones.js";
import { SEARCH_TYPES as search_import_SEARCH_TYPES } from "@goondocks/myco-shared/search-types";
import { SEARCH_API_LIMIT as search_import_SEARCH_API_LIMIT } from "@goondocks/myco-shared/search-types";
import { SEARCH_MAX_LIMIT as search_import_SEARCH_MAX_LIMIT } from "@goondocks/myco-shared/search-types";
import { SEARCH_PREVIEW_CHARS as search_import_SEARCH_PREVIEW_CHARS } from "@goondocks/myco-shared/search-types";
import type { SearchType as search_import_SearchType } from "@goondocks/myco-shared/search-types";
import type { SearchOptions as search_import_SearchOptions } from "@goondocks/myco-shared/search-types";
import type { SearchResult as search_import_SearchResult } from "@goondocks/myco-shared/search-types";
import type { SearchAnswer as search_import_SearchAnswer } from "@goondocks/myco-shared/search-types";
import type { SearchAcrossAnswer as search_import_SearchAcrossAnswer } from "@goondocks/myco-shared/search-types";
import type { SearchAcrossResult as search_import_SearchAcrossResult } from "@goondocks/myco-shared/search-types";
import type { ReleaseAnnotation as search_import_ReleaseAnnotation } from "@goondocks/myco-shared/search-types";
import type { SearchTurn as search_import_SearchTurn } from "@goondocks/myco-shared/search-types";
import { getReleaseStatesAcross as search_import_getReleaseStatesAcross } from "../core/provenance.js";
import { getReleaseStatesForRecords as search_import_getReleaseStatesForRecords } from "../core/provenance.js";
import { isReleaseNamespace as search_import_isReleaseNamespace } from "../core/provenance.js";
import type { ReleaseNamespace as search_import_ReleaseNamespace } from "../core/provenance.js";
import { CURRENT_EMBEDDING_SOURCES as core_embedding_source_state_import_CURRENT_EMBEDDING_SOURCES } from "../db/embedding-sources.js";
import { RECEIPT as core_embedding_source_state_import_RECEIPT } from "../core/embedding/receipt-state.js";
import type { RelationalStore as core_embedding_reconcile_import_RelationalStore } from "../core/adapters.js";
import { registeredObjectKeySql as core_embedding_reconcile_import_registeredObjectKeySql } from "../core/blob-objects.js";
import { RECEIPT as core_embedding_reconcile_import_RECEIPT } from "../core/embedding/receipt-state.js";
import { binaryOrder as core_embedding_selection_import_binaryOrder } from "./scope.js";
import type { RelationalStore as core_embedding_selection_import_RelationalStore } from "../core/adapters.js";
import { DELETION_RETRIES as core_embedding_selection_import_DELETION_RETRIES } from "../core/embedding/receipt-state.js";
import { RECEIPT as core_embedding_selection_import_RECEIPT } from "../core/embedding/receipt-state.js";
import type { VectorType as core_embedding_selection_import_VectorType } from "../core/embedding/vectors.js";
import type { RelationalStore as core_embedding_work_sweep_import_RelationalStore } from "../core/adapters.js";
import { VECTOR_LOST_MS as core_embedding_work_sweep_import_VECTOR_LOST_MS } from "../core/embedding/provider.js";
import { VECTOR_REWRITE_LIMIT as core_embedding_work_sweep_import_VECTOR_REWRITE_LIMIT } from "../core/embedding/provider.js";
import { HUBNESS_MEMBER as core_embedding_work_sweep_import_HUBNESS_MEMBER } from "../core/embedding/receipt-state.js";
import { RECEIPT as core_embedding_work_sweep_import_RECEIPT } from "../core/embedding/receipt-state.js";
import { deletionRetryDue as core_embedding_work_sweep_import_deletionRetryDue } from "../core/embedding/receipt-state.js";
import { WORK_SWEEP_PAGE as core_embedding_work_sweep_import_WORK_SWEEP_PAGE } from "../core/embedding/work-state.js";
import type { WorkSweep as core_embedding_work_sweep_import_WorkSweep } from "../core/embedding/work-state.js";
import { processedResourceProofSql as core_search_index_import_processedResourceProofSql } from "../core/processed-resources.js";
import { registeredObjectKeySql as core_search_index_import_registeredObjectKeySql } from "../core/blob-objects.js";
import type { RelationalStore as core_search_index_import_RelationalStore } from "../core/adapters.js";
import { projectsBoundOnce as core_search_index_import_projectsBoundOnce } from "./scope.js";
import type { ProjectSet as core_search_index_import_ProjectSet } from "./scope.js";
import type { RelationalStore as core_embedding_hubness_import_RelationalStore } from "../core/adapters.js";
import { VECTOR_LOST_MS as core_embedding_hubness_import_VECTOR_LOST_MS } from "../core/embedding/provider.js";
import { VECTOR_REWRITE_LIMIT as core_embedding_hubness_import_VECTOR_REWRITE_LIMIT } from "../core/embedding/provider.js";
import { HUBNESS_MEMBER as core_embedding_hubness_import_MEMBER } from "../core/embedding/receipt-state.js";
import { recordedWork as core_embedding_hubness_import_recordedWork } from "../core/embedding/work-state.js";
import { WORK_PREDICATE_VERSION as core_embedding_hubness_import_WORK_PREDICATE_VERSION } from "../core/embedding/work-state.js";
import type { PreparedStatement as core_embedding_switch_store_import_PreparedStatement } from "../core/adapters.js";
import type { RelationalStore as core_embedding_switch_store_import_RelationalStore } from "../core/adapters.js";
import { RECEIPT as core_embedding_switch_store_import_RECEIPT } from "../core/embedding/reconcile.js";
import type { EmbeddingSwitch } from '../core/embedding/switch-store.js';
import { EMBEDDING_SELECTION_LEAVES as switchSettingLeaves, type StoredEmbedding as SwitchSettings } from '../core/embedding/policy.js';
import { CLEANLINESS_SQL as releaseCleanliness } from '../core/provenance.js';

const VIEW_READ_OPERATION_IDS = [
  "M08:hook_placement_sessionContextHints:0",
  "M21:hook_placement_countUnplacedContextRecords:0",
  "N:plans_tagsOf:0",
  "N:plans_tagsAcross:0",
  "M24:plans_planTotals:0",
  "M24:plans_selectPlans:0",
  "N:sessions_listProjects:0",
  "M13:sessions_selectSessions:ordinary",
  "M14:sessions_selectSessions:receipt",
  "M14:sessions_selectSessions:working",
  "N:sessions_sessionDurationMs:0",
  "N:sessions_sessionLifecycle:0",
  "M15:sessions_countStatements:0",
  "M16:sessions_instantStatements:0",
  "M17:sessions_projectStats:0",
  "M17:sessions_projectStats:1",
  "N:sessions_projectExists:0",
  "N:sessions_existingProjects:0",
  "N:sessions_sessionInScope:0",
  "N:sessions_sessionHeldByMachine:0",
  "N:sessions_projectHoldsSession:0",
  "N:sessions_sessionCarriesTitle:0",
  "N:sessions_heldSessionIds:0",
  "N:sessions_sessionsOwnedByImporter:0",
  "M36:sessions_sessionsWithImportedPrompts:0",
  "M22:children_listReadyTitleSessions:0",
  "M22:children_candidatePage:0",
  "M22:children_countOwed:0",
  "M22:children_untitledReason:0",
  "M18:lineage_sessionsNamed:0",
  "M18:lineage_childIdsOf:0",
  "M19:activity_activityFeed:0",
  "M20:session_activity_listSessionActivity:0",
  "M20:session_activity_toolRows:0",
  "M20:session_activity_edgeRows:0",
  "M47:receiptPlans:0",
  "M29:embedding_semanticHits:0",
  "M40:extraction_coverage_hasAcknowledgedPrompts:0",
  "M42:kpis_countOf:0",
  "M42:kpis_deliveryMeasures:0",
  "M42:kpis_harnessSplit:0",
  "M42:kpis_harnessSplit:1",
  "M43:kpis_firstInjectionSamples:0",
  "M43:kpis_promptIdentityCounts:0",
  "M43:kpis_promptIdentityCounts:1",
  "M43:kpis_promptIdentityCounts:2",
  "M43:kpis_promptIdentityCounts:3",
  "M43:kpis_promptIdentityCounts:4",
  "M36:prompts_extractionSourceSession:0",
  "M25:search_searchType:0",
  "M08:hook_placement_listUnplacedHookRecords:0",
  "M09:plans_getPlan:0",
  "M10:plans_planInSession:0",
  "M12:sessions_getSession:0",
  "M11:sessions_sessionCounts:0",
  "M11:sessions_sessionCounts:1",
  "M04:children_listChildren:0",
  "M04:children_listChildrenByPrompt:0",
  "M23:children_materialRows:0",
  "M26:processed_processedField:0",
  "M01:turns_listTurns:0",
  "M02:turns_promptInSession:0",
  "M03:turns_readTurnBodies:0",
  "M05:turns_steeringChildPage:0",
  "M06:turns_toolUsage:0",
  "M07:turns_sessionTurnContexts:0",
  "M45:injectedPromptRecord:0",
  "M26:processedBundle:0",
  "M33:core_embedding_reconcile_passedOverSources:0",
  "M33:core_embedding_reconcile_passedOverSources:1",
  "M33:core_embedding_reconcile_embeddingFailureWakeAt:0",
  "M31:core_embedding_selection_retiringReceipt:0",
  "M31:core_embedding_selection_embeddingWakeAt:0",
  "M32:core_embedding_work_sweep_embeddingSweep:0",
  "M32:core_embedding_work_sweep_embeddingSweep:1",
  "M32:core_embedding_work_sweep_hubnessSweep:0",
  "M32:core_embedding_work_sweep_hubnessSweep:1",
  "M32:core_embedding_work_sweep_hubnessSweep:2",
  "M27:core_search_index_pendingSearchBlobs:0",
  "M27:core_search_index_searchBacklog:0",
  "M34:core_embedding_hubness_missingSporeVectors:0",
  "M34:core_embedding_hubness_recordedHubness:0",
  "M34:core_embedding_hubness_recordedHubness:1",
  "M35:core_embedding_switch_store_completionStatements:0",
  "M35:core_embedding_switch_store_switchProgress:0",
  "M35:core_embedding_switch_store_sourceTotals:0",
  "M35:core_embedding_switch_store_switchComplete:0",
  "M31:prepareEmbeddingUnwritten:0",
  "M31:prepareEmbeddingSelection:0",
  "M33:prepareEmbeddingSource:0",
  "M33:prepareEmbeddingReadyReceipt:0",
  "M28:prepareNextSearchBlob:0",
  "M34:prepareLeavingHubness:0",
  "M34:prepareJoiningHubness:0",
  "M34:prepareMissingHubness:0",
  "M34:prepareHubnessPublication:0",
  "M34:countCurrentSporeVectors:0",
  "M34:currentSporeVectorIds:0",
  "M35:prepareSwitchedSettings:0",
  "M35:prepareSwitchedSettings:1",
  "M35:prepareSwitchedSettings:2",
  "M46:prepareRestoredSessionUnread:0",
  "M40:prepareExtractionAckItem:0",
  "M40:prepareRecordAcknowledgement:0",
  "M44:prepareReleasePaths:0",
  "M44:prepareReleaseCandidates:0",
  "M44:prepareReleaseClassification:0",
  "M44:prepareReleaseClassification:1",
  "M44:prepareReleasePropagation:0"
] as const;

export const LEGACY_ONLY_OPERATIONS = [
  "M08:hook_placement_sessionContextHints:0",
  "M21:hook_placement_countUnplacedContextRecords:0",
  "M24:plans_planTotals:0",
  "M24:plans_selectPlans:0",
  "M13:sessions_selectSessions:ordinary",
  "M14:sessions_selectSessions:receipt",
  "M14:sessions_selectSessions:working",
  "M15:sessions_countStatements:0",
  "M16:sessions_instantStatements:0",
  "M17:sessions_projectStats:0",
  "M17:sessions_projectStats:1",
  "M36:sessions_sessionsWithImportedPrompts:0",
  "M22:children_listReadyTitleSessions:0",
  "M22:children_candidatePage:0",
  "M22:children_countOwed:0",
  "M22:children_untitledReason:0",
  "M18:lineage_sessionsNamed:0",
  "M18:lineage_childIdsOf:0",
  "M19:activity_activityFeed:0",
  "M20:session_activity_listSessionActivity:0",
  "M20:session_activity_toolRows:0",
  "M20:session_activity_edgeRows:0",
  "M47:receiptPlans:0",
  "M29:embedding_semanticHits:0",
  "M40:extraction_coverage_hasAcknowledgedPrompts:0",
  "M42:kpis_countOf:0",
  "M42:kpis_deliveryMeasures:0",
  "M42:kpis_harnessSplit:0",
  "M42:kpis_harnessSplit:1",
  "M43:kpis_firstInjectionSamples:0",
  "M43:kpis_promptIdentityCounts:0",
  "M43:kpis_promptIdentityCounts:1",
  "M43:kpis_promptIdentityCounts:2",
  "M43:kpis_promptIdentityCounts:3",
  "M43:kpis_promptIdentityCounts:4",
  "M36:prompts_extractionSourceSession:0",
  "M25:search_searchType:0",
  "M08:hook_placement_listUnplacedHookRecords:0",
  "M09:plans_getPlan:0",
  "M10:plans_planInSession:0",
  "M12:sessions_getSession:0",
  "M11:sessions_sessionCounts:0",
  "M11:sessions_sessionCounts:1",
  "M04:children_listChildren:0",
  "M04:children_listChildrenByPrompt:0",
  "M23:children_materialRows:0",
  "M26:processed_processedField:0",
  "M01:turns_listTurns:0",
  "M02:turns_promptInSession:0",
  "M03:turns_readTurnBodies:0",
  "M05:turns_steeringChildPage:0",
  "M06:turns_toolUsage:0",
  "M07:turns_sessionTurnContexts:0",
  "M45:injectedPromptRecord:0",
  "M26:processedBundle:0",
  "M33:core_embedding_reconcile_passedOverSources:0",
  "M33:core_embedding_reconcile_passedOverSources:1",
  "M33:core_embedding_reconcile_embeddingFailureWakeAt:0",
  "M31:core_embedding_selection_retiringReceipt:0",
  "M31:core_embedding_selection_embeddingWakeAt:0",
  "M32:core_embedding_work_sweep_embeddingSweep:0",
  "M32:core_embedding_work_sweep_embeddingSweep:1",
  "M32:core_embedding_work_sweep_hubnessSweep:0",
  "M32:core_embedding_work_sweep_hubnessSweep:1",
  "M32:core_embedding_work_sweep_hubnessSweep:2",
  "M27:core_search_index_pendingSearchBlobs:0",
  "M27:core_search_index_searchBacklog:0",
  "M34:core_embedding_hubness_missingSporeVectors:0",
  "M34:core_embedding_hubness_recordedHubness:0",
  "M34:core_embedding_hubness_recordedHubness:1",
  "M35:core_embedding_switch_store_completionStatements:0",
  "M35:core_embedding_switch_store_switchProgress:0",
  "M35:core_embedding_switch_store_sourceTotals:0",
  "M35:core_embedding_switch_store_switchComplete:0",
  "M31:prepareEmbeddingUnwritten:0",
  "M31:prepareEmbeddingSelection:0",
  "M33:prepareEmbeddingSource:0",
  "M33:prepareEmbeddingReadyReceipt:0",
  "M28:prepareNextSearchBlob:0",
  "M34:prepareLeavingHubness:0",
  "M34:prepareJoiningHubness:0",
  "M34:prepareMissingHubness:0",
  "M34:prepareHubnessPublication:0",
  "M34:countCurrentSporeVectors:0",
  "M34:currentSporeVectorIds:0",
  "M35:prepareSwitchedSettings:0",
  "M35:prepareSwitchedSettings:1",
  "M35:prepareSwitchedSettings:2",
  "M46:prepareRestoredSessionUnread:0",
  "M40:prepareExtractionAckItem:0",
  "M40:prepareRecordAcknowledgement:0",
  "M44:prepareReleasePaths:0",
  "M44:prepareReleaseCandidates:0",
  "M44:prepareReleaseClassification:0",
  "M44:prepareReleaseClassification:1",
  "M44:prepareReleasePropagation:0"
] as const;

interface hook_placement_HookHintSql { project: string; session: string; prompt: string }

/** A hint places a record only in its own Project and session's prompt set. */
function hook_placement_hookPlacementSql(hint: hook_placement_HookHintSql): string {
  return `EXISTS (SELECT 1 FROM prompt_batches hook_prompt WHERE hook_prompt.project_id = ${hint.project}
    AND hook_prompt.session_id = ${hint.session} AND hook_prompt.prompt_id = ${hint.prompt})`;
}

function hook_placement_placedHintSql(hint: hook_placement_HookHintSql): string {
  return `CASE WHEN ${hook_placement_hookPlacementSql(hint)} THEN ${hint.prompt} ELSE NULL END`;
}

const hook_placement_DELIVERY_RECORD_SOURCES = [
  { table: 'spore_injections', kind: 'receipt', id: 'id', hint: 'r.delivered_prompt_id', label: "'Context received'", where: 'delivered_at IS NOT NULL' },
  {
    table: 'prompt_context_answers', kind: 'answer', id: 'id', hint: 'r.delivered_prompt_id', label: "'Context received'", where: `outcome = 'served' AND delivered_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM spore_injections receipt WHERE receipt.project_id = r.project_id AND receipt.session_id = r.session_id AND receipt.id = r.receipt_id)
    AND NOT ${hook_placement_hookPlacementSql({ project: 'r.project_id', session: 'r.session_id', prompt: 'r.prompt_id' })}`
  },
] as const;

/** The placement hint for each hook record class. Selection remains diagnostic. */
const hook_placement_HOOK_RECORD_SOURCES = [
  ...hook_placement_DELIVERY_RECORD_SOURCES,
  { table: 'session_injections', kind: 'session_context', id: 'kind', hint: 'r.placement_hint', label: "CASE WHEN kind = 'plan-nudge' THEN 'Plan reminder' ELSE 'Context for a sub-agent' END", where: '1 = 1' },
  { table: 'tool_calls', kind: 'tool_call', id: 'tool_call_id', hint: 'r.prompt_id', label: 'tool_name', where: '1 = 1' },
  { table: 'attachments', kind: 'attachment', id: 'attachment_id', hint: 'r.prompt_id', label: "COALESCE(description, 'Attachment')", where: '1 = 1' },
  { table: 'events', index: 'idx_events_subagent_start', kind: 'event', id: 'event_id', hint: "json_extract(payload, '$.parentPromptId')", label: "'Sub-agent started'", where: "kind = 'subagent.start'" },
  { table: 'events', kind: 'event', id: 'event_id', hint: "CASE WHEN kind = 'turn' THEN json_extract(payload, '$.promptId') ELSE json_extract(payload, '$.parentPromptId') END", label: "CASE kind WHEN 'turn' THEN 'Turn ' || COALESCE(json_extract(payload, '$.phase'), '') ELSE 'Sub-agent stopped' END", where: "kind IN ('turn', 'subagent.stop')" },
] as const;

function hook_placement_unplacedSourceSql(source: typeof hook_placement_HOOK_RECORD_SOURCES[number], relation: string = source.table): string {
  const table = `${relation} r${'index' in source ? ` INDEXED BY ${source.index}` : ''}`;
  return `SELECT project_id, session_id, '${source.kind}:' || ${source.id} AS record_key,
    '${source.kind}' AS record_kind, ${source.id} AS record_id, ${source.hint} AS prompt_hint,
    ${source.label} AS label, created_at FROM ${table}
    WHERE ${source.where}
      AND NOT ${hook_placement_hookPlacementSql({ project: 'r.project_id', session: 'r.session_id', prompt: source.hint })}`;
}

/** Sub-agent context carries the canonical agent identity and its start event's parent hint. */
async function hook_placement_sessionContextHints(db: hook_placement_import_RelationalStore, scope?: hook_placement_import_ReadScope, sessionId?: string) {
  const conditions = ['r.project_id = pr.project_id'];
  const params: unknown[] = [];
  if (scope !== undefined) { conditions.push('r.project_id = ?'); params.push(scope.projectId); }
  if (sessionId !== undefined) { conditions.push('r.session_id = ?'); params.push(sessionId); }
  const records = { sql: `SELECT r.* FROM projects pr CROSS JOIN session_injections r WHERE ${conditions.join(' AND ')}`, params };
  const { results } = await prepareViewRead(db, "M08:hook_placement_sessionContextHints:0", `SELECT r.project_id, r.session_id, r.kind FROM (${records.sql}) r
    WHERE r.kind >= 'cortex:' AND r.kind < 'cortex;'`).bind(...records.params).all<{ project_id: string; session_id: string; kind: string }>();
  const identities = await subagentContextIdentities(results);
  return {
    sql: `SELECT si.*, (SELECT MAX(json_extract(e.payload, '$.parentPromptId')) FROM events e INDEXED BY idx_events_subagent_start
      WHERE e.project_id = si.project_id AND e.session_id = si.session_id AND e.kind = 'subagent.start'
        AND json_extract(e.payload, '$.subagentId') = json_extract(agent.value, '$.subagent_id')
      HAVING COUNT(DISTINCT json_extract(e.payload, '$.parentPromptId')) = 1
        AND COUNT(*) = COUNT(json_extract(e.payload, '$.parentPromptId'))) AS placement_hint
      FROM json_each(?) agent CROSS JOIN session_injections si
      WHERE si.project_id = json_extract(agent.value, '$.project_id') AND si.session_id = json_extract(agent.value, '$.session_id')
        AND si.kind = json_extract(agent.value, '$.kind')
      UNION ALL SELECT si.*, si.delivered_prompt_id AS placement_hint FROM (${records.sql}) si
      WHERE si.kind = 'plan-nudge' AND si.delivered_at IS NOT NULL`,
    params: [JSON.stringify(identities), ...records.params],
  };
}

interface hook_placement_UnplacedHookRecord {
  key: string; kind: string; id: string; promptHint: string | null; label: string; createdAt: number;
}

const hook_placement_HOOK_STATUS_WINDOW_DAYS = 7;
const hook_placement_HOOK_STATUS_WINDOW_MS = hook_placement_HOOK_STATUS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** The status window counts delivered receipts and served answers, excluding tombstoned sessions. */
async function hook_placement_countUnplacedContextRecords(db: hook_placement_import_RelationalStore, scope?: hook_placement_import_ReadScope, sessionId?: string, now = Date.now()): Promise<number> {
  const from = now - hook_placement_HOOK_STATUS_WINDOW_MS;
  const conditions = ['r.project_id = s.project_id', 'r.created_at >= ?', 'NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = r.project_id AND t.session_id = r.session_id)'];
  const params: unknown[] = [from];
  if (scope !== undefined) { conditions.push('r.project_id = ?'); params.push(scope.projectId); }
  if (sessionId !== undefined) { conditions.push('r.session_id = ?'); params.push(sessionId); }
  const counts = await Promise.all(hook_placement_DELIVERY_RECORD_SOURCES.map(source => {
    return prepareViewRead(db, "M21:hook_placement_countUnplacedContextRecords:0", `SELECT COUNT(*) AS n FROM projects s CROSS JOIN (${hook_placement_unplacedSourceSql(source)}) r
      WHERE ${conditions.join(' AND ')}`)
      .bind(...params).first<{ n: number }>();
  }));
  return counts.reduce((sum, row) => sum + (row?.n ?? 0), 0);
}

/** A plan as the project holds it: the projected row plus the tags the same event carried. `promptId` names the prompt the plan came from; `updatedBy` the member behind its last administrative edit, null when a capture event wrote last. */
interface plans_ProjectPlanRow {
  planKey: string;
  sessionId: string;
  promptId: string | null;
  title: string | null;
  status: string;
  content: string | null;
  blobKey: string | null;
  /** The registered object admitted by this plan's processed-field provenance, or null. */
  objectKey: string | null;
  originPath: string | null;
  /** `checked/total` over the plan's task list, or `N/A` when it has none. */
  progress: string;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

/** The statuses an administrative edit may write — the catalogue's; the list filter alone admits 'all'. */
const plans_WRITABLE_PLAN_STATUSES: ReadonlySet<string> = new Set(plans_import_PLAN_STATUSES);
const plans_PLAN_STATUS_MESSAGE = `status must be one of: ${plans_import_PLAN_STATUSES.join(', ')}`;

/** `checked/total` over the plan's task list, or `N/A` when it has none; a spilled plan reads as none. */
function plans_progressOf(content: string | null): string {
  const text = content ?? '';
  const checked = (text.match(/- \[x\]/gi) ?? []).length;
  const unchecked = (text.match(/- \[ \]/g) ?? []).length;
  const total = checked + unchecked;
  return total === 0 ? 'N/A' : `${checked}/${total}`;
}

const plans_COLUMNS = `plan_key, session_id, prompt_id, title, status, content, blob_key,
  CASE WHEN ${plans_import_processedResourceProofSql('plans.project_id', 'plan', 'plans.plan_key', 'plans.blob_key')}
    THEN ${plans_import_registeredObjectKeySql('plans.project_id', 'plans.blob_key')} END AS object_key,
  origin_path, updated_by, created_at, updated_at`;

function plans_toPlan(row: Record<string, unknown>, tags: string[]): plans_ProjectPlanRow {
  return {
    planKey: row.plan_key as string,
    sessionId: row.session_id as string,
    promptId: (row.prompt_id as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    status: row.status as string,
    content: (row.content as string | null) ?? null,
    blobKey: (row.blob_key as string | null) ?? null,
    objectKey: (row.object_key as string | null) ?? null,
    originPath: (row.origin_path as string | null) ?? null,
    progress: plans_progressOf((row.content as string | null) ?? null),
    updatedBy: (row.updated_by as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    tags,
  };
}

/** The tags of each named plan, keyed by plan key; a plan with none maps to an empty list. */
async function plans_tagsOf(db: plans_import_RelationalStore, scope: plans_import_ReadScope, planKeys: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(planKeys.map((k) => [k, []]));
  // A page of plans names more keys than one statement may bind, so the keys are read in runs.
  for (const run of plans_import_inListChunks(planKeys)) {
    const { results } = await prepareViewRead(db, "N:plans_tagsOf:0", `SELECT entity_id, tag FROM tags WHERE project_id = ? AND entity_kind = 'plan' AND entity_id IN (${run.map(() => '?').join(', ')}) ORDER BY entity_id, tag`)
      .bind(scope.projectId, ...run)
      .all<{ entity_id: string; tag: string }>();
    for (const r of results) out.get(r.entity_id)?.push(r.tag);
  }
  return out;
}

/** The tags of each named plan of each Project, keyed by Project and then plan key, every statement in one batch. */
async function plans_tagsAcross(db: plans_import_RelationalStore, keysByProject: ReadonlyMap<string, readonly string[]>): Promise<Map<string, Map<string, string[]>>> {
  const out = new Map<string, Map<string, string[]>>();
  const reads: { projectId: string; statement: ReturnType<plans_import_RelationalStore['prepare']> }[] = [];
  for (const [projectId, keys] of keysByProject) {
    out.set(projectId, new Map(keys.map((k) => [k, []])));
    for (const run of plans_import_inListChunks(keys)) {
      reads.push({
        projectId, statement: prepareViewRead(db, "N:plans_tagsAcross:0", `SELECT entity_id, tag FROM tags WHERE project_id = ? AND entity_kind = 'plan' AND entity_id IN (${run.map(() => '?').join(', ')}) ORDER BY entity_id, tag`)
          .bind(projectId, ...run)
      });
    }
  }
  if (reads.length === 0) return out;
  const results = await db.batch(reads.map((r) => r.statement));
  results.forEach((result, i) => {
    const held = out.get(reads[i]!.projectId)!;
    for (const r of result.results as { entity_id: string; tag: string }[]) held.get(r.entity_id)?.push(r.tag);
  });
  return out;
}

/** The project's plans, most recently updated first; optionally one status or one session. */
async function plans_listProjectPlans(
  db: plans_import_RelationalStore,
  scope: plans_import_ReadScope,
  opts: { status?: string; sessionId?: string; limit?: number } = {},
): Promise<plans_ProjectPlanRow[]> {
  return [...(await plans_pageProjectPlans(db, scope, opts)).rows];
}

/**
 * One page of the project's plans, most recently updated first, and the cursor of the next. A plan edited while a
 * reader pages moves to the head of the list, which that reader already holds; a refresh reads it there.
 */
async function plans_pageProjectPlans(
  db: plans_import_RelationalStore,
  scope: plans_import_ReadScope,
  opts: { status?: string; sessionId?: string; limit?: number; cursor?: string } = {},
): Promise<plans_import_Page<plans_ProjectPlanRow>> {
  const listed = await plans_selectPlans(db, { sql: 'project_id = ?', params: [scope.projectId] }, opts);
  return { cursor: listed.cursor, rows: listed.rows.map(({ projectId: _projectId, ...row }) => row) };
}

/** A plan of a read across Projects, with the Project it belongs to. */
type plans_PlanAcrossRow = plans_ProjectPlanRow & { projectId: string };

/** One page of every plan in the set's Projects, most recently updated first, optionally only plans updated at or after a start instant. */
async function plans_pagePlansAcross(
  db: plans_import_RelationalStore,
  set: plans_import_ProjectSet,
  opts: { status?: string; since?: number; q?: string; limit?: number; cursor?: string } = {},
): Promise<plans_import_Page<plans_PlanAcrossRow>> {
  return plans_selectPlans(db, plans_import_projectsFiltering(set, 'plans'), opts, 'idx_plans_updated_deployment');
}

/**
 * The plans a text matches: its title or its body as the Deployment holds it inline, with `%` and `_` read as text.
 * Case is folded for ASCII letters only: `é` does not match `É`. A body spilled to a blob is matched by
 * `/api/search`, not here.
 */
function plans_planText(q: string | undefined): { sql: string; params: string[] } | null {
  if (q === undefined || q.trim() === '') return null;
  const pattern = plans_import_containsPattern(q.trim());
  return { sql: `(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`, params: [pattern, pattern] };
}

/**
 * How many plans of each status the set holds under the other filters: a start instant and a text. Read through each
 * Project's own plans, one statement. A status no plan holds is absent. The totals and the page are two statements, so
 * a plan written between them can leave a total one off the page it sits beside.
 */
async function plans_planTotals(db: plans_import_RelationalStore, set: plans_import_ProjectSet, opts: { since?: number; q?: string } = {}): Promise<Record<string, number>> {
  const projects = plans_import_projectsDriving(set, 'project_id');
  const conditions = [projects.sql];
  const params: unknown[] = [...projects.params];
  if (opts.since !== undefined) { conditions.push('updated_at >= ?'); params.push(opts.since); }
  const text = plans_planText(opts.q);
  if (text !== null) { conditions.push(text.sql); params.push(...text.params); }
  const { results } = await prepareViewRead(db, "M24:plans_planTotals:0", `SELECT status, COUNT(*) AS n FROM plans WHERE ${conditions.join(' AND ')} GROUP BY status`)
    .bind(...params).all<{ status: string; n: number }>();
  return Object.fromEntries(results.map((r) => [r.status, Number(r.n)]));
}

/**
 * One plan page over the rows `projects` admits. A read that walks a Deployment-wide index (`walks`, named in the
 * statement) also takes the cursor's instant as an upper bound beside the keyset predicate, which the predicate
 * already implies, so the walk seeks to the cursor.
 */
async function plans_selectPlans(
  db: plans_import_RelationalStore,
  projects: { sql: string; params: readonly unknown[] },
  opts: { status?: string; sessionId?: string; since?: number; q?: string; limit?: number; cursor?: string },
  walks = '',
): Promise<plans_import_Page<plans_PlanAcrossRow>> {
  const k = plans_import_keyset({ limit: plans_import_clampLimit(opts.limit), cursor: opts.cursor }, { order: 'updated_at', id: 'plan_key', direction: 'DESC' });
  if (k === null) return { rows: [], cursor: null };
  const conditions = [projects.sql];
  const params: unknown[] = [...projects.params];
  if (opts.status !== undefined) { conditions.push('status = ?'); params.push(opts.status); }
  if (opts.sessionId !== undefined) { conditions.push('session_id = ?'); params.push(opts.sessionId); }
  if (opts.since !== undefined) { conditions.push('updated_at >= ?'); params.push(opts.since); }
  const text = plans_planText(opts.q);
  if (text !== null) { conditions.push(text.sql); params.push(...text.params); }
  if (k.where !== '') {
    if (walks !== '') { conditions.push('updated_at <= ?'); params.push(k.params[0]); }
    conditions.push(k.where); params.push(...k.params);
  }
  const { results } = await prepareViewRead(db, "M24:plans_selectPlans:0", `SELECT project_id, ${plans_COLUMNS} FROM plans${walks === '' ? '' : ` INDEXED BY ${walks}`} WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, plan_key DESC LIMIT ?`)
    .bind(...params, k.limit + 1)
    .all<Record<string, unknown>>();
  const shown = results.slice(0, k.limit);
  // Tags are keyed by Project first, so they are read per Project over its keys on the page, in one batch.
  const keysByProject = new Map<string, string[]>();
  for (const r of shown) keysByProject.set(r.project_id as string, [...(keysByProject.get(r.project_id as string) ?? []), r.plan_key as string]);
  const tags = await plans_tagsAcross(db, keysByProject);
  const rows = shown.map((r) => ({ ...plans_toPlan(r, tags.get(r.project_id as string)?.get(r.plan_key as string) ?? []), projectId: r.project_id as string }));
  const last = rows[rows.length - 1];
  return { rows, cursor: results.length > k.limit && last !== undefined ? plans_import_encodeCursor(last.updatedAt, last.planKey) : null };
}

/** A plan's bounded metadata, including the content revision and source session. */
type plans_ProjectPlanSummary = Pick<plans_ProjectPlanRow, 'planKey' | 'title' | 'status' | 'sessionId'> & { contentHash: string | null };

interface sessions_ProjectRow {
  projectId: string;
  name: string;
  createdAt: number;
  sessionCount: number;
  lastActivityAt: number | null;
  /** The archive time and who archived it; null while the project accepts capture. */
  archivedAt: number | null;
  archivedBy: string | null;
}

/** A session and the facts that identify the run that produced it. `agent`, `branch`, `originPath` and `parentSessionId` are what separate a sandboxed headless run from a laptop run; a view without them cannot show which is which. */
interface sessions_SessionRow {
  sessionId: string;
  machineId: string | null;
  createdByTokenId: string;
  firstReceivedAt: number;
  lastReceivedAt: number;
  agent: string | null;
  branch: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** The member whose End session applied the standing end; null for an end an agent's hook or an import applied. */
  endedBy: string | null;
  endedByLabel: string | null;
  originPath: string | null;
  /** The session this one continues under a new id, and the continuation's recorded reason. */
  parentSessionId: string | null;
  parentReason: string | null;
  /** The session that launched this one, as the launcher named it; it may name a session this Project does not hold. */
  launchParentSessionId: string | null;
  /** The member and runtime behind the credential that captured the session; null when the credential row is gone. */
  memberId: string | null;
  memberLabel: string | null;
  /**
   * The name of the machine the session came from. A read leaves it null: a facade names the viewer's own machines
   * with `nameOwnMachines`, and anyone else's machine is shown as its member, never by name.
   */
  runtimeLabel: string | null;
  runtimeKind: string | null;
  /**
   * When the session's open turn started, in the member's clock; null while no turn is open, and when the recorded end
   * is newer than the turn. A turn newer than the recorded end is a session resumed after it: working again, with its
   * recorded end left as it stands.
   */
  workingSince: number | null;
  /**
   * Whether the session is working now: a turn open for less than `WORKING_CAP_MS`, however long it has gone without
   * sending anything. False for a read given no instant to judge by.
   */
  working: boolean;
  /** The title written on the Deployment after the session ended; null until then. */
  title: string | null;
  summary: string | null;
  /** The time of the titling attempt, whatever its outcome; null while nothing has tried. */
  titledAt: number | null;
  /** What a list or a header shows: the title, else the opening line of the first user prompt, else the agent, else the id. */
  label: string;
}

/** What a project holds, counted for its home page. */
interface sessions_ProjectStats {
  sessions: number;
  /** Sessions with no end recorded. A runtime that died never ends its session, so this is what the data says, not a liveness claim. */
  openSessions: number;
  sessionsLast7d: number;
  prompts: number;
  toolCalls: number;
  plans: number;
  attachments: number;
  lastActivityAt: number | null;
}

/** Counts of a session's child projections, for a detail view that shows what it holds before fetching any of it. */
interface sessions_SessionCounts {
  prompts: number;
  toolCalls: number;
  responses: number;
  plans: number;
  attachments: number;
}

/** How much of the first prompt the label rule reads. */
const sessions_FIRST_PROMPT_CHARS = 160;
/** The longest label the fallback rule produces. */
const sessions_LABEL_MAX_CHARS = 80;

/** The opening of a session's first inline user prompt, for the label of a session with no title. Correlated on the sessions alias `alias`; `idx_prompt_batches_first` serves the whole order, so it stops at the first row, and a spilled prompt (no inline text) is skipped. */
const sessions_firstPromptSql = (alias: string): string => `(SELECT substr(pb.text, 1, ${sessions_FIRST_PROMPT_CHARS}) FROM prompt_batches pb
       WHERE pb.project_id = ${alias}.project_id AND pb.session_id = ${alias}.session_id AND pb.origin = 'user' AND pb.text IS NOT NULL
       ORDER BY pb.created_at, pb.prompt_id LIMIT 1)`;
const sessions_FIRST_PROMPT_SQL = sessions_firstPromptSql('s');

/** What a label shows for a session with no title, typed prompt or agent, where an id fragment must never reach the reader. */
const sessions_UNTITLED_SESSION_LABEL = 'Untitled session';

/** The one label rule for a session's words: a stored title as is; else the first prompt's first line, whitespace collapsed, cut at `LABEL_MAX_CHARS` on a word boundary; else the agent; else null. */
function sessions_namedLabel(title: string | null, firstPrompt: string | null, agent: string | null): string | null {
  if (title !== null && title.trim() !== '') return title.trim();
  const line = firstPrompt === null ? '' : (firstPrompt.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').replace(/\s+/g, ' ').trim();
  if (line !== '') {
    if (line.length <= sessions_LABEL_MAX_CHARS) return line;
    const cut = line.slice(0, sessions_LABEL_MAX_CHARS);
    const boundary = line[sessions_LABEL_MAX_CHARS] === ' ' ? sessions_LABEL_MAX_CHARS : cut.lastIndexOf(' ');
    return `${(boundary > sessions_LABEL_MAX_CHARS / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
  }
  if (agent !== null && agent.trim() !== '') return agent.trim();
  return null;
}

/** The label the list, the detail and the activity feed share: the words of `namedLabel`, then the id's first eight characters. */
function sessions_sessionLabel(title: string | null, firstPrompt: string | null, agent: string | null, sessionId: string): string {
  return sessions_namedLabel(title, firstPrompt, agent) ?? sessionId.slice(0, 8);
}

/** The same words for a surface that names related sessions, which falls back to `UNTITLED_SESSION_LABEL` and never to the id. */
function sessions_relatedSessionLabel(title: string | null, firstPrompt: string | null, agent: string | null): string {
  return sessions_namedLabel(title, firstPrompt, agent) ?? sessions_UNTITLED_SESSION_LABEL;
}

/** Presented conversation dates fall back to raw lifecycle dates. */
const sessions_PRESENTED_STARTED_AT = sessions_import_presentedStartedAt('s.');
const sessions_PRESENTED_ENDED_AT = sessions_import_presentedEndedAt('s.');

/** All joins land on primary keys, preserving the session row count. */
const sessions_SESSION_COLUMNS = `s.session_id, s.machine_id, s.created_by_token_id, s.first_received_at, s.last_received_at,
     s.agent, s.branch, ${sessions_PRESENTED_STARTED_AT} AS started_at, ${sessions_PRESENTED_ENDED_AT} AS ended_at, s.origin_path, s.parent_session_id, s.parent_reason, s.launch_parent_session_id,
     s.title, s.summary, s.titled_at, s.ended_by, ${sessions_FIRST_PROMPT_SQL} AS first_prompt,
     c.member_id, c.runtime_kind, m.label AS member_label, e.label AS ended_by_label, s.working_since`;
const sessions_SESSION_FROM = sessions_sessionFrom('');
/** The session read's joins, with the sessions table read through `indexedBy` where one is named. */
function sessions_sessionFrom(indexedBy: string): string {
  return `FROM sessions s${indexedBy === '' ? '' : ` INDEXED BY ${indexedBy}`}
     LEFT JOIN member_credentials c ON c.id = s.created_by_token_id
     LEFT JOIN members m ON m.id = c.member_id
     LEFT JOIN members e ON e.id = s.ended_by`;
}
/** The Deployment-wide order every read of sessions across Projects walks. */
const sessions_SESSIONS_ACROSS_INDEX = 'idx_sessions_occurred_deployment';
/**
 * The index an activity window reads: it leads with the last receipt, so the read seeks the sessions received from
 * the window's start on, however long ago they started, and sorts that set alone.
 */
const sessions_SESSIONS_ACTIVE_INDEX = 'idx_sessions_capture';
/** The index the sessions working now are read through: it holds the sessions with an open turn alone. */
const sessions_SESSIONS_WORKING_INDEX = 'idx_sessions_working';
/**
 * How long a turn may stay open and still read as working. A turn ends when its end reaches the Deployment; this
 * bounds only a turn whose end never does (a crash, an interrupt no hook reports), which reads as working no longer.
 */
const sessions_WORKING_CAP_MS = 3 * 60 * 60 * 1000;
/** A deleted session is absent from session reads, project counts, and latest activity. */
const sessions_LIVE_SESSION = sessions_import_notTombstonedSql('s');
const sessions_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const sessions_text = (value: unknown): string | null => (value as string | null) ?? null;
const sessions_num = (value: unknown): number | null => (value as number | null) ?? null;

function sessions_toSession(row: Record<string, unknown>, nowMs?: number): sessions_SessionRow {
  const open = sessions_num(row.working_since);
  const workingSince = open !== null && (row.ended_at == null || open > (row.ended_at as number)) ? open : null;
  return {
    sessionId: row.session_id as string,
    machineId: sessions_text(row.machine_id),
    createdByTokenId: row.created_by_token_id as string,
    firstReceivedAt: row.first_received_at as number,
    lastReceivedAt: row.last_received_at as number,
    agent: sessions_text(row.agent),
    branch: sessions_text(row.branch),
    startedAt: sessions_num(row.started_at),
    endedAt: sessions_num(row.ended_at),
    endedBy: sessions_text(row.ended_by),
    endedByLabel: sessions_text(row.ended_by_label),
    originPath: sessions_text(row.origin_path),
    parentSessionId: sessions_text(row.parent_session_id),
    parentReason: sessions_text(row.parent_reason),
    launchParentSessionId: sessions_text(row.launch_parent_session_id),
    memberId: sessions_text(row.member_id),
    memberLabel: sessions_text(row.member_label),
    runtimeLabel: null,
    workingSince,
    working: nowMs !== undefined && workingSince !== null && workingSince > nowMs - sessions_WORKING_CAP_MS,
    runtimeKind: sessions_text(row.runtime_kind),
    title: sessions_text(row.title),
    summary: sessions_text(row.summary),
    titledAt: sessions_num(row.titled_at),
    label: sessions_sessionLabel(sessions_text(row.title), sessions_text(row.first_prompt), sessions_text(row.agent), row.session_id as string),
  };
}

/** The Project listing reads one maintained count and at most one live activity receipt per Project. */
function sessions_listProjectsSql(includeArchived = false): string {
  return `SELECT p.project_id, p.name, p.created_at, p.archived_at, p.archived_by,
    COALESCE(c.session_count, 0) AS session_count,
    (SELECT f.last_received_at FROM session_read_facts f
      WHERE f.project_id = p.project_id AND f.has_session = 1 AND f.tombstoned = 0
      ORDER BY f.last_received_at DESC LIMIT 1) AS last_activity_at
    FROM projects p LEFT JOIN project_session_counts c ON c.project_id = p.project_id
    ${includeArchived ? '' : 'WHERE p.archived_at IS NULL'}
    ORDER BY last_activity_at DESC NULLS LAST, p.created_at DESC`;
}

/** Every project with its live session count and most recent live receipt, most recently active first; a project with no live session still lists with a count of zero. Unscoped: the caller decides which projects its credential may see. */
async function sessions_listProjects(db: sessions_import_RelationalStore, opts: { includeArchived?: boolean } = {}): Promise<sessions_ProjectRow[]> {
  const { results } = await prepareViewRead(db, "N:sessions_listProjects:0", sessions_listProjectsSql(opts.includeArchived)).all<Record<string, unknown>>();
  return results.map((row) => ({
    projectId: row.project_id as string,
    name: row.name as string,
    createdAt: row.created_at as number,
    sessionCount: row.session_count as number,
    lastActivityAt: (row.last_activity_at as number | null) ?? null,
    archivedAt: (row.archived_at as number | null) ?? null,
    archivedBy: (row.archived_by as string | null) ?? null,
  }));
}

type sessions_ArchiveOutcome = 'archived' | 'absent' | 'already_archived';
type sessions_UnarchiveOutcome = 'restored' | 'absent' | 'not_archived';

/** Sessions ordered by presented start and session ID. Refinement can move rows between keyset pages. */
interface sessions_SessionFilters {
  branch?: string;
  /** Sessions started at or after this instant (ms); under an activity window, sessions active at or after it. */
  since?: number;
  /** Sessions started before this instant (ms); a session started exactly at it is not listed. */
  until?: number;
  /**
   * What the window's two instants bound. `start` (the default) is when the session started. `activity` is the span
   * of its activity: a session is listed when it started before the window's end and its activity reaches the
   * window's start — its last event received then or later, and no end recorded before it. A session that started yesterday and is
   * live now is in today's window and in yesterday's. An activity window needs its start instant.
   */
  window?: 'start' | 'activity';
  /** `open` is a session with no end recorded; `ended` one with an end. */
  state?: 'open' | 'ended';
  /**
   * The instant working is judged against. A read given it marks each session working or not, and under an activity
   * window also lists every session working now, whatever its last receipt: a long turn sends nothing until it ends.
   */
  now?: number;
  /** The label of the member whose credential captured the session. */
  memberLabel?: string;
  /** The agent that captured the session, as the session records it. */
  agent?: string;
  sessionId?: string;
  /** A text the session's title, first prompt, agent, branch or id contains, matched case-insensitively. */
  q?: string;
  /**
   * Which sessions this read admits by the fidelity of the transcripts behind
   * them. `full` admits only sessions every transcript of which the parser
   * could read completely; `any` admits all.
   *
   * `listSessions` defaults to `full` and `listSessionSummaries` to `any`, and
   * the difference is deliberate. Everything that assembles extraction material
   * reads the former; a person or an agent browsing history reads the latter.
   * The default fails closed on the expensive side: a session hidden from a
   * page is an absence someone can see, while knowledge extracted from a
   * transcript known to be incomplete reads exactly like knowledge that is not.
   */
  fidelity?: 'full' | 'any';
}

/** Every primary and sibling transcript is fully parsed at full fidelity. */
const sessions_FULL_FIDELITY = `${sessions_import_sessionMaterialReadySql('s')} AND NOT EXISTS (SELECT 1 FROM transcripts t
  WHERE t.project_id = s.project_id AND t.session_id = s.session_id
    AND t.fidelity IS NOT NULL AND t.fidelity <> 'full')`;

/**
 * When a session happened, for ordering: its own start where it has one, and
 * the receipt where it does not.
 *
 * The receipt records when the Deployment learned of a session, which is a
 * different instant from when the session ran. The two coincide for live
 * capture and diverge everywhere else — a month-old transcript imported today,
 * a spool drained days after an outage — and ordering on the receipt puts both
 * at the top of a list of recent work.
 *
 * The keyset predicate, the sort and the page cursor all derive from this one
 * expression. A sort changed without the other two leaves the cursor comparing
 * a column the rows are no longer ordered by, which drops and repeats rows
 * across pages rather than failing.
 */
/** The instant a session is ordered by: `PRESENTED_STARTED_AT` falling through to the first receipt, spelled flat. `idx_sessions_occurred` indexes this exact expression; a nested form plans as a sort instead, so the two are written the same way and move together. */
const sessions_SESSION_OCCURRED_AT = sessions_import_occurredAt('s.');

async function sessions_listSessions(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, opts: { limit?: number; cursor?: string } & sessions_SessionFilters = {}): Promise<sessions_import_Page<sessions_SessionRow>> {
  const listed = await sessions_selectSessions(db, { sql: 's.project_id = ?', params: [scope.projectId] }, opts, sessions_activityWindow(opts) ? sessions_SESSIONS_ACTIVE_INDEX : '');
  return { cursor: listed.cursor, rows: listed.rows.map(({ projectId: _projectId, ...row }) => row) };
}

/**
 * Sessions of every Project in the set, newest first, one keyset page at a time. The read walks
 * `idx_sessions_occurred_deployment`, which indexes the same expression the per-Project read orders by, and stops at
 * its page rather than sorting every session the set holds. The index is named in the
 * statement: with a filter the planner takes to be selective, such as an agent, it reads every session and sorts
 * them instead. A session is keyed by its Project and its id, and the cursor carries the id alone: two sessions of
 * different Projects sharing an id and an instant are the one case a page boundary may skip.
 */
async function sessions_listSessionsAcross(db: sessions_import_RelationalStore, set: sessions_import_ProjectSet, opts: { limit?: number; cursor?: string } & sessions_SessionFilters = {}): Promise<sessions_import_Page<sessions_SessionRow & { projectId: string }>> {
  return sessions_selectSessions(db, sessions_import_projectsFiltering(set, 's'), opts, sessions_activityWindow(opts) ? sessions_SESSIONS_ACTIVE_INDEX : sessions_SESSIONS_ACROSS_INDEX);
}

/** Whether the read bounds sessions by the span they were active. An activity window with no start instant bounds nothing it can seek. */
function sessions_activityWindow(opts: sessions_SessionFilters): boolean {
  if (opts.window !== 'activity') return false;
  if (opts.since === undefined) throw new RangeError('an activity window needs since');
  return true;
}

/**
 * The one session page: `projects` admits the rows, the filters narrow them, and the order and the cursor are the
 * occurred instant and the id. `walks` names the index the statement reads through. A read that walks the
 * Deployment-wide order also takes the cursor's instant as an upper bound beside the keyset predicate, which the
 * predicate already implies, so the walk seeks to the cursor instead of reading every newer row again. An activity
 * window reads the sessions received from its start on and sorts them.
 */
async function sessions_selectSessions(
  db: sessions_import_RelationalStore,
  projects: { sql: string; params: readonly unknown[] },
  opts: { limit?: number; cursor?: string } & sessions_SessionFilters,
  walks: string = '',
): Promise<sessions_import_Page<sessions_SessionRow & { projectId: string }>> {
  const active = sessions_activityWindow(opts);
  const k = sessions_import_keyset(opts, { order: sessions_SESSION_OCCURRED_AT, id: 's.session_id', direction: 'DESC' });
  if (k === null) return { rows: [], cursor: null };
  const read = async (window: 'receipt' | 'working', through: string): Promise<Record<string, unknown>[]> => {
    const bounded = through === sessions_SESSIONS_ACROSS_INDEX;
    const conditions = [projects.sql, sessions_LIVE_SESSION];
    if ((opts.fidelity ?? 'full') === 'full') conditions.push(sessions_FULL_FIDELITY);
    const params: unknown[] = [...projects.params];
    if (opts.branch !== undefined) { conditions.push('s.branch = ?'); params.push(opts.branch); }
    if (opts.agent !== undefined) { conditions.push('s.agent = ?'); params.push(opts.agent); }
    if (window === 'working') {
      // Working now: a turn opened within the cap, with no end recorded or one older than the turn.
      conditions.push('s.working_since IS NOT NULL', 's.working_since > ?', `(${sessions_PRESENTED_ENDED_AT} IS NULL OR ${sessions_PRESENTED_ENDED_AT} < s.working_since)`);
      params.push(opts.now! - sessions_WORKING_CAP_MS);
    } else if (active) {
      // Active in the window: a receipt at or after its start, and no end recorded before it.
      conditions.push('s.last_received_at >= ?', `(${sessions_PRESENTED_ENDED_AT} IS NULL OR ${sessions_PRESENTED_ENDED_AT} >= ?)`);
      params.push(opts.since!, opts.since!);
    } else if (opts.since !== undefined) {
      // The instant the page is ordered by, so the filter admits what the order shows.
      conditions.push(`${sessions_SESSION_OCCURRED_AT} >= ?`); params.push(opts.since);
    }
    if (opts.until !== undefined) { conditions.push(`${sessions_SESSION_OCCURRED_AT} < ?`); params.push(opts.until); }
    // Open and ended as the page shows them, each session under one. A session working again after its recorded end is
    // open while it works: the working read lists it as open, and a read of ended sessions judged at an instant leaves it
    // out.
    if (opts.state === 'open' && window !== 'working') conditions.push(`${sessions_PRESENTED_ENDED_AT} IS NULL`);
    if (opts.state === 'ended') {
      conditions.push(`${sessions_PRESENTED_ENDED_AT} IS NOT NULL`);
      if (opts.now !== undefined) {
        conditions.push(`NOT (s.working_since IS NOT NULL AND s.working_since > ${sessions_PRESENTED_ENDED_AT} AND s.working_since > ?)`);
        params.push(opts.now - sessions_WORKING_CAP_MS);
      }
    }
    if (opts.memberLabel !== undefined) { conditions.push('m.label = ?'); params.push(opts.memberLabel); }
    if (opts.sessionId !== undefined) { conditions.push('s.session_id = ?'); params.push(opts.sessionId); }
    if (opts.q !== undefined && opts.q.trim() !== '') {
      const pattern = sessions_import_containsPattern(opts.q.trim());
      conditions.push(`(s.title LIKE ? ESCAPE '\\' OR s.agent LIKE ? ESCAPE '\\' OR s.branch LIKE ? ESCAPE '\\' OR s.session_id LIKE ? ESCAPE '\\' OR ${sessions_FIRST_PROMPT_SQL} LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    if (k.where !== '') {
      if (bounded) { conditions.push(`${sessions_SESSION_OCCURRED_AT} <= ?`); params.push(k.params[0]); }
      conditions.push(k.where); params.push(...k.params);
    }
    const { results } = await prepareViewRead(db, active ? (window === 'working' ? "M14:sessions_selectSessions:working" : "M14:sessions_selectSessions:receipt") : "M13:sessions_selectSessions:ordinary", `SELECT s.project_id, ${sessions_SESSION_COLUMNS} ${sessions_sessionFrom(through)} WHERE ${conditions.join(' AND ')} ORDER BY ${sessions_SESSION_OCCURRED_AT} DESC, s.session_id DESC LIMIT ?`)
      .bind(...params, k.limit + 1)
      .all<Record<string, unknown>>();
    return results;
  };
  const received = await read('receipt', walks);
  // An activity window judged at an instant also lists the sessions working now, read apart through the index that
  // holds them alone, and merged into the page in its own order.
  const working = active && opts.now !== undefined ? await read('working', sessions_SESSIONS_WORKING_INDEX) : [];
  const rows = sessions_mergeSessionPages(received, working).map((row) => ({ ...sessions_toSession(row, opts.now), projectId: row.project_id as string }));
  // The cursor carries the same value the sort ordered by. Both columns are
  // already on the row, so this is the SQL COALESCE read back rather than a
  // second definition of it.
  return sessions_import_page(rows, k.limit, (r) => ({ createdAt: r.startedAt ?? r.firstReceivedAt, id: r.sessionId }));
}

/** Two pages of session rows as one, each session once, in the order a page reads: newest occurrence first, then id. */
function sessions_mergeSessionPages(a: Record<string, unknown>[], b: Record<string, unknown>[]): Record<string, unknown>[] {
  if (b.length === 0) return a;
  const key = (row: Record<string, unknown>) => `${row.project_id as string}\u0000${row.session_id as string}`;
  const occurred = (row: Record<string, unknown>) => (row.started_at as number | null) ?? (row.first_received_at as number);
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((row) => !seen.has(key(row)))].sort((x, y) =>
    occurred(y) - occurred(x) || (x.session_id as string < (y.session_id as string) ? 1 : x.session_id === y.session_id ? 0 : -1));
}

/** Elapsed source time, or observed time when a recorded endpoint anchors it. Synthetic transcript bounds establish neither. */
async function sessions_sessionDurationMs(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<number | null> {
  const row = await prepareViewRead(db, "N:sessions_sessionDurationMs:0", `SELECT agent, started_at, ended_at, ended_by, occurred_started_at, occurred_ended_at,
    first_received_at, last_received_at FROM sessions WHERE project_id = ? AND session_id = ?`)
    .bind(scope.projectId, sessionId).first<{
      agent: string | null; started_at: number | null; ended_at: number | null; ended_by: string | null;
      occurred_started_at: number | null; occurred_ended_at: number | null; first_received_at: number; last_received_at: number;
    }>();
  if (row === null) return null;
  const recorded = sessions_import_sourceTimestampsRecorded(sessions_import_CAPTURE_RULE_BUNDLES, row.agent);
  const start = recorded ? row.occurred_started_at ?? row.started_at : row.occurred_started_at === null ? row.started_at : null;
  const end = recorded ? row.occurred_ended_at ?? row.ended_at : row.occurred_ended_at === null || row.ended_by !== null ? row.ended_at : null;
  if (start === null && end === null) return null;
  return Math.max(0, (end ?? row.last_received_at) - (start ?? row.first_received_at));
}

/**
 * A session's lifecycle columns, with no presented date over them. Admission,
 * reopening, ending and titling read these: a session presented as finished is
 * still open to the lifecycle until an end lands. A deleted session answers null.
 */
interface sessions_SessionLifecycle {
  machineId: string | null;
  createdByTokenId: string;
  startedAt: number | null;
  endedAt: number | null;
  firstReceivedAt: number;
}

async function sessions_sessionLifecycle(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<sessions_SessionLifecycle | null> {
  const row = await prepareViewRead(db, "N:sessions_sessionLifecycle:0", `SELECT s.machine_id, s.created_by_token_id, s.started_at, s.ended_at, s.first_received_at
                FROM sessions s WHERE s.project_id = ? AND s.session_id = ? AND ${sessions_LIVE_SESSION}`)
    .bind(scope.projectId, sessionId)
    .first<Record<string, unknown>>();
  return row === null ? null : {
    machineId: sessions_text(row.machine_id),
    createdByTokenId: row.created_by_token_id as string,
    startedAt: sessions_num(row.started_at),
    endedAt: sessions_num(row.ended_at),
    firstReceivedAt: row.first_received_at as number,
  };
}

/** The child counts of every named session, one statement per table per run of ids; a session with no rows in a table counts zero. */
async function sessions_sessionCountsFor(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[]): Promise<Map<string, sessions_SessionCounts>> {
  const read = sessions_countStatements(db, scope, sessionIds);
  return read.parse(read.statements.length === 0 ? [] : await db.batch(read.statements));
}

const sessions_COUNTED_TABLES = [['prompts', 'prompt_batches'], ['toolCalls', 'tool_calls'], ['responses', 'responses'], ['plans', 'plans'], ['attachments', 'attachments']] as const;

/** The statements `sessionCountsFor` sends, and how their results read, so a caller may send them in a batch of its own. */
function sessions_countStatements(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[]): { statements: sessions_import_PreparedStatement[]; parse: (results: readonly sessions_import_RunResult[]) => Map<string, sessions_SessionCounts> } {
  const statements = sessions_import_inListChunks(sessionIds).flatMap((ids) => sessions_COUNTED_TABLES.map(([, table]) =>
    prepareViewRead(db, "M15:sessions_countStatements:0", `SELECT session_id, COUNT(*) AS n FROM ${table} WHERE project_id = ? AND session_id IN (${ids.map(() => '?').join(', ')}) GROUP BY session_id`).bind(scope.projectId, ...ids)));
  const parse = (results: readonly sessions_import_RunResult[]): Map<string, sessions_SessionCounts> => {
    const out = new Map<string, sessions_SessionCounts>(sessionIds.map((id) => [id, { prompts: 0, toolCalls: 0, responses: 0, plans: 0, attachments: 0 }]));
    results.forEach((result, i) => {
      const [key] = sessions_COUNTED_TABLES[i % sessions_COUNTED_TABLES.length];
      for (const row of result.results as { session_id: string; n: number }[]) {
        const counts = out.get(row.session_id);
        if (counts) counts[key] = row.n;
      }
    });
    return out;
  };
  return { statements, parse };
}

/** How many lifetime buckets a session's activity is spread over; the rail's sparkline width. */
const sessions_ACTIVITY_BUCKETS = 8;

/** A session row with what the rail shows beside it: its counts and its activity spread over its lifetime, oldest bucket first. */
interface sessions_SessionSummaryRow extends sessions_SessionRow {
  promptCount: number;
  toolCallCount: number;
  activityBuckets: number[];
}

/**
 * Buckets each session's prompt instants over its lifetime. The stored range is
 * a hint widened by the observed instants: a session with no recorded start, or
 * whose prompts predate a re-registered start, still shows its activity.
 */
function sessions_bucketActivity(sessions: readonly Pick<sessions_SessionRow, 'sessionId' | 'startedAt' | 'firstReceivedAt' | 'endedAt' | 'lastReceivedAt'>[], instants: readonly { sessionId: string; at: number }[], nowMs: number): Map<string, number[]> {
  const out = new Map<string, number[]>(sessions.map((s) => [s.sessionId, new Array<number>(sessions_ACTIVITY_BUCKETS).fill(0)]));
  const observed = new Map<string, { start: number; end: number }>();
  for (const { sessionId, at } of instants) {
    const range = observed.get(sessionId);
    if (range === undefined) observed.set(sessionId, { start: at, end: at });
    else { range.start = Math.min(range.start, at); range.end = Math.max(range.end, at); }
  }
  const ranges = new Map<string, { start: number; end: number }>();
  for (const s of sessions) {
    const seen = observed.get(s.sessionId);
    const start = Math.min(s.startedAt ?? s.firstReceivedAt, seen?.start ?? Number.POSITIVE_INFINITY);
    const end = Math.max(start + 1, s.endedAt ?? (s.startedAt === null ? s.lastReceivedAt : nowMs), seen?.end ?? Number.NEGATIVE_INFINITY);
    ranges.set(s.sessionId, { start, end });
  }
  for (const { sessionId, at } of instants) {
    const buckets = out.get(sessionId);
    const range = ranges.get(sessionId);
    if (buckets === undefined || range === undefined || at < range.start || at > range.end) continue;
    const span = Math.max(1, range.end - range.start);
    const idx = Math.min(sessions_ACTIVITY_BUCKETS - 1, Math.floor(((at - range.start) / span) * sessions_ACTIVITY_BUCKETS));
    buckets[idx] += 1;
  }
  return out;
}

/** Every prompt instant of the named sessions, one statement per run of ids. */
async function sessions_promptInstants(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[]): Promise<{ sessionId: string; at: number }[]> {
  const read = sessions_instantStatements(db, scope, sessionIds);
  return read.parse(read.statements.length === 0 ? [] : await db.batch(read.statements));
}

/** The statements `promptInstants` sends, and how their results read. */
function sessions_instantStatements(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[]): { statements: sessions_import_PreparedStatement[]; parse: (results: readonly sessions_import_RunResult[]) => { sessionId: string; at: number }[] } {
  const statements = sessions_import_inListChunks(sessionIds).map((ids) =>
    prepareViewRead(db, "M16:sessions_instantStatements:0", `SELECT session_id, created_at FROM prompt_batches WHERE project_id = ? AND session_id IN (${ids.map(() => '?').join(', ')})`).bind(scope.projectId, ...ids));
  return {
    statements,
    parse: (results) => results.flatMap((r) => (r.results as { session_id: string; created_at: number }[]).map((row) => ({ sessionId: row.session_id, at: row.created_at }))),
  };
}

/** The session list with its rail facts: the counts of every child table and, unless the caller has no use for it, the activity buckets, over the page's ids only. The dashboard and the MCP tool both read the list through this. */
async function sessions_listSessionSummaries(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, opts: { limit?: number; cursor?: string } & sessions_SessionFilters, nowMs: number, facts: { activity?: boolean } = {}): Promise<sessions_import_Page<sessions_SessionSummaryRow>> {
  // A person and an agent browsing history see every session, labelled by what
  // its transcript could carry; the caller may still narrow.
  const listed = await sessions_listSessions(db, scope, { fidelity: 'any', now: nowMs, ...opts });
  const ids = listed.rows.map((r) => r.sessionId);
  const counts = await sessions_sessionCountsFor(db, scope, ids);
  const instants = facts.activity === false ? [] : await sessions_promptInstants(db, scope, ids);
  const buckets = sessions_bucketActivity(listed.rows, instants, nowMs);
  return {
    cursor: listed.cursor,
    rows: listed.rows.map((row) => {
      const c = counts.get(row.sessionId);
      return { ...row, promptCount: c?.prompts ?? 0, toolCallCount: c?.toolCalls ?? 0, activityBuckets: buckets.get(row.sessionId) ?? new Array<number>(sessions_ACTIVITY_BUCKETS).fill(0) };
    }),
  };
}

/** A session of a read across Projects, with the rail facts the per-Project list carries and the Project it belongs to. */
type sessions_SessionAcrossRow = sessions_SessionSummaryRow & { projectId: string };

/**
 * The session list across a set of Projects with the per-Project list's rail facts. Each child table is keyed by
 * Project first, so the facts are read per Project over that Project's ids on the page, every statement in one batch.
 */
async function sessions_listSessionSummariesAcross(db: sessions_import_RelationalStore, set: sessions_import_ProjectSet, opts: { limit?: number; cursor?: string } & sessions_SessionFilters, nowMs: number): Promise<sessions_import_Page<sessions_SessionAcrossRow>> {
  const listed = await sessions_listSessionsAcross(db, set, { fidelity: 'any', now: nowMs, ...opts });
  const byProject = new Map<string, string[]>();
  for (const row of listed.rows) byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row.sessionId]);
  const reads = [...byProject].map(([projectId, ids]) => ({ projectId, counts: sessions_countStatements(db, { projectId }, ids), instants: sessions_instantStatements(db, { projectId }, ids) }));
  const statements = reads.flatMap((r) => [...r.counts.statements, ...r.instants.statements]);
  const results = statements.length === 0 ? [] : await db.batch(statements);
  const facts = new Map<string, { counts: Map<string, sessions_SessionCounts>; buckets: Map<string, number[]> }>();
  let at = 0;
  for (const read of reads) {
    const counts = read.counts.parse(results.slice(at, at += read.counts.statements.length));
    const instants = read.instants.parse(results.slice(at, at += read.instants.statements.length));
    facts.set(read.projectId, { counts, buckets: sessions_bucketActivity(listed.rows.filter((r) => r.projectId === read.projectId), instants, nowMs) });
  }
  return {
    cursor: listed.cursor,
    rows: listed.rows.map((row) => {
      const held = facts.get(row.projectId);
      const c = held?.counts.get(row.sessionId);
      return { ...row, promptCount: c?.prompts ?? 0, toolCallCount: c?.toolCalls ?? 0, activityBuckets: held?.buckets.get(row.sessionId) ?? new Array<number>(sessions_ACTIVITY_BUCKETS).fill(0) };
    }),
  };
}

/** What the project holds, one count per projection: they share no key, and a join would multiply rows. */
async function sessions_projectStats(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, nowMs: number): Promise<sessions_ProjectStats> {
  const sessions = await prepareViewRead(db, "M17:sessions_projectStats:0", `SELECT COUNT(*) AS total, SUM(CASE WHEN ${sessions_PRESENTED_ENDED_AT} IS NULL THEN 1 ELSE 0 END) AS open,
                     SUM(CASE WHEN ${sessions_SESSION_OCCURRED_AT} >= ? THEN 1 ELSE 0 END) AS recent, MAX(last_received_at) AS last
                FROM sessions s WHERE s.project_id = ? AND ${sessions_LIVE_SESSION}`)
    .bind(nowMs - sessions_WEEK_MS, scope.projectId)
    .first<Record<string, unknown>>();
  const countOf = async (table: string): Promise<number> => {
    const row = await prepareViewRead(db, "M17:sessions_projectStats:1", `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).bind(scope.projectId).first<{ n: number }>();
    return row?.n ?? 0;
  };
  return {
    sessions: (sessions?.total as number | null) ?? 0,
    openSessions: (sessions?.open as number | null) ?? 0,
    sessionsLast7d: (sessions?.recent as number | null) ?? 0,
    prompts: await countOf('prompt_batches'),
    toolCalls: await countOf('tool_calls'),
    plans: await countOf('plans'),
    attachments: await countOf('attachments'),
    lastActivityAt: (sessions?.last as number | null) ?? null,
  };
}

/** True when the project exists. The core answers what is there; a facade decides whether its caller may see it. */
async function sessions_projectExists(db: sessions_import_RelationalStore, projectId: string): Promise<boolean> {
  const row = await prepareViewRead(db, "N:sessions_projectExists:0", `SELECT 1 AS present FROM projects WHERE project_id = ?`).bind(projectId).first<{ present: number }>();
  return row !== null;
}

/** Which of these Project ids name a Project, in one statement. At most `MAX_IN_LIST` ids. */
async function sessions_existingProjects(db: sessions_import_RelationalStore, projectIds: readonly string[]): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();
  const { results } = await prepareViewRead(db, "N:sessions_existingProjects:0", `SELECT project_id FROM projects WHERE project_id IN (${projectIds.map(() => '?').join(', ')})`)
    .bind(...projectIds)
    .all<{ project_id: string }>();
  return new Set(results.map((r) => r.project_id));
}

/** True when the session exists inside the scope. `sessions` is keyed `(project_id, session_id)`, so containment is the only safe question to ask of a session id. */
async function sessions_sessionInScope(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<boolean> {
  const row = await prepareViewRead(db, "N:sessions_sessionInScope:0", `SELECT 1 AS present FROM sessions WHERE project_id = ? AND session_id = ? AND ${sessions_import_NOT_TOMBSTONED_PARAMS}`)
    .bind(scope.projectId, sessionId, scope.projectId, sessionId)
    .first<{ present: number }>();
  return row !== null;
}

/**
 * True when the session sits inside the scope and the named machine holds it.
 *
 * One question, one answer: a session another machine captured reads the same
 * as one the Project never held, so a caller naming an id it does not own
 * learns nothing about whether that id exists.
 */
async function sessions_sessionHeldByMachine(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string, machineId: string): Promise<boolean> {
  const row = await prepareViewRead(db, "N:sessions_sessionHeldByMachine:0", `SELECT 1 AS present FROM sessions WHERE project_id = ? AND session_id = ? AND machine_id = ? AND ${sessions_import_NOT_TOMBSTONED_PARAMS}`)
    .bind(scope.projectId, sessionId, machineId, scope.projectId, sessionId)
    .first<{ present: number }>();
  return row !== null;
}

/** True when the Project holds this session, whichever machine captured it: what a run's dispatch-named session is checked against before a write names it. */
async function sessions_projectHoldsSession(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<boolean> {
  const row = await prepareViewRead(db, "N:sessions_projectHoldsSession:0", `SELECT 1 AS present FROM sessions WHERE project_id = ? AND session_id = ? AND ${sessions_import_NOT_TOMBSTONED_PARAMS}`)
    .bind(scope.projectId, sessionId, scope.projectId, sessionId)
    .first<{ present: number }>();
  return row !== null;
}

/** Whether a session inside the scope carries a title. The row a titling run owed, as the store holds it. */
async function sessions_sessionCarriesTitle(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<boolean> {
  const row = await prepareViewRead(db, "N:sessions_sessionCarriesTitle:0", `SELECT 1 AS one FROM sessions WHERE project_id = ? AND session_id = ? AND title IS NOT NULL`)
    .bind(scope.projectId, sessionId)
    .first<{ one: number }>();
  return row !== null;
}

/** Which of these sessions the Project holds a row for, whatever their state. */
async function sessions_heldSessionIds(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const run of sessions_import_inListChunks(sessionIds)) {
    const { results } = await prepareViewRead(db, "N:sessions_heldSessionIds:0", `SELECT session_id FROM sessions WHERE project_id = ? AND session_id IN (${run.map(() => '?').join(', ')})`)
      .bind(scope.projectId, ...run)
      .all<{ session_id: string }>();
    for (const r of results) out.add(r.session_id);
  }
  return out;
}

/** Sessions whose original facts were recorded by a named importer. */
async function sessions_sessionsOwnedByImporter(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[], producer: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const run of sessions_import_inListChunks(sessionIds)) {
    const { results } = await prepareViewRead(db, "N:sessions_sessionsOwnedByImporter:0", `SELECT s.session_id FROM sessions s JOIN events e ON e.project_id = s.project_id AND e.event_id = s.facts_event_id
       WHERE s.project_id = ? AND s.session_id IN (${run.map(() => '?').join(', ')}) AND e.channel = 'import' AND e.producer_adapter = ?
         AND NOT EXISTS (SELECT 1 FROM events live WHERE live.project_id = s.project_id AND live.session_id = s.session_id
           AND live.channel <> 'import' AND live.kind IN ('session.start', 'session.end', 'transcript.segment'))`).bind(scope.projectId, ...run, producer).all<{ session_id: string }>();
    for (const row of results) out.add(row.session_id);
  }
  return out;
}

/** Which of these sessions hold a prompt `producer` sent on the import channel. */
const sessions_IMPORTED_PROMPT_SESSIONS_SQL = `SELECT offered.value AS session_id FROM json_each(?) offered
  WHERE EXISTS (SELECT 1 FROM events e WHERE e.project_id = ? AND e.session_id = offered.value
    AND e.kind = 'prompt' AND e.channel = 'import' AND e.producer_adapter = ?)`;

async function sessions_sessionsWithImportedPrompts(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[], producer: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const run of sessions_import_inListChunks(sessionIds)) {
    const { results } = await prepareViewRead(db, "M36:sessions_sessionsWithImportedPrompts:0", sessions_IMPORTED_PROMPT_SESSIONS_SQL)
      .bind(JSON.stringify(run), scope.projectId, producer)
      .all<{ session_id: string }>();
    for (const r of results) out.add(r.session_id);
  }
  return out;
}

/** A child projection read: its table, selected columns, order expression and tie-breaking identity. */
interface children_ChildQuery<T> {
  table: string;
  promptHint?: string;
  columns: string;
  idColumn: string;
  /** The numeric ordering expression paired with the identity in a page cursor. */
  orderColumn: string;
  map: (row: Record<string, unknown>) => T;
}

/** Paging plus, for the tables that carry one, the prompt whose children the page is narrowed to; `idx_tool_calls_prompt` and `idx_attachments_prompt` serve the narrowed order. */
interface children_ChildOptions { limit?: number; cursor?: string; promptId?: string }

/** Conditions a child read adds past the session scope, each a SQL term with the values it binds. */
interface children_ChildFilter { sql: string; params: readonly unknown[] }

function children_childColumns<T>(query: children_ChildQuery<T>): string {
  if (query.promptHint === undefined) return query.columns;
  return `${hook_placement_placedHintSql({ project: `${query.table}.project_id`, session: `${query.table}.session_id`, prompt: `${query.table}.${query.promptHint}` })} AS prompt_id, ${query.columns}`;
}

interface children_PromptRow { promptId: string; text: string | null; blobKey: string | null; origin: string; promptKind: string | null; parentPromptId: string | null; threadLabel: string | null; createdAt: number; orderedAt: number }
/** A tool call and how it went. `inputPreview` is a bounded UTF-8 display prefix and `inputBytes` is the complete input size. */
interface children_ToolCallRow {
  toolCallId: string; promptId: string | null; toolName: string; mycoTool: string | null; mycoOp: string | null;
  inputPreview: string | null; inputBytes: number | null; inputTruncated: boolean; inputBlobKey: string | null; outputPreview: string | null; outputBlobKey: string | null;
  success: boolean; errorMessage: string | null; durationMs: number | null; filesAffected: string | null; createdAt: number; orderedAt: number;
}
interface children_ResponseRow { responseId: string; promptId: string | null; text: string | null; blobKey: string | null; createdAt: number; orderedAt: number }
/** `planKey` is the plan's identity in this table (its primary key), not a session-scoped id. `createdAt` is the plan's first capture; `orderedAt` carries the `updated_at` this listing pages over. */
interface children_PlanRow { planKey: string; promptId: string | null; title: string | null; status: string; content: string | null; blobKey: string | null; originPath: string | null; progress: string; updatedBy: string | null; createdAt: number; updatedAt: number; orderedAt: number }
/** `promptId` names the session prompt the attachment's captured hint resolves to; an unplaced attachment carries null. */
interface children_AttachmentRow { attachmentId: string; promptId: string | null; blobKey: string; mediaType: string; byteSize: number; description: string | null; createdAt: number; orderedAt: number }

/**
 * A record of what Myco served the session as a whole: a session-level block (`kind` names it: `cortex` for the start,
 * `cortex:<agent>` for a sub-agent's, `plan-nudge`), or context no named prompt received (`kind` is `context:<row
 * id>`): an answer, or a receipt no answer names, which outlives the answers' retention. `delivery` says whether it
 * reached the agent with no matching prompt in this session, or has no reported delivery.
 */
interface children_ContextInjectionRow { kind: string; createdAt: number; orderedAt: number; delivery: 'unnamed_prompt' | 'not_delivered' | null }

/** The prefix of an answer row's `kind` in the session's context records. */
const children_SESSION_ANSWER_KIND_PREFIX = 'context:';

const children_CONTEXT_INJECTION_QUERY: children_ChildQuery<Omit<children_ContextInjectionRow, 'orderedAt'>> = {
  table: `(SELECT project_id, session_id, kind, created_at, NULL AS delivery FROM session_injections
     UNION ALL
     SELECT project_id, session_id, '${children_SESSION_ANSWER_KIND_PREFIX}' || id AS kind, created_at,
       CASE WHEN delivered_at IS NULL THEN 'not_delivered' ELSE 'unnamed_prompt' END AS delivery
       FROM prompt_context_answers WHERE outcome = 'served' AND NOT ${hook_placement_hookPlacementSql({ project: 'prompt_context_answers.project_id', session: 'prompt_context_answers.session_id', prompt: 'prompt_context_answers.delivered_prompt_id' })}
     UNION ALL
     SELECT r.project_id, r.session_id, '${children_SESSION_ANSWER_KIND_PREFIX}' || r.id AS kind, r.created_at,
       CASE WHEN r.delivered_at IS NULL THEN 'not_delivered' ELSE 'unnamed_prompt' END AS delivery
       FROM spore_injections r WHERE NOT ${hook_placement_hookPlacementSql({ project: 'r.project_id', session: 'r.session_id', prompt: 'r.delivered_prompt_id' })}
         AND NOT EXISTS (SELECT 1 FROM prompt_context_answers a
                          WHERE a.project_id = r.project_id AND a.session_id = r.session_id AND a.receipt_id = r.id))`,
  columns: 'kind, created_at, delivery', idColumn: 'kind', orderColumn: 'created_at',
  map: (r) => ({ kind: r.kind as string, createdAt: r.created_at as number, delivery: (r.delivery as children_ContextInjectionRow['delivery']) ?? null }),
};

const children_PROMPT_QUERY: children_ChildQuery<Omit<children_PromptRow, 'orderedAt'>> = {
  table: 'prompt_batches', columns: 'prompt_id, text, blob_key, origin, prompt_kind, parent_prompt_id, thread_label, created_at', idColumn: 'prompt_id', orderColumn: 'created_at',
  map: (r) => ({
    createdAt: r.created_at as number, promptId: r.prompt_id as string, text: (r.text as string | null) ?? null, blobKey: (r.blob_key as string | null) ?? null, origin: r.origin as string,
    promptKind: (r.prompt_kind as string | null) ?? null, parentPromptId: (r.parent_prompt_id as string | null) ?? null, threadLabel: (r.thread_label as string | null) ?? null,
  }),
};

const children_TOOL_CALL_QUERY: children_ChildQuery<Omit<children_ToolCallRow, 'orderedAt'>> = {
  table: 'tool_calls', promptHint: 'prompt_id',
  columns: `tool_call_id, tool_name, myco_tool, myco_op, substr(input, 1, ${children_import_TOOL_INPUT_PREVIEW_BYTES}) AS input_preview,
    COALESCE(input_bytes, length(CAST(input AS BLOB)), (SELECT b.size FROM blobs b WHERE b.project_id = tool_calls.project_id AND b.key = tool_calls.input_blob_key)) AS input_bytes,
    input_blob_key, output_preview, output_blob_key, success, error_message, duration_ms, files_affected, created_at`,
  idColumn: 'tool_call_id', orderColumn: 'created_at',
  map: (r) => {
    const preview = r.input_preview === null ? null : children_import_toolInputPreview(r.input_preview as string);
    const inputBytes = (r.input_bytes as number | null) ?? null;
    return {
      createdAt: r.created_at as number, toolCallId: r.tool_call_id as string, promptId: (r.prompt_id as string | null) ?? null, toolName: r.tool_name as string,
      mycoTool: (r.myco_tool as string | null) ?? null, mycoOp: (r.myco_op as string | null) ?? null,
      inputPreview: preview?.preview ?? null, inputBytes,
      inputTruncated: inputBytes !== null && inputBytes > (preview?.previewBytes ?? 0),
      inputBlobKey: (r.input_blob_key as string | null) ?? null,
      outputPreview: (r.output_preview as string | null) ?? null, outputBlobKey: (r.output_blob_key as string | null) ?? null,
      success: Number(r.success) === 1, errorMessage: (r.error_message as string | null) ?? null, durationMs: (r.duration_ms as number | null) ?? null,
      filesAffected: (r.files_affected as string | null) ?? null,
    };
  },
};

const children_RESPONSE_QUERY: children_ChildQuery<Omit<children_ResponseRow, 'orderedAt'>> = {
  table: 'responses', columns: 'response_id, prompt_id, text, blob_key, created_at', idColumn: 'response_id', orderColumn: 'created_at',
  map: (r) => ({
    createdAt: r.created_at as number,
    responseId: r.response_id as string,
    promptId: (r.prompt_id as string | null) ?? null,
    text: (r.text as string | null) ?? null,
    blobKey: (r.blob_key as string | null) ?? null,
  }),
};

/** Plans order by `updated_at` — the column `idx_plans_session` indexes — and are keyed by `plan_key`. */
const children_PLAN_QUERY: children_ChildQuery<Omit<children_PlanRow, 'orderedAt'>> = {
  table: 'plans', columns: 'plan_key, prompt_id, title, status, content, blob_key, origin_path, updated_by, created_at, updated_at', idColumn: 'plan_key', orderColumn: 'updated_at',
  map: (r) => ({
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    planKey: r.plan_key as string,
    promptId: (r.prompt_id as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    status: r.status as string,
    content: (r.content as string | null) ?? null,
    blobKey: (r.blob_key as string | null) ?? null,
    originPath: (r.origin_path as string | null) ?? null,
    progress: plans_progressOf((r.content as string | null) ?? null),
    updatedBy: (r.updated_by as string | null) ?? null,
  }),
};

/** A fixed numeric cursor prefix leaves turn plans ordered solely by their immutable plan key. */
const children_TURN_PLAN_QUERY: children_ChildQuery<Omit<children_PlanRow, 'orderedAt'>> = { ...children_PLAN_QUERY, orderColumn: 'CAST(0 AS INTEGER)' };

const children_ATTACHMENT_QUERY: children_ChildQuery<Omit<children_AttachmentRow, 'orderedAt'>> = {
  table: 'attachments', promptHint: 'prompt_id', columns: 'attachment_id, blob_key, media_type, byte_size, description, created_at', idColumn: 'attachment_id', orderColumn: 'created_at',
  map: (r) => ({
    createdAt: r.created_at as number,
    attachmentId: r.attachment_id as string,
    promptId: (r.prompt_id as string | null) ?? null,
    blobKey: r.blob_key as string,
    mediaType: r.media_type as string,
    byteSize: r.byte_size as number,
    description: (r.description as string | null) ?? null,
  }),
};

/** Paging alone, for a table with no prompt column to narrow by. */
type children_PagingOptions = Pick<children_ChildOptions, 'limit' | 'cursor'>;

const children_listPrompts = (db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts?: children_PagingOptions) => children_listChildren(db, children_PROMPT_QUERY, scope, sessionId, opts);
const children_listContextInjections = (db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts?: children_PagingOptions) => children_listChildren(db, children_CONTEXT_INJECTION_QUERY, scope, sessionId, opts);
const children_listToolCalls = (db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts?: children_ChildOptions) => children_listChildren(db, children_TOOL_CALL_QUERY, scope, sessionId, opts);
const children_listResponses = (db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts?: children_ChildOptions) => children_listChildren(db, children_RESPONSE_QUERY, scope, sessionId, opts);
/** A session's plans narrowed to one status and to a text its title contains; the terms leave `idx_plans_session` serving the scope and the order. */
interface children_PlanChildOptions extends children_ChildOptions { status?: string; q?: string }

function children_listPlans(db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts: children_PlanChildOptions = {}) {
  const { status, q, ...paging } = opts;
  const filters: children_ChildFilter[] = [];
  if (status !== undefined) filters.push({ sql: 'status = ?', params: [status] });
  const text = q?.trim() ?? '';
  if (text !== '') filters.push({ sql: `title LIKE ? ESCAPE '\\'`, params: [children_import_containsPattern(text)] });
  return children_listChildren(db, children_PLAN_QUERY, scope, sessionId, paging, filters);
}
const children_listAttachments = (db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts?: children_ChildOptions) => children_listChildren(db, children_ATTACHMENT_QUERY, scope, sessionId, opts);

interface children_MaterialRow { prompt: string; response: string | null; promptId: string }

const children_MATERIAL_PROMPT_SQL = `pb.origin = 'user' AND pb.text IS NOT NULL`;

/** Inline human prompts available to the titling material query. */
const children_sessionHasMaterialSql = (alias: string): string => `EXISTS (SELECT 1 FROM prompt_batches pb
  WHERE pb.project_id = ${alias}.project_id AND pb.session_id = ${alias}.session_id AND ${children_MATERIAL_PROMPT_SQL})`;

/**
 * Live end requests not yet attempted, with ready inline material, from
 * sessions whose member last sent anything at or before `settledBefore`;
 * oldest request first.
 */
async function children_listReadyTitleSessions(db: children_import_RelationalStore, limit: number, settledBefore: number): Promise<{ projectId: string; sessionId: string }[]> {
  const { results } = await prepareViewRead(db, "M22:children_listReadyTitleSessions:0", `SELECT s.project_id AS projectId, s.session_id AS sessionId FROM sessions s
    WHERE s.titling_requested_at IS NOT NULL AND s.ended_at IS NOT NULL AND s.titled_at IS NULL AND s.title IS NULL
      AND s.last_received_at <= ?
      AND ${children_import_notTombstonedSql('s')} AND ${children_import_sessionMaterialReadySql('s')} AND ${children_sessionHasMaterialSql('s')}
    ORDER BY s.titling_requested_at, s.project_id, s.session_id LIMIT ?`).bind(settledBefore, limit).all<{ projectId: string; sessionId: string }>();
  return results;
}

/** A session every transcript of which arrived through the import channel; a session with no transcript, or with a live one, is not imported. */
const children_importedSessionSql = (alias: string): string => `EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id)
  AND NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id AND t.imported_at IS NULL)`;

/** A session the titling convergence may take next: a first title (`claim`) or a refresh of the one standing (`refresh`), with the instant its recency is ranked by. */
interface children_TitleCandidate { projectId: string; sessionId: string; mode: 'claim' | 'refresh'; at: number }

/** The instants that decide which sessions the convergence may take, and how ready each must be. */
interface children_TitleCandidateWindow {
  /** The latest stamp an earlier attempt may carry for a retry. */
  retryBefore: number;
  /** A session still open whose last receipt is at or before this counts as ended. */
  idleBefore: number;
  /** A session whose latest activity or end is at or after this is fresh work; an earlier one is backlog, and takes no refresh. */
  freshAfter: number;
  /** A titled session is due a refresh only when its last titling stamp is at or before this. */
  refreshBefore: number;
  /** The user prompts a titled session takes after the material of its standing title before it is due a refresh. */
  refreshPrompts: number;
  /** Whether wholly imported sessions are admitted. */
  imported: boolean;
}

const children_claimableSql = `${children_import_titlingClaimAvailableSql('s')} AND ${children_import_notTombstonedSql('s')} AND ${children_import_sessionMaterialReadySql('s')} AND ${children_sessionHasMaterialSql('s')}`;
const children_importedAdmittedSql = `(? = 1 OR s.titling_requested_at IS NOT NULL OR NOT (${children_importedSessionSql('s')}))`;

/**
 * The ended, untitled sessions the titling convergence may claim: every
 * transcript parsed, inline material, and an available claim. A live end
 * request's first attempt is `session-titling`'s and is left out.
 */
const children_ENDED_UNTITLED_SQL = `FROM sessions s
    WHERE s.ended_at IS NOT NULL AND s.title IS NULL AND NOT (s.titled_at IS NULL AND s.titling_requested_at IS NOT NULL)
      AND ${children_claimableSql} AND ${children_importedAdmittedSql}`;

/** The open, untitled sessions whose last receipt is at or before `idleBefore`: ended for titling, not for the session. */
const children_IDLE_UNTITLED_SQL = `FROM sessions s
    WHERE s.ended_at IS NULL AND s.title IS NULL AND s.last_received_at <= ?
      AND ${children_claimableSql} AND ${children_importedAdmittedSql}`;

/**
 * Titled sessions, open or ended, with activity after the material of their standing title, due a refresh: stamped at or before the
 * bound, no title run of the session in flight, and at least a number of user prompts received after the material of the
 * standing title. A refresh that closed without a write leaves that material instant where it was, so its session stays due.
 * Binds: the recency bound, the stamp bound, then the prompt number twice.
 */
const children_REFRESH_DUE_SQL = `FROM sessions s
    WHERE s.title IS NOT NULL AND s.last_received_at >= ? AND s.last_received_at > COALESCE(s.title_material_at, s.titled_at) AND s.titled_at <= ?
      AND ${children_import_notTombstonedSql('s')} AND ${children_import_sessionMaterialReadySql('s')} AND NOT ${children_import_titleRunInFlightSql('s')}
      AND (SELECT COUNT(*) FROM (SELECT 1 FROM prompt_batches pb
            WHERE pb.project_id = s.project_id AND pb.session_id = s.session_id AND pb.origin = 'user'
              AND pb.received_at > COALESCE(s.title_material_at, s.titled_at) LIMIT ?)) >= ?`;

/** Candidates in the order the convergence takes them: first titles before refreshes, and fresh work before backlog within each. */
interface children_TitleCandidates { freshClaims: children_TitleCandidate[]; freshRefreshes: children_TitleCandidate[]; backlogClaims: children_TitleCandidate[] }

/** The page of one kind of candidate, ordered by the column its partial index holds. */
async function children_candidatePage(db: children_import_RelationalStore, mode: children_TitleCandidate['mode'], sql: string, at: string, order: string, binds: readonly unknown[], limit: number): Promise<children_TitleCandidate[]> {
  const { results } = await prepareViewRead(db, "M22:children_candidatePage:0", `SELECT s.project_id AS projectId, s.session_id AS sessionId, ${at} AS at ${sql} ORDER BY ${order} LIMIT ?`)
    .bind(...binds, limit).all<{ projectId: string; sessionId: string; at: number }>();
  return results.map((r) => ({ ...r, mode }));
}

/**
 * Up to `limit` candidates of each kind, newest first: first titles of sessions ended or gone quiet within the freshness
 * window and outside it, and refreshes of sessions active within it. Each read is bounded by its own partial index and by
 * the cohort's recency bound before its limit, so older work never hides newer work and no page sorts a backlog.
 */
async function children_listTitleCandidates(db: children_import_RelationalStore, window: children_TitleCandidateWindow, limit: number): Promise<children_TitleCandidates> {
  const imported = window.imported ? 1 : 0;
  const ended = (side: 'fresh' | 'backlog') => children_candidatePage(db, 'claim', `${children_ENDED_UNTITLED_SQL} AND s.ended_at ${side === 'fresh' ? '>=' : '<'} ?`, 's.ended_at',
    's.ended_at DESC, s.project_id, s.session_id', [window.retryBefore, imported, window.freshAfter], limit);
  const idle = (side: 'fresh' | 'backlog') => children_candidatePage(db, 'claim', `${children_IDLE_UNTITLED_SQL} AND s.last_received_at ${side === 'fresh' ? '>=' : '<'} ?`, 's.last_received_at',
    's.last_received_at DESC, s.project_id, s.session_id', [window.idleBefore, window.retryBefore, imported, window.freshAfter], limit);
  const refresh = () => children_candidatePage(db, 'refresh', children_REFRESH_DUE_SQL, 's.last_received_at', 's.last_received_at DESC, s.project_id, s.session_id',
    [window.freshAfter, window.refreshBefore, window.refreshPrompts, window.refreshPrompts], limit);
  const [endedFresh, idleFresh, endedBacklog, idleBacklog, freshRefreshes] = await Promise.all([ended('fresh'), idle('fresh'), ended('backlog'), idle('backlog'), refresh()]);
  const newest = (rows: children_TitleCandidate[]) => rows.sort((a, b) => b.at - a.at || a.projectId.localeCompare(b.projectId) || a.sessionId.localeCompare(b.sessionId)).slice(0, limit);
  return { freshClaims: newest([...endedFresh, ...idleFresh]), freshRefreshes, backlogClaims: newest([...endedBacklog, ...idleBacklog]) };
}

/** The ended or quiet, untitled sessions a statement selects, split by whether their own capture owes the title or the backfill switch admits it. */
async function children_countOwed(db: children_import_RelationalStore, selection: string, binds: readonly unknown[]): Promise<{ live: number; imported: number }> {
  const row = await prepareViewRead(db, "M22:children_countOwed:0", `SELECT COUNT(*) AS total, COALESCE(SUM(s.titling_requested_at IS NULL AND ${children_importedSessionSql('s')}), 0) AS imported ${selection}`)
    .bind(...binds).first<{ total: number; imported: number }>();
  const imported = row?.imported ?? 0;
  return { live: (row?.total ?? 0) - imported, imported };
}

/** What the titling convergence has left: sessions whose own capture owes them a title (ended, or gone quiet), and wholly imported sessions the backfill switch admits. */
async function children_countConvergenceTitleSessions(db: children_import_RelationalStore, retryBefore: number, idleBefore: number): Promise<{ live: number; imported: number }> {
  const [ended, quiet] = await Promise.all([
    children_countOwed(db, children_ENDED_UNTITLED_SQL, [retryBefore, 1]),
    children_countOwed(db, children_IDLE_UNTITLED_SQL, [idleBefore, retryBefore, 1]),
  ]);
  return { live: ended.live + quiet.live, imported: ended.imported + quiet.imported };
}

/** Why an ended session carries no title yet, in the order a reader can act on it. */
type children_UntitledReason = 'capture_pending' | 'no_material' | 'in_progress' | 'stopped' | 'imported' | 'waiting';

/** Why an ended session is untitled; null for a titled or open session, or one the project does not hold. */
async function children_untitledReason(db: children_import_RelationalStore, projectId: string, sessionId: string): Promise<children_UntitledReason | null> {
  const row = await prepareViewRead(db, "M22:children_untitledReason:0", `SELECT CASE WHEN s.title IS NOT NULL OR s.ended_at IS NULL THEN NULL
      WHEN NOT ${children_import_sessionMaterialReadySql('s')} THEN 'capture_pending'
      WHEN NOT ${children_sessionHasMaterialSql('s')} THEN 'no_material'
      WHEN ${children_import_titleRunInFlightSql('s')} THEN 'in_progress'
      WHEN s.titling_attempts >= ${children_import_TITLING_MAX_ATTEMPTS} THEN 'stopped'
      WHEN s.titling_requested_at IS NULL AND ${children_importedSessionSql('s')} THEN 'imported'
      ELSE 'waiting' END AS reason FROM sessions s WHERE s.project_id = ? AND s.session_id = ?`)
    .bind(projectId, sessionId).first<{ reason: children_UntitledReason | null }>();
  return row?.reason ?? null;
}

/** A session's earliest inline user prompts, each cut to `excerptChars`, with the start of its first inline response; `limit` prompts at most, oldest first. */
const children_sessionMaterialRows = (db: children_import_RelationalStore, projectId: string, sessionId: string, opts: { limit: number; excerptChars: number }): Promise<children_MaterialRow[]> =>
  children_materialRows(db, projectId, sessionId, opts, 'ASC');

/** The same for the session's latest inline user prompts, answered oldest first so the two halves read in order. */
const children_sessionMaterialTailRows = async (db: children_import_RelationalStore, projectId: string, sessionId: string, opts: { limit: number; excerptChars: number }): Promise<children_MaterialRow[]> =>
  (await children_materialRows(db, projectId, sessionId, opts, 'DESC')).reverse();

/** The most generations the walk climbs above the session, and descends below the root it reached. */
const lineage_LINEAGE_MAX_DEPTH = 8;
/** The most sessions one lineage holds, the session itself and its ancestors included. */
const lineage_LINEAGE_MAX_NODES = 200;

/** `launched`: the parent started the child (`launch_parent_session_id`). `continuation`: the child continues the parent's conversation under a new id (`parent_session_id`). */
const lineage_LINEAGE_EDGE_KINDS = ['launched', 'continuation'] as const;
type lineage_LineageEdgeKind = (typeof lineage_LINEAGE_EDGE_KINDS)[number];

interface lineage_LineageEdge {
  parentId: string;
  childId: string;
  kind: lineage_LineageEdgeKind;
  /** The continuation's recorded reason; null for a launch. */
  reason: string | null;
}

interface lineage_LineageNode {
  sessionId: string;
  /** False for a parent this Project holds no session for: it is named by a child's record alone. */
  captured: boolean;
  label: string | null;
  agent: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** Generations below the root it is placed under. */
  depth: number;
  /** The edge it is placed under; null for a root. A session with two parents in the lineage is placed under the one nearer a root and keeps both edges. */
  placedUnder: lineage_LineageEdge | null;
  current: boolean;
}

interface lineage_SessionLineage {
  /** Every session of the lineage in tree order: each root, then what is placed under it, children by start. */
  nodes: lineage_LineageNode[];
  /** Every edge between two sessions of the lineage, both kinds. */
  edges: lineage_LineageEdge[];
  /** True when a bound stopped the walk with sessions left unread. */
  truncated: boolean;
}

interface lineage_Row {
  session_id: string;
  agent: string | null;
  title: string | null;
  first_prompt: string | null;
  started_at: number | null;
  ended_at: number | null;
  parent_session_id: string | null;
  parent_reason: string | null;
  launch_parent_session_id: string | null;
}

const lineage_LINEAGE_COLUMNS = `s.session_id, s.agent, s.title, ${sessions_FIRST_PROMPT_SQL} AS first_prompt, ${sessions_PRESENTED_STARTED_AT} AS started_at,
  ${sessions_PRESENTED_ENDED_AT} AS ended_at, s.parent_session_id, s.parent_reason, s.launch_parent_session_id`;
const lineage_LIVE = lineage_import_notTombstonedSql('s');

/** The column that names each edge kind's parent. */
const lineage_PARENT_COLUMN: Record<lineage_LineageEdgeKind, 'launch_parent_session_id' | 'parent_session_id'> = {
  launched: 'launch_parent_session_id',
  continuation: 'parent_session_id',
};
/** The index each parent column's children are read through, named: it holds the parent and the child's id, so it supplies the order a bounded selection stops in. */
const lineage_CHILDREN_INDEX: Record<lineage_LineageEdgeKind, string> = {
  launched: 'idx_sessions_launch_parent',
  continuation: 'idx_sessions_parent',
};

/** A row's parents as edges, launch first. */
function lineage_parentEdges(row: lineage_Row): lineage_LineageEdge[] {
  return lineage_LINEAGE_EDGE_KINDS.flatMap((kind) => {
    const parentId = row[lineage_PARENT_COLUMN[kind]];
    return parentId === null || parentId === row.session_id ? [] : [{ parentId, childId: row.session_id, kind, reason: kind === 'continuation' ? row.parent_reason : null }];
  });
}

const lineage_byStart = (a: { startedAt: number | null; sessionId: string }, b: { startedAt: number | null; sessionId: string }): number =>
  (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);

/** The live sessions this Project holds among `ids`. */
async function lineage_sessionsNamed(db: lineage_import_RelationalStore, scope: lineage_import_ReadScope, ids: readonly string[]): Promise<lineage_Row[]> {
  const out: lineage_Row[] = [];
  for (const run of lineage_import_inListChunks(ids)) {
    const { results } = await prepareViewRead(db, "M18:lineage_sessionsNamed:0", `SELECT ${lineage_LINEAGE_COLUMNS} FROM sessions s
        WHERE s.project_id = ? AND s.session_id IN (${run.map(() => '?').join(', ')}) AND ${lineage_LIVE}`)
      .bind(scope.projectId, ...run).all<lineage_Row>();
    out.push(...results);
  }
  return out;
}

/**
 * The ids of at most `limit` live sessions of this Project whose `kind` parent is one of `ids`, in the index's own order
 * (parent, then child id), so the read stops at the limit whatever the family's size.
 */
async function lineage_childIdsOf(db: lineage_import_RelationalStore, scope: lineage_import_ReadScope, kind: lineage_LineageEdgeKind, ids: readonly string[], limit: number): Promise<string[]> {
  const out: string[] = [];
  const column = lineage_PARENT_COLUMN[kind];
  for (const run of lineage_import_inListChunks([...ids].sort())) {
    if (out.length >= limit) break;
    const { results } = await prepareViewRead(db, "M18:lineage_childIdsOf:0", `SELECT s.session_id FROM sessions s INDEXED BY ${lineage_CHILDREN_INDEX[kind]}
        WHERE s.project_id = ? AND s.${column} IN (${run.map(() => '?').join(', ')}) AND ${lineage_LIVE}
        ORDER BY s.${column}, s.session_id LIMIT ?`)
      .bind(scope.projectId, ...run, limit - out.length).all<{ session_id: string }>();
    out.push(...results.map((row) => row.session_id));
  }
  return out;
}

/**
 * The family of a session over both parent columns: up to its roots, then down from them, each step reading this
 * Project's live sessions alone. A parent named by a record but not held here is a node that is not captured, and the
 * walk goes no higher through it. Bounded at `LINEAGE_MAX_DEPTH` generations each way and `LINEAGE_MAX_NODES`
 * sessions; a session met again is not walked again, so a cycle in the records ends the walk. Null when the Project
 * does not hold the session.
 */
async function lineage_sessionLineage(db: lineage_import_RelationalStore, scope: lineage_import_ReadScope, sessionId: string): Promise<lineage_SessionLineage | null> {
  const [self] = await lineage_sessionsNamed(db, scope, [sessionId]);
  if (self === undefined) return null;
  const rows = new Map<string, lineage_Row>([[sessionId, self]]);
  const uncaptured = new Set<string>();
  const size = () => rows.size + uncaptured.size;
  let truncated = false;

  // Up: the parents of each generation, until none is named or held.
  let frontier = [self];
  for (let depth = 0; frontier.length > 0; depth += 1) {
    const named = [...new Set(frontier.flatMap(lineage_parentEdges).map((edge) => edge.parentId))]
      .filter((id) => !rows.has(id) && !uncaptured.has(id));
    if (named.length === 0) break;
    if (depth === lineage_LINEAGE_MAX_DEPTH || size() + named.length > lineage_LINEAGE_MAX_NODES) { truncated = true; break; }
    const found = await lineage_sessionsNamed(db, scope, named);
    for (const row of found) rows.set(row.session_id, row);
    for (const id of named) if (!rows.has(id)) uncaptured.add(id);
    frontier = found;
  }

  // Down: the children of each generation, from the sessions no edge in the lineage leads to. A session held from the
  // walk up is walked down too, once. Each generation selects child ids within the bound, then reads only the kept ones.
  const roots = lineage_rootsOf(rows, uncaptured, sessionId);
  const expanded = new Set<string>();
  let parents = roots;
  for (let depth = 0; parents.length > 0; depth += 1) {
    for (const id of parents) expanded.add(id);
    const found = new Set<string>();
    for (const kind of lineage_LINEAGE_EDGE_KINDS) {
      for (const id of await lineage_childIdsOf(db, scope, kind, parents, lineage_LINEAGE_MAX_NODES + 1)) found.add(id);
    }
    const fresh = [...found].filter((id) => !rows.has(id)).sort();
    if (depth === lineage_LINEAGE_MAX_DEPTH) { truncated ||= fresh.length > 0; break; }
    const room = lineage_LINEAGE_MAX_NODES - size();
    if (fresh.length > room) truncated = true;
    for (const row of await lineage_sessionsNamed(db, scope, fresh.slice(0, room))) rows.set(row.session_id, row);
    parents = [...found].filter((id) => rows.has(id) && !expanded.has(id));
  }

  const edges = [...rows.values()].flatMap(lineage_parentEdges).filter((edge) => rows.has(edge.parentId) || uncaptured.has(edge.parentId));
  return { nodes: lineage_placed(rows, uncaptured, edges, roots, sessionId), edges, truncated };
}

/** The sessions of the lineage no edge within it leads to. A lineage that is all cycle is rooted at the session read. */
function lineage_rootsOf(rows: ReadonlyMap<string, lineage_Row>, uncaptured: ReadonlySet<string>, sessionId: string): string[] {
  const held = (id: string) => rows.has(id) || uncaptured.has(id);
  const roots = [...uncaptured, ...[...rows.values()].filter((row) => !lineage_parentEdges(row).some((edge) => held(edge.parentId))).map((row) => row.session_id)];
  return roots.length === 0 ? [sessionId] : roots;
}

/** Each session placed once, under the first edge a breadth-first walk from the roots reaches it by, in tree order. */
function lineage_placed(rows: ReadonlyMap<string, lineage_Row>, uncaptured: ReadonlySet<string>, edges: readonly lineage_LineageEdge[], roots: readonly string[], sessionId: string): lineage_LineageNode[] {
  const node = (id: string, depth: number, placedUnder: lineage_LineageEdge | null): lineage_LineageNode => {
    const row = rows.get(id);
    return row === undefined
      ? { sessionId: id, captured: false, label: null, agent: null, startedAt: null, endedAt: null, depth, placedUnder, current: false }
      : {
        sessionId: id, captured: true, label: sessions_relatedSessionLabel(row.title, row.first_prompt, row.agent), agent: row.agent,
        startedAt: row.started_at, endedAt: row.ended_at, depth, placedUnder, current: id === sessionId,
      };
  };
  const childEdges = new Map<string, lineage_LineageEdge[]>();
  for (const edge of edges) childEdges.set(edge.parentId, [...childEdges.get(edge.parentId) ?? [], edge]);
  const under = new Map<string, lineage_LineageNode[]>();
  const seen = new Set<string>();
  const top = roots.map((id) => node(id, 0, null)).sort(lineage_byStart);
  for (const root of top) seen.add(root.sessionId);
  let level = top;
  while (level.length > 0) {
    const next: lineage_LineageNode[] = [];
    for (const parent of level) {
      const children: lineage_LineageNode[] = [];
      for (const edge of childEdges.get(parent.sessionId) ?? []) {
        if (seen.has(edge.childId)) continue;
        seen.add(edge.childId);
        children.push(node(edge.childId, parent.depth + 1, edge));
      }
      children.sort(lineage_byStart);
      under.set(parent.sessionId, children);
      next.push(...children);
    }
    level = next;
  }
  const out: lineage_LineageNode[] = [];
  const visit = (n: lineage_LineageNode) => { out.push(n); for (const child of under.get(n.sessionId) ?? []) visit(child); };
  for (const root of top) visit(root);
  return out;
}

/** One line of a project's recent activity: a session that started, a run that ran, a spore that landed. */
interface activity_FeedItem {
  type: 'session' | 'run' | 'spore';
  id: string;
  summary: string;
  at: number;
  /** The Myco session the item belongs to, when it has one. A run's provider session ref is not one. */
  sessionId: string | null;
}

const activity_DEFAULT_FEED = 20;
const activity_MAX_FEED = 100;

/**
 * The project's recent activity, newest first, across sessions, runs and active
 * spores in one statement. Each source is bounded to the page before the union
 * so the outer sort never scans a whole table, and the wrapped `SELECT * FROM (…)`
 * shape is what SQLite admits inside a compound select. A session line carries
 * the same label the session list shows; the other sources fill its columns with
 * NULL so the compound select stays uniform.
 */
async function activity_activityFeed(db: activity_import_RelationalStore, scope: activity_import_ReadScope, limit?: number): Promise<activity_FeedItem[]> {
  const n = limit === undefined || !Number.isSafeInteger(limit) || limit < 1 ? activity_DEFAULT_FEED : Math.min(limit, activity_MAX_FEED);
  const { results } = await prepareViewRead(db, "M19:activity_activityFeed:0", `SELECT * FROM (
        SELECT 'session' AS type, s.session_id AS id, '' AS summary,
               ${sessions_SESSION_OCCURRED_AT} AS at_ms, s.session_id AS session_id,
               s.title AS title, ${sessions_FIRST_PROMPT_SQL} AS first_prompt, s.agent AS agent
          FROM sessions s WHERE s.project_id = ? AND ${activity_import_notTombstonedSql('s')} ORDER BY at_ms DESC LIMIT ?)
      UNION ALL SELECT * FROM (
        SELECT 'run' AS type, id, COALESCE(task, 'run') || ' — ' || status AS summary,
               COALESCE(resumed_at, started_at, completed_at, queued_at) AS at_ms, NULL AS session_id, NULL AS title, NULL AS first_prompt, NULL AS agent
          FROM agent_runs WHERE project_id = ? AND COALESCE(resumed_at, started_at, completed_at, queued_at) IS NOT NULL ORDER BY at_ms DESC LIMIT ?)
      UNION ALL SELECT * FROM (
        SELECT 'spore' AS type, id, observation_type || ': ' || substr(content, 1, 80) AS summary,
               created_at AS at_ms, session_id, NULL AS title, NULL AS first_prompt, NULL AS agent
          FROM spores WHERE project_id = ? AND status = 'active' ORDER BY at_ms DESC LIMIT ?)
      ORDER BY at_ms DESC LIMIT ?`)
    .bind(scope.projectId, n, scope.projectId, n, scope.projectId, n, n)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    type: r.type as activity_FeedItem['type'],
    id: r.id as string,
    summary: r.type === 'session'
      ? sessions_sessionLabel((r.title as string | null) ?? null, (r.first_prompt as string | null) ?? null, (r.agent as string | null) ?? null, r.id as string)
      : r.summary as string,
    at: r.at_ms as number,
    sessionId: (r.session_id as string | null) ?? null,
  }));
}

/** Each tool source declares its stored classification, immutable order and structured filters. */
const session_activity_TOOL_SOURCES = [
  { type: 'failure', where: "t.success = 0 AND (t.result_reason = 'reported' OR t.result_reason IS NULL)", order: 't.created_at', id: 't.tool_call_id', tool: 't.tool_name', failed: 't.success = 0' },
  { type: 'no_result', where: "t.success = 0 AND t.result_reason IN ('no_result', 'pending_limit')", order: 't.created_at', id: 't.tool_call_id', tool: 't.tool_name', failed: 't.success = 0' },
] as const;

/** The columns every edge term selects: the edge, its order, and the related session `r` it names, which a left join leaves null. */
const session_activity_edgeColumns = (type: string, edge: string, related: string, at: string, reason: string): string =>
  `'${type}' AS type, '${edge}' AS edge, '${edge}:' || ${related} AS id, ${at} AS at, r.session_id AS related, r.title AS title,
    ${sessions_firstPromptSql('r')} AS first_prompt, r.agent AS agent, ${reason} AS reason`;

/**
 * Each edge source declares the sessions that stand in one parent relation to this one, each term binding the Project
 * and the session: a child it launched, at the child's start; a session that continues its conversation, at that
 * session's start; and the conversation it continues, at its own start.
 */
const session_activity_EDGE_SOURCES = [
  {
    type: 'child_session', terms: [
      `SELECT ${session_activity_edgeColumns('child_session', 'child', 'r.session_id', session_activity_import_occurredAt('r.'), 'NULL')}
      FROM sessions r INDEXED BY ${lineage_CHILDREN_INDEX.launched} WHERE r.project_id = ? AND r.launch_parent_session_id = ? AND ${session_activity_import_notTombstonedSql('r')}`,
    ]
  },
  {
    type: 'continuation', terms: [
      `SELECT ${session_activity_edgeColumns('continuation', 'continued_by', 'r.session_id', session_activity_import_occurredAt('r.'), 'r.parent_reason')}
      FROM sessions r INDEXED BY ${lineage_CHILDREN_INDEX.continuation} WHERE r.project_id = ? AND r.parent_session_id = ? AND ${session_activity_import_notTombstonedSql('r')}`,
      `SELECT ${session_activity_edgeColumns('continuation', 'continues', 's.parent_session_id', session_activity_import_occurredAt('s.'), 's.parent_reason')}
      FROM sessions s LEFT JOIN sessions r ON r.project_id = s.project_id AND r.session_id = s.parent_session_id AND ${session_activity_import_notTombstonedSql('r')}
      WHERE s.project_id = ? AND s.session_id = ? AND s.parent_session_id IS NOT NULL`,
    ]
  },
] as const;

type session_activity_EdgeKey = 'child' | 'continued_by' | 'continues';

const session_activity_SESSION_ACTIVITY_SOURCES = [...session_activity_TOOL_SOURCES, ...session_activity_EDGE_SOURCES] as const;

export const SESSION_ACTIVITY_TYPES = ['failure', 'no_result', 'child_session', 'continuation'] as const;
type session_activity_SessionActivityType = typeof SESSION_ACTIVITY_TYPES[number];

interface session_activity_SessionActivityRow {
  id: string;
  type: session_activity_SessionActivityType;
  title: string;
  detail: string;
  at: number;
  promptId: string | null;
  /** The tool a tool row records; null on a session row. */
  toolName: string | null;
  resultReason: session_activity_import_ToolResultReason | null;
  failed: boolean;
  /** The related session a session row opens; null on a tool row and for a session this Project does not hold. */
  sessionId: string | null;
  /** The related session's agent; null on a tool row. */
  agent: string | null;
}

interface session_activity_SessionActivityOptions {
  type?: session_activity_SessionActivityType;
  tool?: string;
  failed?: boolean;
  limit?: number;
  cursor?: string;
}

const session_activity_REASON_DETAILS: Readonly<Record<session_activity_import_ToolResultReason, string>> = {
  reported: 'Tool reported a failure',
  no_result: 'No result captured',
  pending_limit: 'Pending tool call limit reached',
};

const session_activity_EDGE_DETAILS: Readonly<Record<session_activity_EdgeKey, string>> = {
  child: 'Child of this session',
  continued_by: 'Continues this session’s conversation',
  continues: 'This session continues its conversation',
};

/** The title of a session row whose related session this Project does not hold. */
const session_activity_NOT_CAPTURED_TITLE = 'A session not captured here';

/** Stored tool outcomes and parent edges only; tool bodies and provider errors never enter this projection. */
async function session_activity_listSessionActivity(db: session_activity_import_RelationalStore, scope: session_activity_import_ReadScope, sessionId: string, opts: session_activity_SessionActivityOptions = {}): Promise<session_activity_import_Page<session_activity_SessionActivityRow> & { tools: string[] }> {
  const named = (source: { type: string }) => opts.type === undefined || source.type === opts.type;
  const toolSources = session_activity_TOOL_SOURCES.filter(named);
  const edgeSources = opts.tool !== undefined || opts.failed === true ? [] : session_activity_EDGE_SOURCES.filter(named);
  const limit = session_activity_import_keyset(opts, { order: 'at', id: 'id', direction: 'DESC' })?.limit;
  if (limit === undefined) throw new Error('malformed cursor');
  const rows = [
    ...toolSources.length === 0 ? [] : await session_activity_toolRows(db, scope, sessionId, toolSources, opts),
    ...edgeSources.length === 0 ? [] : await session_activity_edgeRows(db, scope, sessionId, edgeSources, opts),
  ].sort((a, b) => b.at - a.at || session_activity_import_binaryOrder(b.id, a.id)).slice(0, limit + 1);
  const tools = await prepareViewRead(db, "M20:session_activity_listSessionActivity:0", `SELECT DISTINCT t.tool_name FROM tool_calls t WHERE t.project_id = ? AND t.session_id = ?
    AND (${session_activity_TOOL_SOURCES.map(source => `(${source.where})`).join(' OR ')}) ORDER BY t.tool_name`)
    .bind(scope.projectId, sessionId).all<{ tool_name: string }>();
  return { ...session_activity_import_page(rows, limit, row => ({ createdAt: row.at, id: row.id })), tools: tools.results.map(row => row.tool_name) };
}

async function session_activity_toolRows(db: session_activity_import_RelationalStore, scope: session_activity_import_ReadScope, sessionId: string, sources: readonly typeof session_activity_TOOL_SOURCES[number][], opts: session_activity_SessionActivityOptions): Promise<session_activity_SessionActivityRow[]> {
  const source = sources[0]!;
  const paging = session_activity_import_keyset(opts, { order: source.order, id: source.id, direction: 'DESC' })!;
  const filters = [`(${sources.map(source => `(${source.where})`).join(' OR ')})`];
  const params: unknown[] = [scope.projectId, sessionId];
  if (opts.tool !== undefined) { filters.push(`${source.tool} = ?`); params.push(opts.tool); }
  if (opts.failed !== undefined) filters.push(opts.failed ? source.failed : `NOT (${source.failed})`);
  if (paging.where) { filters.push(paging.where); params.push(...paging.params); }
  const { results } = await prepareViewRead(db, "M20:session_activity_toolRows:0", `SELECT CASE ${sources.map(source => `WHEN ${source.where} THEN '${source.type}'`).join(' ')} END AS type,
      t.tool_call_id AS id, t.tool_name AS tool_name, t.result_reason AS result_reason, t.created_at AS at,
      ${hook_placement_placedHintSql({ project: 't.project_id', session: 't.session_id', prompt: 't.prompt_id' })} AS prompt_id
    FROM tool_calls t WHERE t.project_id = ? AND t.session_id = ? AND ${filters.join(' AND ')}
    ORDER BY ${source.order} DESC, ${source.id} DESC LIMIT ?`)
    .bind(...params, paging.limit + 1).all<{ type: session_activity_SessionActivityType; id: string; tool_name: string; result_reason: session_activity_import_ToolResultReason | null; at: number; prompt_id: string | null }>();
  return results.map((row): session_activity_SessionActivityRow => ({
    id: row.id, type: row.type, title: row.result_reason === null ? 'Tool call did not succeed' : row.tool_name,
    detail: [row.result_reason === null ? 'Reason not recorded' : session_activity_REASON_DETAILS[row.result_reason], row.prompt_id === null ? 'Not placed on a turn' : null].filter(Boolean).join(' · '),
    at: row.at, promptId: row.prompt_id, toolName: row.tool_name, resultReason: row.result_reason, failed: true, sessionId: null, agent: null,
  }));
}

/** One statement over every selected edge, ordered and paged as one list. */
async function session_activity_edgeRows(db: session_activity_import_RelationalStore, scope: session_activity_import_ReadScope, sessionId: string, sources: readonly typeof session_activity_EDGE_SOURCES[number][], opts: session_activity_SessionActivityOptions): Promise<session_activity_SessionActivityRow[]> {
  const paging = session_activity_import_keyset(opts, { order: 'e.at', id: 'e.id', direction: 'DESC' })!;
  const terms = sources.flatMap(source => source.terms);
  const { results } = await prepareViewRead(db, "M20:session_activity_edgeRows:0", `SELECT e.type, e.edge, e.id, e.at, e.related, e.title, e.first_prompt, e.agent, e.reason
    FROM (${terms.join(' UNION ALL ')}) e ${paging.where ? `WHERE ${paging.where}` : ''}
    ORDER BY e.at DESC, e.id DESC LIMIT ?`)
    .bind(...terms.flatMap(() => [scope.projectId, sessionId]), ...paging.params, paging.limit + 1)
    .all<{ type: session_activity_SessionActivityType; edge: session_activity_EdgeKey; id: string; at: number; related: string | null; title: string | null; first_prompt: string | null; agent: string | null; reason: string | null }>();
  return results.map((row): session_activity_SessionActivityRow => ({
    id: row.id, type: row.type, at: row.at,
    title: row.related === null ? session_activity_NOT_CAPTURED_TITLE : sessions_relatedSessionLabel(row.title, row.first_prompt, row.agent),
    detail: [session_activity_EDGE_DETAILS[row.edge], row.reason].filter(Boolean).join(' · '),
    promptId: null, toolName: null, resultReason: null, failed: false, sessionId: row.related, agent: row.agent,
  }));
}

/** The plan metadata a receipt retains, or the live metadata for an older receipt. */
interface injection_served_items_ServedPlan {
  planKey: string;
  title: string | null;
  sessionId: string | null;
  contentHash: string | null;
  unavailable: boolean;
}

/** Snapshots take precedence, including an explicit unavailable snapshot; older receipts use exact Project and plan keys. */
async function receiptPlans(
  db: injection_served_items_import_RelationalStore,
  scope: injection_served_items_import_ReadScope,
  receipts: readonly { receiptId: string; planIds: readonly string[] }[],
): Promise<Map<string, injection_served_items_ServedPlan[]>> {
  const out = new Map<string, injection_served_items_ServedPlan[]>(receipts.map(receipt => [receipt.receiptId, []]));
  for (const run of injection_served_items_import_inListChunks(receipts)) {
    const { results } = await prepareViewRead(db, "M47:receiptPlans:0", `SELECT json_extract(w.value, '$.receiptId') AS receipt_id,
        item.value AS item_id,
        CASE WHEN s.item_id IS NOT NULL THEN s.title ELSE p.title END AS title,
        CASE WHEN s.item_id IS NOT NULL THEN s.session_id ELSE p.session_id END AS session_id,
        CASE WHEN s.item_id IS NOT NULL THEN s.content_hash ELSE p.content_hash END AS content_hash,
        CASE WHEN s.item_id IS NOT NULL THEN s.unavailable ELSE p.plan_key IS NULL END AS unavailable
      FROM json_each(?) w CROSS JOIN json_each(json_extract(w.value, '$.planIds')) item
      LEFT JOIN injection_served_items s ON s.project_id = ? AND s.receipt_id = json_extract(w.value, '$.receiptId')
        AND s.kind = 'plan' AND s.item_id = item.value
      LEFT JOIN plans p ON s.item_id IS NULL AND p.project_id = ? AND p.plan_key = item.value
      WHERE s.item_id IS NOT NULL OR p.plan_key IS NOT NULL
      ORDER BY CAST(w.key AS INTEGER), CAST(item.key AS INTEGER)`)
      .bind(JSON.stringify(run), scope.projectId, scope.projectId)
      .all<{ receipt_id: string; item_id: string; title: string | null; session_id: string | null; content_hash: string | null; unavailable: number }>();
    for (const row of results) out.get(row.receipt_id)!.push({
      planKey: row.item_id, title: row.title, sessionId: row.session_id, contentHash: row.content_hash,
      unavailable: row.unavailable === 1,
    });
  }
  return out;
}

type processed_ProcessedBodyKind = keyof typeof processed_import_PROCESSED_FIELDS;
type processed_ProcessedTextKind = Exclude<processed_ProcessedBodyKind, 'attachment'>;

export interface processed_ProcessedField {
  text: string | null;
  blob_key: string | null;
  object_key: string | null;
  registered_size: number | null;
  total_bytes: number | null;
  media_type: string | null;
  admitted: number;
}

function processed_isProcessedBodyKind(kind: string): kind is processed_ProcessedBodyKind {
  return Object.hasOwn(processed_import_PROCESSED_FIELDS, kind);
}

/**
 * A session read as turns: each top-level prompt with what followed it — the
 * tool calls, responses, attachments and steering prompts that name it. The
 * dashboard's session page renders the list collapsed (a preview per turn) and
 * fetches one turn's body when it opens, so the list carries counts and a
 * preview, never a prompt's full text.
 */

/** How much of a prompt's inline text the list row carries. */
const turns_TURN_PREVIEW_CHARS = 160;
/** How many items each turn collection carries before its paged continuation. */
const turns_TURN_BODY_LIMIT = 50;
/** The origin the list shows when the caller names none: what a person typed. */
const turns_DEFAULT_ORIGINS: readonly string[] = ['user'];

interface turns_TurnRow {
  promptId: string;
  origin: string;
  promptKind: string | null;
  threadLabel: string | null;
  /** The opening of the inline text; null when the text spilled to a blob. */
  preview: string | null;
  /** The inline text's length in characters; null when it spilled. */
  textChars: number | null;
  blobKey: string | null;
  createdAt: number;
  toolCallCount: number;
  responseCount: number;
  /** Steering and interrupt prompts that name this one as their parent. */
  childCount: number;
  planCount: number;
  attachmentCount: number;
}

interface turns_TurnPrompt {
  promptId: string;
  origin: string;
  promptKind: string | null;
  parentPromptId: string | null;
  threadLabel: string | null;
  text: string | null;
  blobKey: string | null;
  createdAt: number;
}

interface turns_TurnChild {
  prompt: turns_TurnPrompt;
  responses: children_ResponseRow[];
  toolCallCount: number;
  responsesCursor: string | null;
  body: turns_TurnDetail;
  childCount: number;
}

interface turns_TurnDetail {
  prompt: turns_TurnPrompt;
  responses: children_ResponseRow[];
  attachments: children_AttachmentRow[];
  /** The plans this prompt produced, in immutable key order. */
  plans: children_PlanRow[];
  /** The context delivered to this prompt, with receipt snapshots for plans and retained spore previews; null when no receipt places here. */
  injection: (turns_import_PromptInjection & { planIds: string[]; plans: Array<{ planKey: string; title: string | null }> }) | null;
  metrics: turns_TurnMetrics;
  answers: turns_PromptAnswer[];
  children: turns_TurnChild[];
  cursors: Record<turns_TurnCollection, string | null>;
}

const turns_TURN_COLLECTIONS = ['responses', 'attachments', 'plans', 'children', 'answers'] as const;
type turns_TurnCollection = (typeof turns_TURN_COLLECTIONS)[number];

/** The origins a query names, or null when one is not an origin the wire admits. Absent means the default. */
function turns_parseOrigins(raw: string | null): readonly string[] | null {
  if (raw === null || raw === '') return turns_DEFAULT_ORIGINS;
  const names = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (names.length === 0) return null;
  const admitted = new Set<string>(turns_import_PROMPT_ORIGINS);
  return names.every((n) => admitted.has(n)) ? [...new Set(names)] : null;
}

const turns_PROMPT_COLUMNS = 'pb.prompt_id, pb.origin, pb.prompt_kind, pb.parent_prompt_id, pb.thread_label, pb.text, pb.blob_key, pb.created_at';

function turns_toPrompt(r: Record<string, unknown>): turns_TurnPrompt {
  return {
    promptId: r.prompt_id as string,
    origin: r.origin as string,
    promptKind: (r.prompt_kind as string | null) ?? null,
    parentPromptId: (r.parent_prompt_id as string | null) ?? null,
    threadLabel: (r.thread_label as string | null) ?? null,
    text: (r.text as string | null) ?? null,
    blobKey: (r.blob_key as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}

const turns_TOOL_CALL_COUNT = `(SELECT COUNT(*) FROM tool_calls t WHERE t.project_id = pb.project_id AND t.session_id = pb.session_id AND t.prompt_id = pb.prompt_id AND ${hook_placement_hookPlacementSql({ project: 't.project_id', session: 't.session_id', prompt: 't.prompt_id' })})`;
const turns_RESPONSE_COUNT = `(SELECT COUNT(*) FROM responses r WHERE r.project_id = pb.project_id AND r.prompt_id = pb.prompt_id)`;
const turns_PLAN_COUNT = `(SELECT COUNT(*) FROM plans p WHERE p.project_id = pb.project_id AND p.session_id = pb.session_id AND p.prompt_id = pb.prompt_id)`;
const turns_ATTACHMENT_COUNT = `(SELECT COUNT(*) FROM attachments a WHERE a.project_id = pb.project_id AND a.session_id = pb.session_id AND a.prompt_id = pb.prompt_id AND ${hook_placement_hookPlacementSql({ project: 'a.project_id', session: 'a.session_id', prompt: 'a.prompt_id' })})`;
const turns_CHILD_COUNT = `(SELECT COUNT(*) FROM prompt_batches c WHERE c.project_id = pb.project_id AND c.session_id = pb.session_id AND c.parent_prompt_id = pb.prompt_id)`;

function turns_steeringBodies(children: turns_import_Page<Record<string, unknown>>, bodies: Map<string, turns_TurnDetail>): turns_import_Page<turns_TurnChild> {
  const rows = children.rows.map(r => {
    const prompt = turns_toPrompt(r);
    const body = bodies.get(prompt.promptId)!;
    return {
      prompt, responses: body.responses, responsesCursor: body.cursors.responses,
      toolCallCount: r.tool_call_count as number, childCount: r.child_count as number, body
    };
  });
  return { cursor: children.cursor, rows };
}

interface turns_ToolUsage { toolName: string; count: number }
interface turns_TurnMetrics { tools: turns_ToolUsage[]; durationMs: number | null; tokens: null }
interface turns_PromptAnswer {
  id: string; createdAt: number; outcome: string; contextChars: number;
  parts: Array<{ kind: string; sporeCount?: number; planCount?: number }>;
  skipped: string[]; failures: Array<{ contributor: string; error: string; operation?: string }>;
  selection: Record<string, number>;
}
/** What a turn's prompt carried beyond its own answers: the sub-agent preambles prepared under it. */
interface turns_TurnContext { subagents: number }

/** Selection hints associate lookup diagnostics; receipt delivery places the served context. */
const turns_ANSWER_QUERY = {
  table: 'prompt_context_answers', promptHint: 'prompt_id', idColumn: 'id', orderColumn: 'created_at',
  columns: 'id, created_at, outcome, context_chars, parts, skipped, failures, selection',
  map: (r: Record<string, unknown>): turns_PromptAnswer => ({
    id: r.id as string, createdAt: r.created_at as number, outcome: r.outcome as string, contextChars: r.context_chars as number,
    parts: JSON.parse(r.parts as string), skipped: JSON.parse(r.skipped as string),
    failures: JSON.parse(r.failures as string), selection: JSON.parse(r.selection as string),
  }),
};

function turns_toolUsageSql(byPrompt: boolean, correlated = false): string {
  const project = correlated ? 'pb.project_id' : '?';
  const session = correlated ? 'pb.session_id' : '?';
  const prompt = correlated ? 'pb.prompt_id' : '?';
  return `SELECT tool_name, COUNT(*) AS n FROM tool_calls WHERE project_id = ${project} AND session_id = ${session} ${byPrompt ? 'AND prompt_id = ' + prompt + ' AND ' + hook_placement_hookPlacementSql({ project: 'tool_calls.project_id', session: 'tool_calls.session_id', prompt: 'tool_calls.prompt_id' }) : ''}
    GROUP BY +tool_name ORDER BY n DESC, tool_name ASC`;
}

function turns_retainedIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

export {
  type hook_placement_UnplacedHookRecord,
  hook_placement_listUnplacedHookRecords,
  hook_placement_HOOK_STATUS_WINDOW_DAYS,
  hook_placement_countUnplacedContextRecords,
  type plans_ProjectPlanRow,
  plans_WRITABLE_PLAN_STATUSES,
  plans_PLAN_STATUS_MESSAGE,
  plans_progressOf,
  plans_listProjectPlans,
  plans_pageProjectPlans,
  type plans_PlanAcrossRow,
  plans_pagePlansAcross,
  plans_planTotals,
  type plans_ProjectPlanSummary,
  plans_getPlan,
  plans_planInSession,
  type sessions_ProjectRow,
  type sessions_SessionRow,
  type sessions_ProjectStats,
  type sessions_SessionCounts,
  sessions_FIRST_PROMPT_CHARS,
  sessions_LABEL_MAX_CHARS,
  sessions_UNTITLED_SESSION_LABEL,
  sessions_sessionLabel,
  sessions_relatedSessionLabel,
  sessions_PRESENTED_STARTED_AT,
  sessions_PRESENTED_ENDED_AT,
  sessions_SESSIONS_ACROSS_INDEX,
  sessions_SESSIONS_ACTIVE_INDEX,
  sessions_SESSIONS_WORKING_INDEX,
  sessions_WORKING_CAP_MS,
  sessions_listProjectsSql,
  sessions_listProjects,
  type sessions_ArchiveOutcome,
  type sessions_UnarchiveOutcome,
  type sessions_SessionFilters,
  sessions_SESSION_OCCURRED_AT,
  sessions_listSessions,
  sessions_listSessionsAcross,
  sessions_getSession,
  sessions_sessionDurationMs,
  type sessions_SessionLifecycle,
  sessions_sessionLifecycle,
  sessions_sessionCounts,
  sessions_sessionCountsFor,
  sessions_ACTIVITY_BUCKETS,
  type sessions_SessionSummaryRow,
  sessions_bucketActivity,
  sessions_listSessionSummaries,
  type sessions_SessionAcrossRow,
  sessions_listSessionSummariesAcross,
  sessions_projectStats,
  sessions_projectExists,
  sessions_existingProjects,
  sessions_sessionInScope,
  sessions_sessionHeldByMachine,
  sessions_projectHoldsSession,
  sessions_sessionCarriesTitle,
  sessions_heldSessionIds,
  sessions_sessionsOwnedByImporter,
  sessions_sessionsWithImportedPrompts,
  type children_ChildOptions,
  type children_PromptRow,
  type children_ToolCallRow,
  type children_ResponseRow,
  type children_PlanRow,
  type children_AttachmentRow,
  type children_ContextInjectionRow,
  children_SESSION_ANSWER_KIND_PREFIX,
  type children_PagingOptions,
  children_listPrompts,
  children_listContextInjections,
  children_listToolCalls,
  children_listResponses,
  type children_PlanChildOptions,
  children_listPlans,
  children_listAttachments,
  type children_MaterialRow,
  children_listReadyTitleSessions,
  type children_TitleCandidate,
  type children_TitleCandidateWindow,
  type children_TitleCandidates,
  children_listTitleCandidates,
  children_countConvergenceTitleSessions,
  type children_UntitledReason,
  children_untitledReason,
  children_sessionMaterialRows,
  children_sessionMaterialTailRows,
  lineage_LINEAGE_MAX_DEPTH,
  lineage_LINEAGE_MAX_NODES,
  lineage_LINEAGE_EDGE_KINDS,
  type lineage_LineageEdgeKind,
  type lineage_LineageEdge,
  type lineage_LineageNode,
  type lineage_SessionLineage,
  lineage_CHILDREN_INDEX,
  lineage_sessionLineage,
  type activity_FeedItem,
  activity_DEFAULT_FEED,
  activity_MAX_FEED,
  activity_activityFeed,
  type session_activity_SessionActivityType,
  type session_activity_SessionActivityRow,
  type session_activity_SessionActivityOptions,
  session_activity_NOT_CAPTURED_TITLE,
  session_activity_listSessionActivity,
  type injection_served_items_ServedPlan,
  receiptPlans,
  type processed_ProcessedBodyKind,
  type processed_ProcessedTextKind,
  processed_isProcessedBodyKind,
  turns_TURN_PREVIEW_CHARS,
  turns_TURN_BODY_LIMIT,
  turns_DEFAULT_ORIGINS,
  type turns_TurnRow,
  type turns_TurnPrompt,
  type turns_TurnChild,
  type turns_TurnDetail,
  turns_TURN_COLLECTIONS,
  type turns_TurnCollection,
  turns_parseOrigins,
  turns_listTurns,
  turns_promptInSession,
  turns_turnDetail,
  turns_listSteeringChildren,
  turns_turnCollection,
  type turns_ToolUsage,
  type turns_TurnMetrics,
  type turns_PromptAnswer,
  type turns_TurnContext,
  turns_toolUsage,
  turns_sessionTurnContexts,
};

interface embedding_EmbeddingSource extends embedding_import_VectorMetadata {
  project_id: string;
  namespace: string;
  title: string;
  text: string;
  blob_key: string | null;
  prompt_id: string | null;
}
interface embedding_SemanticSearch {
  provider: embedding_import_EmbeddingProvider;
  vectors: embedding_import_VectorStore;
}
interface embedding_SemanticHit extends embedding_EmbeddingSource { vector_id: string; score: number; neighbor_mean: number | null; neighbor_std: number | null }
const embedding_MIN_SEARCH_SIMILARITY = 0.3;

interface embedding_SemanticHitCounts { rawMatches: number; joinedHits: number; filteredHits: number }

interface embedding_SemanticHitOptions {
  topK: number;
  minScore?: number;
  filters?: embedding_import_VectorFilters;
  preview?: boolean;
  observe?: (counts: embedding_SemanticHitCounts) => void;
  during?: <T>(operation: 'vector' | 'sql', work: () => Promise<T>) => Promise<T>;
}

/** A bounded character prefix, including embedded NULs; blob slicing advances past each NUL. */
function embedding_previewSql(text: string): string {
  return `(WITH RECURSIVE chunks(prefix, rest, remaining) AS (
    SELECT '', ${text}, ${embedding_import_SEARCH_PREVIEW_CHARS}
    UNION ALL SELECT prefix || substr(rest, 1, remaining) || char(0),
      CAST(substr(CAST(rest AS BLOB), instr(CAST(rest AS BLOB), x'00') + 1) AS TEXT),
      remaining - length(substr(rest, 1, remaining)) - 1
    FROM chunks WHERE remaining > 0 AND instr(CAST(rest AS BLOB), x'00') > 0
      AND length(substr(rest, 1, remaining)) < remaining
  ) SELECT prefix || substr(rest, 1, remaining) FROM chunks
    WHERE remaining = 0 OR instr(CAST(rest AS BLOB), x'00') = 0
      OR length(substr(rest, 1, remaining)) = remaining LIMIT 1)`;
}

/** Receipt ids drive every source lookup; CROSS JOIN preserves that indexed order. */
function embedding_hitHydrationSql(ids: readonly string[], preview: boolean): string {
  const branches = embedding_import_CURRENT_EMBEDDING_SOURCES.map((source) => `SELECT s.*, v.revision,
    ${embedding_import_EMBEDDING_RELEASE_COLUMNS},
    r.id AS vector_id, r.neighbor_mean, r.neighbor_std
    FROM hits r CROSS JOIN (${embedding_import_embeddingSourceSelect(source, preview ? embedding_previewSql(source.text) : "''")}) s
    CROSS JOIN embedding_versions v
    WHERE r.type = '${source.type}' AND s.project_id = r.project_id AND s.record_id = r.record_id
      AND v.project_id = r.project_id AND v.type = r.type AND v.record_id = r.record_id AND v.revision = r.revision
      ${source.type === 'session' ? `AND ${embedding_import_notTombstonedSql('s')}` : ''}`);
  return `WITH hits AS MATERIALIZED (SELECT * FROM embedding_receipts
    WHERE project_id = ? AND model_key = ? AND ready = 1 AND id IN (${ids.map(() => '?').join(',')}))
    ${branches.join(' UNION ALL ')}`;
}

/** A vector is readable only while its source revision is still eligible in the same project. */
async function embedding_semanticHits(db: embedding_import_RelationalStore, scope: embedding_import_ReadScope, semantic: embedding_SemanticSearch, values: number[], options: embedding_SemanticHitOptions): Promise<embedding_SemanticHit[]> {
  const partition = { projectId: scope.projectId, modelKey: semantic.provider.modelKey };
  const { observe, preview = false, during = <T>(_operation: 'vector' | 'sql', work: () => Promise<T>) => work(), ...queryOptions } = options;
  const hits = await during('vector', () => semantic.vectors.query(partition, { values, ...queryOptions }));
  observe?.({ rawMatches: hits.length, joinedHits: 0, filteredHits: 0 });
  const byId = new Map(hits.map((h) => [h.id, h.score]));
  const rows: embedding_SemanticHit[] = [];
  let joinedHits = 0;
  await during('sql', () => embedding_import_settledAll(embedding_import_inListChunks(hits.map((h) => h.id)).map(async (ids) => {
    const found = await prepareViewRead(db, "M29:embedding_semanticHits:0", embedding_hitHydrationSql(ids, preview))
      .bind(scope.projectId, partition.modelKey, ...ids).all<Omit<embedding_SemanticHit, 'score'>>();
    joinedHits += found.results.length;
    rows.push(...found.results.filter((r) => embedding_import_vectorMatches(r, options.filters)).map((r) => ({ ...r, score: byId.get(r.vector_id)! })));
    observe?.({ rawMatches: hits.length, joinedHits, filteredHits: rows.length });
  })));
  return rows.sort((a, b) => b.score - a.score || a.vector_id.localeCompare(b.vector_id));
}

/** Semantic queries use the same metadata filters as full-text queries. */
async function embedding_semanticSearch(db: embedding_import_RelationalStore, scope: embedding_import_ReadScope, semantic: embedding_SemanticSearch, types: readonly string[], options: embedding_import_SearchOptions, limit: number): Promise<embedding_import_SearchResult[]> {
  const values = await semantic.provider.embed(options.query);
  const filters: embedding_import_VectorFilters = {};
  for (const key of ['status', 'session_id', 'observation_type', 'release_state', 'release_confidence'] as const) {
    if (options[key] !== undefined) filters[key] = options[key];
  }
  if (options.since !== undefined || options.until !== undefined) filters.created_at = {
    ...(options.since === undefined ? {} : { gte: options.since * 1000 }),
    ...(options.until === undefined ? {} : { lte: options.until * 1000 }),
  };
  const retained = types.filter((t): t is embedding_import_VectorType => (embedding_import_VECTOR_TYPES as readonly string[]).includes(t));
  const branches = await Promise.all(retained.map((type) => embedding_semanticHits(db, scope, semantic, values,
    { topK: embedding_import_VECTOR_QUERY_LIMIT, minScore: embedding_MIN_SEARCH_SIMILARITY, filters: { ...filters, type }, preview: true })));
  const tools: Partial<Record<embedding_import_VectorType, string>> = { session: 'myco_sessions', spore: 'myco_spores', plan: 'myco_plans' };
  return branches.flat().sort((a, b) => b.score - a.score || a.vector_id.localeCompare(b.vector_id)).slice(0, limit).map((row) => {
    const tool = tools[row.type];
    return {
      id: row.record_id, type: row.type, title: row.title, preview: row.text.slice(0, embedding_import_SEARCH_PREVIEW_CHARS), score: row.score, created_at: row.created_at,
      ...(row.session_id === '' ? {} : { session_id: row.session_id }),
      ...(row.prompt_id === null ? {} : { prompt_id: row.prompt_id }),
      ...(tool === undefined ? {} : { retrieve: { tool, input: { op: 'get', id: row.record_id } } }),
    };
  });
}

/** Historical flags and durable record acknowledgements each have an indexed existence probe. */
const extraction_coverage_ACKNOWLEDGED_PROMPTS_SQL = `SELECT 1 AS found WHERE EXISTS (
    SELECT 1 FROM prompt_batches p WHERE p.project_id = ? AND p.processed = 1
      AND p.origin IN (${extraction_coverage_import_READ_ORIGINS.map(origin => `'${origin}'`).join(',')}) LIMIT 1)
    OR EXISTS (SELECT 1 FROM extraction_acks a JOIN prompt_batches p
      ON p.project_id = a.project_id AND p.prompt_id = a.record_id
      WHERE a.project_id = ? AND a.kind = 'record'
        AND p.origin IN (${extraction_coverage_import_READ_ORIGINS.map(origin => `'${origin}'`).join(',')}) LIMIT 1)`;

async function extraction_coverage_hasAcknowledgedPrompts(db: extraction_coverage_import_RelationalStore, scope: extraction_coverage_import_ReadScope): Promise<boolean> {
  return await prepareViewRead(db, "M40:extraction_coverage_hasAcknowledgedPrompts:0", extraction_coverage_ACKNOWLEDGED_PROMPTS_SQL)
    .bind(scope.projectId, scope.projectId).first() !== null;
}

/**
 * The measures the Deployment reports about itself, each with the sample
 * behind it.
 *
 * Every measure here is derived from rows the Deployment already holds — prompts,
 * the records naming what they were served, tool calls, sessions, and credential
 * lineages. Nothing is estimated and nothing is configured: a measure with no
 * rows behind it answers a null value and a sample size of zero, and the surface
 * renders that as an absent sample rather than as a number.
 *
 * `sampleSize` travels with every value as one type. A share of 1.0 over two
 * prompts and a share of 1.0 over two thousand are different claims, and a shape
 * that can carry the first without the second invites a page showing a figure
 * nobody can weigh. The pair is the unit of measurement here, so a tile cannot
 * render one half of it.
 *
 * Measures are Deployment-wide rather than per Project. The time
 * from a machine joining to its first served context and recall quality are
 * properties of the Deployment's credential lineages and of the release it runs,
 * not of one Project, and splitting the page by Project would leave those two answering a
 * different question from the other measures.
 */

/** The agents this build declares a prompt identity for: a transcript of one left unpinned is a scheme conflict. */
const kpis_DECLARED_AGENTS: readonly string[] = kpis_import_CAPTURE_RULE_BUNDLES.map((bundle) => bundle.name);

/** A measured value and the number of rows behind it. A sample of zero carries a null value. */
interface kpis_Measure {
  value: number | null;
  sampleSize: number;
}

/**
 * One harness's diagnostic rate, named by the harness the session's transcript
 * reports, carrying the call count as well as the rate.
 *
 * The count travels with the rate so the parts account for the whole. A harness
 * whose calls land inside the window while its prompts land outside it has a rate
 * of nothing and a call count of several, and a reader adding up rates alone would
 * come up short against the figure the split sits under.
 */
interface kpis_HarnessMeasure extends kpis_Measure {
  harness: string;
  calls: number;
}

interface kpis_KpiReport {
  /** The trailing window in days, or null when every row counts. */
  windowDays: number | null;
  /** The earliest stamp a row may carry to be counted, or null for all of them. */
  since: number | null;
  /** Prompts in the window with a placed delivery. */
  promptsServed: number;
  /** Receipts delivered in the window, split by whether their delivery hint places them. */
  deliveries: { placed: number; unplaced: number };
  /** Prompts served as a share of prompts in the window. */
  servedShare: kpis_Measure;
  /** Prompts that received at least one observation, as a share of every prompt. */
  sporeServeRate: kpis_Measure;
  /** Sessions served a session start block, as a share of every session. */
  sessionStartPresent: kpis_Measure;
  /** Myco tool calls per prompt across the Deployment, with the per-harness split behind it. */
  callsPerPrompt: kpis_Measure;
  callsPerPromptByHarness: kpis_HarnessMeasure[];
  /** Plan reads per session. */
  planReadsPerSession: kpis_Measure;
  /** Median milliseconds from a machine's credential lineage starting to the first context served into one of its sessions. */
  firstInjectionMs: kpis_Measure;
  /**
   * Recall quality: how well this release's prompt-time injection serves the recall gold set, the mean over its
   * cases of a graded score. Recorded by CI against real prompts on both front doors and committed with the release
   * (`evals/recall-baseline.ts`, #1154); the window does not apply, and the sample is the number of cases.
   */
  recallQuality: kpis_Measure;
  /**
   * Per harness, what its transcripts' parse kept without naming it the usual way: counts, never links. `sampleSize`
   * is the prompts parsed under a scheme that records where each prompt's identity comes from.
   */
  promptIdentity: kpis_PromptIdentityCounts[];
}

/** One harness's prompt identity counts over the window (`KpiReport.promptIdentity`). */
interface kpis_PromptIdentityCounts {
  harness: string;
  sampleSize: number;
  /** A line of a shape the parse does not know, or a turn opener whose fields name no known class. */
  unrecognized: number;
  /** A record that claimed a key carrying none of the fields that name who opened a turn. */
  unmarked: number;
  /** A turn opener whose fields name two different classes. */
  openerConflict: number;
  /** A record whose fields contradict how its transcript is registered (a delegated agent's or the session's own). */
  contractViolation: number;
  /** A later submission that reused a key an earlier one owns. */
  reused: number;
  /** A prompt id a second source tried to name, refused (`prompt_identity_conflicts`). */
  identityConflicts: number;
  /** A transcript left unpinned, and so not read: its session's transcripts need two schemes. */
  schemeConflicts: number;
  /** A session whose transcripts of this agent hold two schemes between them, pinned before one admission rule applied. */
  mixedSchemeSessions: number;
  /** A context answer whose receipt is skipped: another receipt already names its prompt id. */
  duplicatePromptSkips: number;
}

/** The windows the surface offers. `null` is every row the Deployment holds. */
const kpis_KPI_WINDOWS: readonly number[] = [7, 30, 90];

/** The window a caller asked for, or null for all of them; anything that is not one of the offered windows reads as all. */
function kpis_kpiWindow(raw: string | null): number | null {
  if (raw === null || raw === 'all') return null;
  const days = Number(raw);
  return kpis_KPI_WINDOWS.includes(days) ? days : null;
}

/** A share over a sample, or a null value for an empty one. */
const kpis_share = (numerator: number, sampleSize: number): kpis_Measure =>
  ({ value: sampleSize === 0 ? null : numerator / sampleSize, sampleSize });

/** A rate over a sample, or a null value for an empty one. */
const kpis_rate = kpis_share;

/** The middle value of an ordered set, averaging the two middles of an even one. */
function kpis_median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The harness behind a prompt or a tool call, as a correlated subquery over the
 * session's primary transcript.
 *
 * A subquery rather than a join: a session may hold more than one transcript row,
 * and a join would count one prompt once per row. The oldest primary transcript
 * is the session's own, and a session whose transcript never arrived reads as
 * `unrecorded` rather than being dropped from the split.
 */
const kpis_HARNESS_OF = (alias: string): string => `COALESCE((
  SELECT t.agent FROM transcripts t
   WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id AND t.role = 'primary'
   ORDER BY t.first_received_at LIMIT 1), 'unrecorded')`;

/** A `created_at >= ?` clause for the window, or an always-true one for all rows. */
const kpis_windowClause = (column: string, since: number | null): { sql: string; params: number[] } =>
  since === null ? { sql: '1 = 1', params: [] } : { sql: `${column} >= ?`, params: [since] };

const kpis_countOf = async (db: kpis_import_RelationalStore, sql: string, params: readonly unknown[]): Promise<number> => {
  const row = await prepareViewRead(db, "M42:kpis_countOf:0", sql).bind(...params).first<{ n: number }>();
  return row?.n ?? 0;
};

/**
 * Prompts that received context the Deployment prepared: a receipt, or the session's plan nudge, whose delivery named
 * the prompt. These are the durable records of what a served answer carried, so the count outlives the answers'
 * retention. A selection never delivered, a delivery to a prompt that has no name, and a member that reports no
 * deliveries count for no prompt. A session's start block is a session's, counted over sessions
 * (`SESSIONS_STARTED_WITH_BLOCK`).
 */
const kpis_SERVED_PROMPTS = `
  EXISTS (SELECT 1 FROM spore_injections i
           WHERE i.project_id = p.project_id AND i.session_id = p.session_id AND i.delivered_prompt_id = p.prompt_id AND ${hook_placement_hookPlacementSql({ project: 'i.project_id', session: 'i.session_id', prompt: 'i.delivered_prompt_id' })} AND i.delivered_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM session_injections j
              WHERE j.project_id = p.project_id AND j.session_id = p.session_id AND j.kind = 'plan-nudge'
                AND j.delivered_prompt_id = p.prompt_id AND ${hook_placement_hookPlacementSql({ project: 'j.project_id', session: 'j.session_id', prompt: 'j.delivered_prompt_id' })} AND j.delivered_at IS NOT NULL)`;

/** Sessions the Deployment served a session start block. */
const kpis_SESSIONS_STARTED_WITH_BLOCK = `EXISTS (SELECT 1 FROM session_injections j
  WHERE j.project_id = sessions.project_id AND j.session_id = sessions.session_id AND j.kind = 'cortex')`;

/** The tool calls that count as reaching Myco at all. */
const kpis_MYCO_CALL = `c.myco_tool IS NOT NULL`;

/**
 * The plan calls that read.
 *
 * An allow-list, not a deny-list. `myco_plans` today reads under `list` and `get`
 * and writes under `save` and `delete`; naming what reads means a write op added
 * later is counted by nobody, where naming what writes would have every new op
 * counted as a read until someone remembered this line. The absent op is the
 * tool's own default, which is `list`.
 */
const kpis_PLAN_READ = `c.myco_tool = 'myco_plans' AND (c.myco_op IS NULL OR c.myco_op IN ('list', 'get'))`;

/** Prompts and the served share of them. */
async function kpis_promptMeasures(db: kpis_import_RelationalStore, since: number | null): Promise<{ prompts: number; served: number; withSpores: number }> {
  const w = kpis_windowClause('p.created_at', since);
  const [prompts, served, withSpores] = await Promise.all([
    kpis_countOf(db, `SELECT COUNT(*) AS n FROM prompt_batches p WHERE ${w.sql}`, w.params),
    kpis_countOf(db, `SELECT COUNT(*) AS n FROM prompt_batches p WHERE ${w.sql} AND (${kpis_SERVED_PROMPTS})`, w.params),
    kpis_countOf(db, `SELECT COUNT(*) AS n FROM prompt_batches p
                  WHERE ${w.sql} AND EXISTS (
                    SELECT 1 FROM spore_injections i
                     WHERE i.project_id = p.project_id AND i.session_id = p.session_id
                       AND i.delivered_prompt_id = p.prompt_id AND ${hook_placement_hookPlacementSql({ project: 'i.project_id', session: 'i.session_id', prompt: 'i.delivered_prompt_id' })} AND i.delivered_at IS NOT NULL AND i.spore_ids <> '[]')`, w.params),
  ]);
  return { prompts, served, withSpores };
}

/** Receipts use their delivery instant for the window and their delivery hint for placement. */
async function kpis_deliveryMeasures(db: kpis_import_RelationalStore, since: number | null): Promise<kpis_KpiReport['deliveries']> {
  const w = kpis_windowClause('i.delivered_at', since);
  const placed = hook_placement_hookPlacementSql({ project: 'i.project_id', session: 'i.session_id', prompt: 'i.delivered_prompt_id' });
  const row = await prepareViewRead(db, "M42:kpis_deliveryMeasures:0", `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ${placed} THEN 1 ELSE 0 END), 0) AS placed
    FROM spore_injections i WHERE i.delivered_at IS NOT NULL AND ${w.sql}`)
    .bind(...w.params).first<{ total: number; placed: number }>();
  return { placed: row?.placed ?? 0, unplaced: (row?.total ?? 0) - (row?.placed ?? 0) };
}

/**
 * Myco calls and prompts, split by the harness each session ran under.
 *
 * The harnesses are the union of the two sides, not the prompt side alone. A
 * harness whose calls land inside the window while its prompts land outside it
 * has calls counted in the whole and would have them counted in no part, leaving
 * the split unable to account for the figure above it. Such a harness takes a row
 * with an empty sample, which the surface renders as no value — the same rule the
 * page applies everywhere else.
 */
async function kpis_harnessSplit(db: kpis_import_RelationalStore, since: number | null): Promise<kpis_HarnessMeasure[]> {
  const prompts = kpis_windowClause('p.created_at', since);
  const calls = kpis_windowClause('c.created_at', since);
  const [promptRows, callRows] = await Promise.all([
    prepareViewRead(db, "M42:kpis_harnessSplit:0", `SELECT ${kpis_HARNESS_OF('p')} AS harness, COUNT(*) AS n FROM prompt_batches p WHERE ${prompts.sql} GROUP BY harness`)
      .bind(...prompts.params).all<{ harness: string; n: number }>(),
    prepareViewRead(db, "M42:kpis_harnessSplit:1", `SELECT ${kpis_HARNESS_OF('c')} AS harness, COUNT(*) AS n FROM tool_calls c WHERE ${calls.sql} AND ${kpis_MYCO_CALL} GROUP BY harness`)
      .bind(...calls.params).all<{ harness: string; n: number }>(),
  ]);
  const promptsBy = new Map(promptRows.results.map((r) => [r.harness, r.n]));
  const callsBy = new Map(callRows.results.map((r) => [r.harness, r.n]));
  return [...new Set([...promptsBy.keys(), ...callsBy.keys()])]
    .map((harness) => ({ harness, calls: callsBy.get(harness) ?? 0, ...kpis_rate(callsBy.get(harness) ?? 0, promptsBy.get(harness) ?? 0) }))
    .sort((a, b) => b.sampleSize - a.sampleSize || b.calls - a.calls || a.harness.localeCompare(b.harness));
}

/**
 * Milliseconds from each credential lineage starting to the first context served
 * into one of its sessions.
 *
 * Grouped by `lineage_root` rather than by credential id: a machine refreshes its
 * credential on a schedule, and counting each refresh as a fresh install would
 * report the refresh interval instead of the time a person waited. A lineage whose
 * sessions have been served nothing yet contributes no row, so the sample counts
 * lineages that reached a first injection rather than every lineage that exists.
 *
 * The window selects on when a lineage STARTED, so a trailing window measures the
 * machines that joined inside it. A span that comes out negative — an injection
 * stamped ahead of the lineage that produced it, which two clocks can disagree
 * enough to write — is dropped rather than counted as an instant arrival; the
 * sample size shrinks with it, which is what the surface renders.
 */
async function kpis_firstInjectionSamples(db: kpis_import_RelationalStore, since: number | null): Promise<number[]> {
  const w = kpis_windowClause('c.lineage_started_at', since);
  const { results } = await prepareViewRead(db, "M43:kpis_firstInjectionSamples:0", `SELECT c.lineage_root AS lineage, MIN(c.lineage_started_at) AS started,
                     MIN((SELECT MIN(x.created_at) FROM (
                            SELECT i.created_at, i.project_id, i.session_id FROM spore_injections i
                            UNION ALL
                            SELECT s.created_at, s.project_id, s.session_id FROM session_injections s) x
                          WHERE x.project_id = sess.project_id AND x.session_id = sess.session_id)) AS first_served
                FROM member_credentials c
                JOIN sessions sess ON sess.created_by_token_id = c.id
               WHERE ${w.sql}
               GROUP BY c.lineage_root`)
    .bind(...w.params)
    .all<{ lineage: string; started: number; first_served: number | null }>();
  return results
    .flatMap((r) => (r.first_served === null ? [] : [r.first_served - r.started]))
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);
}

const kpis_IDENTITY_KINDS = { unrecognized: 'unrecognized', unmarked: 'unmarked', openerConflict: 'opener_conflict', contractViolation: 'contract_violation' } as const;

/** The prompt identity counts per harness (`KpiReport.promptIdentity`), each a count over stored rows. */
async function kpis_promptIdentityCounts(db: kpis_import_RelationalStore, since: number | null): Promise<kpis_PromptIdentityCounts[]> {
  const claimed = kpis_windowClause('p.created_at', since);
  const refused = kpis_windowClause('c.created_at', since);
  const answered = kpis_windowClause('a.created_at', since);
  const registered = kpis_windowClause('t.first_received_at', since);
  const kinds = Object.values(kpis_IDENTITY_KINDS).map((kind) => `SUM(p.prompt_kind = '${kind}') AS "${kind}"`).join(', ');
  const [rows, conflicts, unpinned, duplicates, mixed] = await Promise.all([
    prepareViewRead(db, "M43:kpis_promptIdentityCounts:0", `SELECT ${kpis_HARNESS_OF('p')} AS harness, COUNT(*) AS n, ${kinds}, SUM(p.claim = 'reused') AS reused
        FROM projects pr CROSS JOIN prompt_batches p WHERE p.project_id = pr.project_id AND p.claim IS NOT NULL AND ${claimed.sql} GROUP BY harness`)
      .bind(...claimed.params).all<Record<string, number | string>>(),
    prepareViewRead(db, "M43:kpis_promptIdentityCounts:1", `SELECT ${kpis_HARNESS_OF('c')} AS harness, COUNT(*) AS n FROM projects pr CROSS JOIN prompt_identity_conflicts c
        WHERE c.project_id = pr.project_id AND ${refused.sql} GROUP BY harness`).bind(...refused.params).all<{ harness: string; n: number }>(),
    prepareViewRead(db, "M43:kpis_promptIdentityCounts:2", `SELECT t.agent AS harness, COUNT(*) AS n FROM transcripts t WHERE t.prompt_identity_scheme IS NULL
        AND t.agent IN (${kpis_DECLARED_AGENTS.map(() => '?').join(', ')}) AND ${registered.sql} GROUP BY t.agent`)
      .bind(...kpis_DECLARED_AGENTS, ...registered.params).all<{ harness: string; n: number }>(),
    prepareViewRead(db, "M43:kpis_promptIdentityCounts:3", `SELECT ${kpis_HARNESS_OF('a')} AS harness, COUNT(*) AS n FROM prompt_context_answers a
        WHERE ${answered.sql} AND EXISTS (SELECT 1 FROM json_each(a.skipped) j WHERE j.value = 'spores:duplicate_prompt') GROUP BY harness`)
      .bind(...answered.params).all<{ harness: string; n: number }>(),
    prepareViewRead(db, "M43:kpis_promptIdentityCounts:4", `SELECT agent AS harness, COUNT(*) AS n FROM (SELECT t.agent AS agent FROM transcripts t
        WHERE t.agent IN (${kpis_DECLARED_AGENTS.map(() => '?').join(', ')}) AND t.prompt_identity_scheme IS NOT NULL AND ${registered.sql}
        GROUP BY t.project_id, t.session_id, t.agent HAVING COUNT(DISTINCT t.prompt_identity_scheme) > 1) GROUP BY agent`)
      .bind(...kpis_DECLARED_AGENTS, ...registered.params).all<{ harness: string; n: number }>(),
  ]);
  const byHarness = new Map<string, kpis_PromptIdentityCounts>();
  const of = (harness: string): kpis_PromptIdentityCounts => {
    let counts = byHarness.get(harness);
    if (counts === undefined) {
      counts = { harness, sampleSize: 0, unrecognized: 0, unmarked: 0, openerConflict: 0, contractViolation: 0, reused: 0, identityConflicts: 0, schemeConflicts: 0, mixedSchemeSessions: 0, duplicatePromptSkips: 0 };
      byHarness.set(harness, counts);
    }
    return counts;
  };
  for (const row of rows.results) {
    const counts = of(String(row.harness));
    counts.sampleSize = Number(row.n);
    counts.reused = Number(row.reused ?? 0);
    for (const [field, kind] of Object.entries(kpis_IDENTITY_KINDS)) counts[field as keyof typeof kpis_IDENTITY_KINDS] = Number(row[kind] ?? 0);
  }
  for (const row of conflicts.results) of(row.harness).identityConflicts = row.n;
  for (const row of unpinned.results) of(row.harness).schemeConflicts = row.n;
  for (const row of duplicates.results) of(row.harness).duplicatePromptSkips = row.n;
  for (const row of mixed.results) of(row.harness).mixedSchemeSessions = row.n;
  return [...byHarness.values()].sort((a, b) => b.sampleSize - a.sampleSize || a.harness.localeCompare(b.harness));
}

/** Every measure, over the window a caller asked for. */
async function kpis_readKpis(db: kpis_import_RelationalStore, opts: { windowDays: number | null; now: number }): Promise<kpis_KpiReport> {
  const since = opts.windowDays === null ? null : opts.now - opts.windowDays * 86_400_000;
  const sessionWindow = kpis_windowClause('first_received_at', since);
  const callWindow = kpis_windowClause('c.created_at', since);

  const [{ prompts, served, withSpores }, byHarness, sessions, startedWithBlock, planReads, mycoCalls, firstInjections, identity, deliveries] = await Promise.all([
    kpis_promptMeasures(db, since),
    kpis_harnessSplit(db, since),
    kpis_countOf(db, `SELECT COUNT(*) AS n FROM sessions WHERE ${sessionWindow.sql}`, sessionWindow.params),
    kpis_countOf(db, `SELECT COUNT(*) AS n FROM sessions WHERE ${sessionWindow.sql} AND ${kpis_SESSIONS_STARTED_WITH_BLOCK}`, sessionWindow.params),
    kpis_countOf(db, `SELECT COUNT(*) AS n FROM tool_calls c WHERE ${callWindow.sql} AND ${kpis_PLAN_READ}`, callWindow.params),
    kpis_countOf(db, `SELECT COUNT(*) AS n FROM tool_calls c WHERE ${callWindow.sql} AND ${kpis_MYCO_CALL}`, callWindow.params),
    kpis_firstInjectionSamples(db, since),
    kpis_promptIdentityCounts(db, since),
    kpis_deliveryMeasures(db, since),
  ]);

  return {
    windowDays: opts.windowDays,
    since,
    promptsServed: served,
    deliveries,
    servedShare: kpis_share(served, prompts),
    sporeServeRate: kpis_share(withSpores, prompts),
    sessionStartPresent: kpis_share(startedWithBlock, sessions),
    callsPerPrompt: kpis_rate(mycoCalls, prompts),
    callsPerPromptByHarness: byHarness,
    planReadsPerSession: kpis_rate(planReads, sessions),
    firstInjectionMs: { value: kpis_median(firstInjections), sampleSize: firstInjections.length },
    recallQuality: { value: kpis_import_recallQuality, sampleSize: kpis_import_caseCount },
    promptIdentity: identity,
  };
}

/** The captured session supporting an extraction finding, within the run's Project. */
async function prompts_extractionSourceSession(db: prompts_import_RelationalStore, scope: prompts_import_ReadScope, promptId: string): Promise<string | null> {
  const source = await prepareViewRead(db, "M36:prompts_extractionSourceSession:0", `SELECT p.session_id AS sessionId FROM prompt_batches p
    JOIN sessions s ON s.project_id = p.project_id AND s.session_id = p.session_id
    WHERE p.project_id = ? AND p.prompt_id = ? AND p.origin IN (${prompts_import_READ_ORIGINS.map(() => '?').join(', ')}) AND ${prompts_import_notTombstonedSql('s')}`)
    .bind(scope.projectId, promptId, ...prompts_import_READ_ORIGINS).first<{ sessionId: string }>();
  return source?.sessionId ?? null;
}
const search_SEARCH_MAX_TERMS = 16;
/** Control characters a query may not carry: every C0 control but the tab and line breaks a pasted query splits on, and DEL. */
const search_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

class search_InvalidSearch extends Error { }

/** Punctuation and FTS operators are literal search terms. */
function search_sanitizeFtsQuery(query: string): string {
  return query.split(/\s+/).filter((tok) => tok.length > 0)
    .map((tok) => /^[\w]+$/.test(tok) && !/^(AND|OR|NOT|NEAR)$/.test(tok) ? tok : `"${tok.replace(/"/g, '""')}"`).join(' ');
}

interface search_Source {
  table: string; id: string; title: string; created: string; session: string; prompt: string;
  status?: string; blob?: 'plan' | 'prompt' | 'response'; namespace: string;
  /** The one line a reader sees for the record, which previews it in place of a snippet wherever it has one. */
  line?: string;
  /** A hit on a record of a conversation names the turn it belongs to. */
  turn?: true;
}
const search_SOURCES: Record<search_import_SearchType, search_Source> = {
  session: { table: 'sessions', id: 'session_id', title: "COALESCE(NULLIF(d.title, ''), 'Session ' || substr(d.session_id, -6))", created: search_import_occurredAt('d.'), session: 'd.session_id', prompt: 'NULL', status: search_import_presentedStatus('d.'), namespace: 'sessions' },
  spore: { table: 'spores', id: 'id', title: 'd.observation_type', created: 'd.created_at', session: 'd.session_id', prompt: 'NULL', status: 'd.status', namespace: 'spores', line: 'd.agent_line' },
  plan: { table: 'plans', id: 'plan_key', title: "COALESCE(NULLIF(d.title, ''), 'Plan')", created: 'd.created_at', session: 'd.session_id', prompt: 'd.prompt_id', status: 'd.status', blob: 'plan', namespace: 'plans' },
  prompt: { table: 'prompt_batches', id: 'prompt_id', title: "'Prompt'", created: 'd.created_at', session: 'd.session_id', prompt: 'd.prompt_id', blob: 'prompt', namespace: 'prompt_batches', turn: true },
  response: { table: 'responses', id: 'response_id', title: "'Response'", created: 'd.created_at', session: 'd.session_id', prompt: 'd.prompt_id', blob: 'response', namespace: 'responses', turn: true },
};

const search_ALIASES: Record<string, search_import_SearchType> = {
  sessions: 'session', spores: 'spore', plans: 'plan',
  prompts: 'prompt', prompt_batches: 'prompt', responses: 'response',
};

function search_typesFor(value: string | undefined): readonly search_import_SearchType[] {
  if (value === undefined || value === 'all') return search_import_SEARCH_TYPES;
  const type = search_ALIASES[value] ?? value;
  if (!search_import_SEARCH_TYPES.includes(type as search_import_SearchType)) throw new search_InvalidSearch(`unsupported search type: ${value}`);
  return [type as search_import_SearchType];
}

interface search_Hit {
  agent: string | null; project_id: string; id: string; title: string; preview: string; rank: number; created_at: number; session_id: string | null; prompt_id: string | null;
  turn_id?: string | null; turn_preview?: string | null; turn_chars?: number | null; turn_stored?: number | null;
}

/** Where a page of one type's matches, listed by time, ends: the last match's place in an order of immutable keys. */
interface search_TimeCursor { type: search_import_SearchType; created_at: number; id: string; project_id: string }

const search_utf8 = new TextEncoder();
const search_CURSOR_MAX_CHARS = 1024;

function search_encodeCursor(cursor: search_TimeCursor): string {
  let binary = '';
  for (const byte of search_utf8.encode(JSON.stringify(cursor))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function search_decodeCursor(value: string, type: search_import_SearchType): search_TimeCursor {
  const invalid = () => new search_InvalidSearch('cursor is not one this search returned');
  if (value.length === 0 || value.length > search_CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  let parsed: unknown;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw invalid(); }
  const c = parsed as Partial<Record<keyof search_TimeCursor, unknown>> | null;
  if (typeof c !== 'object' || c === null || c.type !== type || typeof c.created_at !== 'number' || !Number.isSafeInteger(c.created_at)
    || typeof c.id !== 'string' || typeof c.project_id !== 'string') throw invalid();
  return { type, created_at: c.created_at, id: c.id, project_id: c.project_id };
}

/** How one type's matches are listed: best match first in a single bounded page, or oldest first in pages that continue by cursor. */
type search_Listing = { by: 'relevance' } | { by: 'time'; after: search_TimeCursor | null };

/** One type's matches in the order they are listed, and the cursor of the matches after them when they are listed by time and more follow. */
interface search_TypeHits { hits: search_import_SearchAcrossResult[]; cursor: string | null }

/** Where a search reads: one Project, or a set of them. */
type search_SearchReach = search_import_ReadScope | search_import_ProjectSet;

/** The reach as a predicate on `d.project_id`. A set binds at most one value, so the predicate repeats in a statement without multiplying its binds. */
function search_reachOf(reach: search_SearchReach): { sql: string; params: string[] } {
  return 'projectId' in reach ? { sql: 'd.project_id = ?', params: [reach.projectId] } : search_import_projectsBoundOnce(reach, 'd');
}

async function search_searchType(db: search_import_RelationalStore, reach: search_SearchReach, type: search_import_SearchType, terms: string[], opts: search_import_SearchOptions, limit: number, listing: search_Listing): Promise<search_TypeHits> {
  const s = search_SOURCES[type];
  const none: search_TypeHits = { hits: [], cursor: null };
  if ((opts.status !== undefined && s.status === undefined) || (opts.observation_type !== undefined && type !== 'spore')) return none;
  if (opts.session_id !== undefined && s.session === 'NULL') return none;
  const fts = `${s.table}_fts`;
  const inReach = search_reachOf(reach);
  // The full-text match drives each branch, and `CROSS JOIN` holds that order: a planner free to choose may instead read
  // every row of the reach and evaluate the match once per row.
  const params: (string | number)[] = [terms[0], ...inReach.params];
  // A candidate carries its rank, which branch matched it and the matched row, never its snippet: a snippet is read for
  // the rows the page keeps, by matching that one row again.
  const first = `SELECT d.rowid AS source_rowid, ${fts}.rank AS rank, 0 AS branch, ${fts}.rowid AS match_rowid
    FROM ${fts} CROSS JOIN ${s.table} d ON d.rowid = ${fts}.rowid
    WHERE ${fts} MATCH ? AND ${inReach.sql}`;
  const blob = s.blob ? ` UNION ALL SELECT d.rowid AS source_rowid, search_blob_chunks_fts.rank AS rank, 1 AS branch,
    search_blob_chunks_fts.rowid AS match_rowid
    FROM search_blob_chunks_fts CROSS JOIN search_blob_chunks c ON c.rowid = search_blob_chunks_fts.rowid
    CROSS JOIN ${s.table} d ON d.project_id = c.project_id AND d.blob_key = c.blob_key
    WHERE search_blob_chunks_fts MATCH ? AND ${inReach.sql} AND ${search_import_processedResourceProofSql('d.project_id', s.blob, `d.${s.id}`, 'd.blob_key')}` : '';
  if (s.blob) params.push(terms[0], ...inReach.params);
  // Each candidate is already a row of the reach. The outer read walks the candidates and joins each one's row back by
  // rowid: `CROSS JOIN` holds that order, so no statistics can turn it into a walk of the table.
  const where: string[] = [];
  if (type === 'session') where.push(search_import_notTombstonedSql('d'));
  for (const term of terms.slice(1)) {
    let exists = `EXISTS (SELECT 1 FROM ${fts} WHERE ${fts}.rowid = d.rowid AND ${fts} MATCH ?)`;
    params.push(term);
    if (s.blob) {
      exists += ` OR EXISTS (SELECT 1 FROM search_blob_chunks_fts JOIN search_blob_chunks c
        ON c.rowid = search_blob_chunks_fts.rowid WHERE c.project_id = d.project_id AND c.blob_key = d.blob_key
        AND search_blob_chunks_fts MATCH ? AND ${search_import_processedResourceProofSql('d.project_id', s.blob, `d.${s.id}`, 'd.blob_key')})`;
      params.push(term);
    }
    where.push(`(${exists})`);
  }
  const filter = (value: string | number | undefined, expression: string) => {
    if (value !== undefined) { where.push(expression); params.push(value); }
  };
  filter(opts.status, `${s.status} = ?`);
  filter(opts.session_id, `${s.session} = ?`);
  filter(opts.observation_type, 'd.observation_type = ?');
  filter(opts.since === undefined ? undefined : opts.since * 1000, `${s.created} >= ?`);
  filter(opts.until === undefined ? undefined : opts.until * 1000, `${s.created} <= ?`);
  if (opts.release_state !== undefined || opts.release_confidence !== undefined) {
    let condition = 'k.project_id = d.project_id AND k.namespace = ? AND k.record_id = d.' + s.id;
    params.push(s.namespace);
    if (opts.release_state !== undefined) { condition += ' AND k.state = ?'; params.push(opts.release_state); }
    if (opts.release_confidence !== undefined) { condition += ' AND k.confidence = ?'; params.push(opts.release_confidence); }
    where.push(`EXISTS (SELECT 1 FROM knowledge_release_state k WHERE ${condition})`);
  }
  // Listed by time, a page after another starts past that page's last match in an order of keys no capture changes: the record's own
  // time, its id, its Project. One row past the page says whether another follows.
  if (listing.by === 'time' && listing.after !== null) {
    const { created_at, id, project_id } = listing.after;
    where.push(`(${s.created} > ? OR (${s.created} = ? AND d.${s.id} > ?) OR (${s.created} = ? AND d.${s.id} = ? AND d.project_id > ?))`);
    params.push(created_at, created_at, id, created_at, id, project_id);
  }
  params.push(listing.by === 'time' ? limit + 1 : limit);
  // The page's snippets: each kept row's best match, matched again by its rowid in the branch that found it.
  const ownSnippet = `(SELECT snippet(${fts}, -1, '', '', ' … ', 40) FROM ${fts} WHERE ${fts} MATCH ? AND ${fts}.rowid = kept.match_rowid)`;
  const blobSnippet = `(SELECT snippet(search_blob_chunks_fts, 0, '', '', ' … ', 40) FROM search_blob_chunks_fts
    WHERE search_blob_chunks_fts MATCH ? AND search_blob_chunks_fts.rowid = kept.match_rowid)`;
  const snippet = s.blob ? `CASE kept.branch WHEN 0 THEN ${ownSnippet} ELSE ${blobSnippet} END` : ownSnippet;
  const preview = s.line === undefined ? snippet : `COALESCE(NULLIF(kept.line, ''), ${snippet})`;
  params.push(terms[0]);
  if (s.blob) params.push(terms[0]);
  // A conversation hit names its turn: the hit's own prompt reference, kept only where the Project's session holds that prompt, and a
  // steering prompt resolved to the turn it steers, as the named-turn read does. Both reads are by primary key.
  const turnColumns = s.turn ? `, tp.prompt_id AS turn_id, substr(tp.text, 1, ${turns_TURN_PREVIEW_CHARS}) AS turn_preview, length(tp.text) AS turn_chars, tp.blob_key IS NOT NULL AS turn_stored` : '';
  const turnJoins = s.turn ? `LEFT JOIN prompt_batches rp ON rp.project_id = kept.project_id AND rp.session_id = kept.session_id AND rp.prompt_id = kept.prompt_id
    LEFT JOIN prompt_batches tp ON tp.project_id = rp.project_id AND tp.session_id = rp.session_id AND tp.prompt_id = COALESCE(rp.parent_prompt_id, rp.prompt_id) AND tp.parent_prompt_id IS NULL` : '';
  const keptOrder = listing.by === 'time' ? 'created_at, id, d.project_id' : 'rank, created_at DESC, id, d.project_id';
  const listedOrder = listing.by === 'time' ? 'kept.created_at, kept.id, kept.project_id' : 'kept.rank, kept.created_at DESC, kept.id, kept.project_id';
  const found = (await prepareViewRead(db, "M25:search_searchType:0", `WITH candidates AS MATERIALIZED (${first}${blob}),
    kept AS MATERIALIZED (SELECT d.project_id, d.${s.id} AS id, ${s.title} AS title, MIN(candidates.rank) AS rank,
      candidates.branch, candidates.match_rowid, ${s.line ?? 'NULL'} AS line,
      ${s.created} AS created_at, ${s.session} AS session_id, ${s.prompt} AS prompt_id
    FROM candidates CROSS JOIN ${s.table} d ON d.rowid = candidates.source_rowid
    ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} GROUP BY d.rowid ORDER BY ${keptOrder} LIMIT ?)
    SELECT kept.project_id, kept.id, kept.title, kept.rank, kept.created_at, kept.session_id, kept.prompt_id, (SELECT agent FROM sessions WHERE project_id = kept.project_id AND session_id = kept.session_id) AS agent, ${preview} AS preview${turnColumns}
    FROM kept ${turnJoins} ORDER BY ${listedOrder}`).bind(...params).all<search_Hit>()).results;
  const more = listing.by === 'time' && found.length > limit;
  const rows = more ? found.slice(0, limit) : found;
  const best = Math.max(...rows.map((r) => Math.abs(r.rank)), Number.MIN_VALUE);
  const tools: Partial<Record<search_import_SearchType, string>> = { session: 'myco_sessions', spore: 'myco_spores', plan: 'myco_plans' };
  const tool = tools[type];
  const last = rows.at(-1);
  const hits = rows.filter((r) => r.id.length > 0).map((r): search_import_SearchAcrossResult => ({
    projectId: r.project_id, id: r.id, type, title: type === 'session' ? search_import_displayPrompt(r.title, r.agent) : r.title, preview: (type === 'session' || type === 'prompt' ? search_import_displayPrompt(r.preview ?? '', r.agent) : r.preview ?? '').slice(0, search_import_SEARCH_PREVIEW_CHARS), score: Math.abs(r.rank) / best,
    created_at: r.created_at,
    ...(r.session_id === null ? {} : { session_id: r.session_id }),
    ...(r.prompt_id === null ? {} : { prompt_id: r.prompt_id }),
    ...(s.turn ? { turn: search_turnOf(r) } : {}),
    ...(tool === undefined ? {} : { retrieve: { tool, input: { op: 'get', id: r.id } } }),
  }));
  const cursor = more && last !== undefined ? search_encodeCursor({ type, created_at: last.created_at, id: last.id, project_id: last.project_id }) : null;
  return { hits, cursor };
}

/** The turn a conversation hit opens, or null when its prompt reference names no top-level prompt of the hit's own session. */
function search_turnOf(r: search_Hit): search_import_SearchTurn | null {
  if (r.turn_id == null) return null;
  return { prompt_id: r.turn_id, preview: r.turn_preview ?? null, text_chars: r.turn_chars ?? null, stored: r.turn_stored === 1 };
}

/** Each result's release state, one bulk read per namespace present. */
async function search_withRelease(db: search_import_RelationalStore, scope: search_import_ReadScope, results: search_import_SearchResult[]): Promise<search_import_SearchResult[]> {
  const byNamespace = new Map<search_import_ReleaseNamespace, string[]>();
  for (const r of results) if (search_import_isReleaseNamespace(r.type)) byNamespace.set(r.type, [...(byNamespace.get(r.type) ?? []), r.id]);
  const states = new Map<string, search_import_ReleaseAnnotation>();
  for (const [namespace, ids] of byNamespace) {
    for (const [id, row] of Object.entries(await search_import_getReleaseStatesForRecords(db, scope, namespace, ids))) {
      states.set(`${namespace}:${id}`, search_annotation(row));
    }
  }
  return results.map((r) => {
    const release = states.get(`${r.type}:${r.id}`);
    return release === undefined ? r : { ...r, release };
  });
}

const search_annotation = (row: Awaited<ReturnType<typeof search_import_getReleaseStatesForRecords>>[string]): search_import_ReleaseAnnotation =>
  ({ state: row.state, confidence: row.confidence, ref: row.basisRef, checked_at: row.checkedAt });

/** Each result's release state across Projects, one batched read per Project and namespace present. */
async function search_withReleaseAcross(db: search_import_RelationalStore, results: search_import_SearchAcrossResult[]): Promise<search_import_SearchAcrossResult[]> {
  const groups = new Map<string, { projectId: string; namespace: search_import_ReleaseNamespace; recordIds: string[] }>();
  const key = (projectId: string, namespace: string) => JSON.stringify([projectId, namespace]);
  for (const r of results) {
    if (!search_import_isReleaseNamespace(r.type)) continue;
    const group = groups.get(key(r.projectId, r.type)) ?? { projectId: r.projectId, namespace: r.type, recordIds: [] };
    group.recordIds.push(r.id);
    groups.set(key(r.projectId, r.type), group);
  }
  const wanted = [...groups.values()];
  const answers = await search_import_getReleaseStatesAcross(db, wanted);
  const states = new Map<string, search_import_ReleaseAnnotation>();
  wanted.forEach((w, i) => { for (const [id, row] of Object.entries(answers[i] ?? {})) states.set(JSON.stringify([w.projectId, w.namespace, id]), search_annotation(row)); });
  return results.map((r) => {
    const release = states.get(JSON.stringify([r.projectId, r.type, r.id]));
    return release === undefined ? r : { ...r, release };
  });
}

/** One scoped search implementation for HTTP and MCP. An unavailable semantic provider is explicit. */
async function search_searchProject(db: search_import_RelationalStore, scope: search_import_ReadScope, opts: search_import_SearchOptions, resolveSemantic?: () => Promise<embedding_SemanticSearch | null>): Promise<search_import_SearchAnswer> {
  const answer = await search_searchUnannotated(db, scope, opts, resolveSemantic);
  return { ...answer, results: await search_withRelease(db, scope, answer.results) };
}

/**
 * Full-text search across a set of Projects: every Project that accepts capture, or the ones named. Each type is one
 * statement over the whole set, ranked by the same full-text rank a Project's search uses; the index's statistics span
 * every Project, so ranks compare across them. Semantic search reads one Project's vectors, so `mode` here is `auto`
 * or `fts`, and the answer is always full text.
 */
async function search_searchAcross(db: search_import_RelationalStore, set: search_import_ProjectSet, opts: search_import_SearchOptions): Promise<search_import_SearchAcrossAnswer> {
  const { words, types, mode, limit, listing } = search_validated(opts);
  if (mode === 'semantic') throw new search_InvalidSearch('semantic search reads one project; across projects, mode must be auto or fts');
  const { results, cursor } = await search_fullText(db, set, types, words, opts, limit, listing);
  return { results: await search_withReleaseAcross(db, results), mode: 'fts', provider_unavailable: false, coverage: { pending_blobs: await core_search_index_pendingSearchBlobs(db, set) }, cursor };
}

function search_validated(opts: search_import_SearchOptions): { query: string; words: string[]; types: readonly search_import_SearchType[]; mode: string; limit: number; listing: search_Listing } {
  const query = opts.query.trim();
  if (query.length === 0 || query.length > search_import_SEARCH_QUERY_MAX_CHARS) throw new search_InvalidSearch(`query must contain 1–${search_import_SEARCH_QUERY_MAX_CHARS} characters`);
  if (search_CONTROL_CHARACTERS.test(query)) throw new search_InvalidSearch('query must not contain control characters');
  const words = query.split(/\s+/);
  if (words.length > search_SEARCH_MAX_TERMS) throw new search_InvalidSearch(`query may contain at most ${search_SEARCH_MAX_TERMS} terms`);
  const types = search_typesFor(opts.type);
  const mode = opts.mode ?? 'auto';
  if (!['auto', 'fts', 'semantic'].includes(mode)) throw new search_InvalidSearch('mode must be auto, fts or semantic');
  const limit = opts.limit ?? search_import_SEARCH_API_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > search_import_SEARCH_MAX_LIMIT) throw new search_InvalidSearch(`limit must be between 1 and ${search_import_SEARCH_MAX_LIMIT}`);
  for (const value of [opts.since, opts.until]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new search_InvalidSearch('timestamps must be non-negative epoch seconds');
  if (opts.since !== undefined && opts.until !== undefined && opts.since > opts.until) throw new search_InvalidSearch('since must not exceed until');
  const order = opts.order ?? 'relevance';
  if (order !== 'relevance' && order !== 'time') throw new search_InvalidSearch('order must be relevance or time');
  if (order === 'relevance') {
    if (opts.cursor !== undefined) throw new search_InvalidSearch('a cursor continues a search ordered by time; send order=time');
    return { query, words, types, mode, limit, listing: { by: 'relevance' } };
  }
  // Only a search by time pages: its order rests on keys no capture changes, so a page after another never loses or repeats a match.
  const [only, ...others] = types;
  if (only === undefined || others.length > 0) throw new search_InvalidSearch('order=time lists the matches of one type; name it with type');
  if (only === 'session') throw new search_InvalidSearch('order=time does not apply to sessions');
  if (mode === 'semantic') throw new search_InvalidSearch('order=time lists full-text matches; mode must be auto or fts');
  return { query, words, types, mode, limit, listing: { by: 'time', after: opts.cursor === undefined ? null : search_decodeCursor(opts.cursor, only) } };
}

/**
 * Each type's best hits, one statement per type, merged: every type's best first, then the rest by score, to the limit. Listed by
 * time, one type's matches oldest first, each page naming the cursor of the matches after it.
 */
async function search_fullText(db: search_import_RelationalStore, reach: search_SearchReach, types: readonly search_import_SearchType[], words: string[], opts: search_import_SearchOptions, limit: number, listing: search_Listing): Promise<{ results: search_import_SearchAcrossResult[]; cursor: string | null }> {
  const terms = words.map(search_sanitizeFtsQuery);
  if (listing.by === 'time') {
    const { hits, cursor } = await search_searchType(db, reach, types[0]!, terms, opts, limit, listing);
    return { results: hits, cursor };
  }
  const branches = (await Promise.all(types.map((type) => search_searchType(db, reach, type, terms, opts, limit, listing)))).map((branch) => branch.hits);
  const order = (a: search_import_SearchAcrossResult, b: search_import_SearchAcrossResult) => b.score - a.score || search_import_SEARCH_TYPES.indexOf(a.type) - search_import_SEARCH_TYPES.indexOf(b.type) || a.id.localeCompare(b.id) || a.projectId.localeCompare(b.projectId);
  const floor = branches.flatMap((hits) => hits.slice(0, 1)).sort(order).slice(0, limit);
  const remaining = branches.flatMap((hits) => hits.slice(1)).sort(order).slice(0, limit - floor.length);
  return { results: [...floor, ...remaining].sort(order), cursor: null };
}

async function search_searchUnannotated(db: search_import_RelationalStore, scope: search_import_ReadScope, opts: search_import_SearchOptions, resolveSemantic?: () => Promise<embedding_SemanticSearch | null>): Promise<search_import_SearchAnswer> {
  const { query, words, types, mode, limit, listing } = search_validated(opts);
  const coverage = { pending_blobs: await core_search_index_pendingSearchBlobs(db, scope.projectId) };
  if (mode !== 'fts' && listing.by === 'relevance') {
    const semantic = await resolveSemantic?.();
    if (semantic != null) {
      try {
        return { results: await embedding_semanticSearch(db, scope, semantic, types, { ...opts, query }, limit), mode: 'semantic', provider_unavailable: false, coverage, cursor: null };
      } catch (error) { if (!(error instanceof search_import_EmbeddingUnavailable)) throw error; }
    }
  }
  if (mode === 'semantic') return { results: [], mode, provider_unavailable: true, coverage, cursor: null };
  const found = await search_fullText(db, scope, types, words, opts, limit, listing);
  const results = found.results.map(({ projectId: _projectId, ...result }) => result);
  return { results, mode: 'fts', provider_unavailable: mode === 'auto' && listing.by === 'relevance', coverage, cursor: found.cursor };
}

export {
  type embedding_EmbeddingSource,
  type embedding_SemanticSearch,
  type embedding_SemanticHit,
  type embedding_SemanticHitCounts,
  embedding_semanticHits,
  embedding_semanticSearch,
  extraction_coverage_hasAcknowledgedPrompts,
  type kpis_Measure,
  type kpis_HarnessMeasure,
  type kpis_KpiReport,
  type kpis_PromptIdentityCounts,
  kpis_KPI_WINDOWS,
  kpis_kpiWindow,
  kpis_median,
  kpis_readKpis,
  prompts_extractionSourceSession,
  search_InvalidSearch,
  search_sanitizeFtsQuery,
  search_searchProject,
  search_searchAcross,
};

/** Unplaced records stay visible at session level, in immutable capture order. */
async function hook_placement_listUnplacedHookRecords(db: hook_placement_import_RelationalStore, scope: hook_placement_import_ReadScope, sessionId: string, opts: { limit?: number; cursor?: string } = {}) {
  const k = hook_placement_import_keyset(opts, { order: 'created_at', id: 'record_key', direction: 'ASC' });
  if (k === null) return { rows: [], cursor: null };
  const contexts = await hook_placement_sessionContextHints(db, scope, sessionId);
  const pages = await Promise.all(hook_placement_HOOK_RECORD_SOURCES.map(source => prepareViewRead(db, "M08:hook_placement_listUnplacedHookRecords:0", `SELECT * FROM (${hook_placement_unplacedSourceSql(source, source.table === 'session_injections' ? `(${contexts.sql})` : source.table)})
    WHERE project_id = ? AND session_id = ? ${k.where === '' ? '' : `AND ${k.where}`}
    ORDER BY created_at, record_key LIMIT ?`).bind(...(source.table === 'session_injections' ? contexts.params : []), scope.projectId, sessionId, ...k.params, k.limit + 1).all<Record<string, unknown>>()));
  const results = pages.flatMap(result => result.results).sort((a, b) => Number(a.created_at) - Number(b.created_at)
    || hook_placement_import_binaryOrder(String(a.record_key), String(b.record_key)));
  const rows: hook_placement_UnplacedHookRecord[] = results.map(row => ({
    key: row.record_key as string, kind: row.record_kind as string,
    id: row.record_id as string, promptHint: row.prompt_hint as string | null, label: row.label as string, createdAt: row.created_at as number
  }));
  return hook_placement_import_page(rows, k.limit, row => ({ createdAt: row.createdAt, id: row.key }));
}

/** One plan inside the scope, or null — including when the key exists under another project. */
function plans_getPlan(db: plans_import_RelationalStore, scope: plans_import_ReadScope, planKey: string, options: { summary: true }): Promise<plans_ProjectPlanSummary | null>;

function plans_getPlan(db: plans_import_RelationalStore, scope: plans_import_ReadScope, planKey: string): Promise<plans_ProjectPlanRow | null>;

async function plans_getPlan(db: plans_import_RelationalStore, scope: plans_import_ReadScope, planKey: string, options: { summary?: boolean } = {}): Promise<plans_ProjectPlanSummary | plans_ProjectPlanRow | null> {
  const row = await prepareViewRead(db, "M09:plans_getPlan:0", `SELECT ${options.summary ? 'plan_key, title, status, session_id, content_hash' : plans_COLUMNS} FROM plans WHERE project_id = ? AND plan_key = ?`).bind(scope.projectId, planKey).first<Record<string, unknown>>();
  if (row === null) return null;
  if (options.summary) return {
    planKey: row.plan_key as string, title: row.title as string | null, status: row.status as string,
    sessionId: row.session_id as string, contentHash: row.content_hash as string | null
  };
  const tags = await plans_tagsOf(db, scope, [planKey]);
  return plans_toPlan(row, tags.get(planKey) ?? []);
}

/** True when the plan sits in the session inside the scope. */
async function plans_planInSession(db: plans_import_RelationalStore, scope: plans_import_ReadScope, sessionId: string, planKey: string): Promise<boolean> {
  const row = await prepareViewRead(db, "M10:plans_planInSession:0", `SELECT 1 AS present FROM plans WHERE project_id = ? AND session_id = ? AND plan_key = ?`).bind(scope.projectId, sessionId, planKey).first<{ present: number }>();
  return row !== null;
}

/** One session inside the scope, or null — including when the session exists under another project. */
/** One session; given `nowMs`, marked working or not. */
async function sessions_getSession(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string, nowMs?: number): Promise<sessions_SessionRow | null> {
  const row = await prepareViewRead(db, "M12:sessions_getSession:0", `SELECT ${sessions_SESSION_COLUMNS} ${sessions_SESSION_FROM} WHERE s.project_id = ? AND s.session_id = ? AND ${sessions_LIVE_SESSION}`)
    .bind(scope.projectId, sessionId)
    .first<Record<string, unknown>>();
  return row === null ? null : sessions_toSession(row, nowMs);
}

/** How many of each child a session holds. One statement per table rather than a join: the projections have no common key and a five-way LEFT JOIN would multiply rows. */
async function sessions_sessionCounts(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<sessions_SessionCounts> {
  const tables = [
    ['prompts', 'prompt_batches'],
    ['toolCalls', 'tool_calls'],
    ['responses', 'responses'],
    ['plans', 'plans'],
    ['attachments', 'attachments'],
  ] as const;
  const counts = {} as Record<string, number>;
  // A deleted session holds nothing, whether or not every row has gone yet:
  // one check ahead of the five counts rather than a predicate repeated in each.
  const deleted = await prepareViewRead(db, "M11:sessions_sessionCounts:0", `SELECT 1 AS present FROM session_tombstones WHERE project_id = ? AND session_id = ?`).bind(scope.projectId, sessionId).first<{ present: number }>();
  if (deleted !== null) return { prompts: 0, toolCalls: 0, responses: 0, plans: 0, attachments: 0 };
  for (const [key, table] of tables) {
    const row = await prepareViewRead(db, "M11:sessions_sessionCounts:1", `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? AND session_id = ?`)
      .bind(scope.projectId, sessionId)
      .first<{ n: number }>();
    counts[key] = row?.n ?? 0;
  }
  return counts as unknown as sessions_SessionCounts;
}

async function children_listChildren<T>(
  db: children_import_RelationalStore,
  query: children_ChildQuery<T>,
  scope: children_import_ReadScope,
  sessionId: string,
  opts: children_ChildOptions = {},
  filters: readonly children_ChildFilter[] = []
): Promise<children_import_Page<T & { orderedAt: number }>> {
  const order = query.orderColumn;
  const k = children_import_keyset(opts, { order, id: query.idColumn, direction: 'ASC' });
  if (k === null) return { rows: [], cursor: null };
  const limit = k.limit;
  const conditions = ['project_id = ?', 'session_id = ?'];
  const params: unknown[] = [scope.projectId, sessionId];
  if (opts.promptId !== undefined) {
    conditions.push(`${query.promptHint ?? 'prompt_id'} = ?`); params.push(opts.promptId);
    if (query.promptHint !== undefined) conditions.push(hook_placement_hookPlacementSql({ project: `${query.table}.project_id`, session: `${query.table}.session_id`, prompt: `${query.table}.${query.promptHint}` }));
  }
  for (const filter of filters) { conditions.push(filter.sql); params.push(...filter.params); }
  if (k.where !== '') { conditions.push(k.where); params.push(...k.params); }
  const sql = `SELECT ${children_childColumns(query)}, ${order} AS order_at, ${query.idColumn} FROM ${query.table}
                WHERE ${conditions.join(' AND ')}
                ORDER BY ${order} ASC, ${query.idColumn} ASC LIMIT ?`;
  const { results } = await prepareViewRead(db, "M04:children_listChildren:0", sql).bind(...params, limit + 1).all<Record<string, unknown>>();
  const rows = results.map((row) => ({ ...query.map(row), orderedAt: row.order_at as number, __id: row[query.idColumn] as string }));
  const paged = children_import_page(rows, limit, (r) => ({ createdAt: r.orderedAt, id: r.__id }));
  return { rows: paged.rows.map(({ __id, ...rest }) => rest as T & { orderedAt: number }), cursor: paged.cursor };
}

/** First pages for several prompts, each bounded independently, in one scoped query. */
async function children_listChildrenByPrompt<T>(db: children_import_RelationalStore, query: children_ChildQuery<T>, scope: children_import_ReadScope, sessionId: string, promptIds: readonly string[], limit: number): Promise<Map<string, children_import_Page<T & { orderedAt: number }>>> {
  const pages = new Map<string, children_import_Page<T & { orderedAt: number }>>();
  if (promptIds.length === 0) return pages;
  const { results } = await prepareViewRead(db, "M04:children_listChildrenByPrompt:0", `SELECT * FROM (
    SELECT ${children_childColumns(query)}, ${query.orderColumn} AS order_at, ${query.idColumn},
      ROW_NUMBER() OVER (PARTITION BY ${query.promptHint ?? 'prompt_id'} ORDER BY ${query.orderColumn} ASC, ${query.idColumn} ASC) AS page_row
    FROM (SELECT value AS wanted_prompt FROM json_each(?)) wanted CROSS JOIN ${query.table}
    WHERE project_id = ? AND session_id = ? AND ${query.promptHint ?? 'prompt_id'} = wanted.wanted_prompt
      ${query.promptHint === undefined ? '' : `AND ${hook_placement_hookPlacementSql({ project: `${query.table}.project_id`, session: `${query.table}.session_id`, prompt: `${query.table}.${query.promptHint}` })}`}
  ) WHERE page_row <= ? ORDER BY prompt_id, order_at ASC, ${query.idColumn} ASC`)
    .bind(JSON.stringify(promptIds), scope.projectId, sessionId, limit + 1).all<Record<string, unknown>>();
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const r of results) {
    const id = r.prompt_id as string;
    const rows = grouped.get(id) ?? [];
    rows.push(r);
    grouped.set(id, rows);
  }
  for (const id of promptIds) {
    const result = children_import_page(grouped.get(id) ?? [], limit, (r) => ({ createdAt: r.order_at as number, id: r[query.idColumn] as string }));
    pages.set(id, { cursor: result.cursor, rows: result.rows.map((r) => ({ ...query.map(r), orderedAt: r.order_at as number })) });
  }
  return pages;
}

const children_MATERIAL_SQL = `SELECT pb.prompt_id, substr(pb.text, 1, ?) AS prompt,
                     (SELECT substr(r.text, 1, ?) FROM responses r
                       WHERE r.project_id = pb.project_id AND r.session_id = pb.session_id AND r.prompt_id = pb.prompt_id AND r.text IS NOT NULL
                       ORDER BY r.created_at, r.response_id LIMIT 1) AS response
                FROM prompt_batches pb
               WHERE pb.project_id = ? AND pb.session_id = ? AND ${children_MATERIAL_PROMPT_SQL} AND ${children_import_sessionMaterialReadySql('pb')}`;

async function children_materialRows(db: children_import_RelationalStore, projectId: string, sessionId: string, opts: { limit: number; excerptChars: number }, order: 'ASC' | 'DESC'): Promise<children_MaterialRow[]> {
  const { results } = await prepareViewRead(db, "M23:children_materialRows:0", `${children_MATERIAL_SQL} ORDER BY pb.created_at ${order}, pb.prompt_id ${order} LIMIT ?`)
    .bind(opts.excerptChars, opts.excerptChars, projectId, sessionId, opts.limit)
    .all<{ prompt_id: string; prompt: string; response: string | null }>();
  await children_import_assertSessionMaterialReady(db, projectId, sessionId);
  return results.map((r) => ({ promptId: r.prompt_id, prompt: r.prompt, response: r.response ?? null }));
}

/** A projected field whose inline value or exact stored-body provenance is admitted. */
async function processed_processedField(env: Pick<processed_import_ServerEnv, 'db'>, scope: processed_import_ReadScope, kind: processed_ProcessedBodyKind, id: string): Promise<processed_ProcessedField | null> {
  const field = processed_import_PROCESSED_FIELDS[kind];
  const row = await prepareViewRead(env.db, "M26:processed_processedField:0", `SELECT ${field.text === null ? 'NULL' : `d.${field.text}`} AS text, d.${field.blob} AS blob_key,
      ${processed_import_registeredObjectKeySql('d.project_id', `d.${field.blob}`)} AS object_key,
      (SELECT b.size FROM blobs b WHERE b.project_id = d.project_id AND b.key = d.${field.blob}) AS registered_size,
      ${kind === 'tool-input' ? 'd.input_bytes' : 'NULL'} AS total_bytes,
      ${kind === 'attachment' ? 'd.media_type' : 'NULL'} AS media_type,
      ${processed_import_processedResourceProofSql('d.project_id', kind, `d.${field.id}`, `d.${field.blob}`)} AS admitted
    FROM ${field.table} d WHERE d.project_id = ? AND d.${field.id} = ?`)
    .bind(scope.projectId, id).first<processed_ProcessedField>();
  if (row === null) return null;
  if (kind === 'tool-input' && row.blob_key === null && row.text !== null && row.total_bytes !== null && row.total_bytes > processed_import_utf8(row.text).byteLength) {
    throw new Error('Processed tool input has a truncated prefix without its complete body');
  }
  const inline = row.text !== null && kind !== 'tool-output' && kind !== 'tool-input';
  if (!inline && row.blob_key !== null && row.admitted !== 1) return null;
  return row;
}

/** A session's top-level prompts, keyset-paged in the requested direction; a named prompt resolves to its turn. */
async function turns_listTurns(db: turns_import_RelationalStore, scope: turns_import_ReadScope, sessionId: string, opts: { origins?: readonly string[]; limit?: number; cursor?: string; order?: 'ASC' | 'DESC'; promptId?: string } = {}): Promise<turns_import_Page<turns_TurnRow>> {
  const direction = opts.order ?? 'ASC';
  const k = turns_import_keyset(opts, { order: 'pb.created_at', id: 'pb.prompt_id', direction });
  if (k === null) return { rows: [], cursor: null };
  const origins = opts.origins ?? turns_DEFAULT_ORIGINS;
  if (origins.length === 0) return { rows: [], cursor: null };
  const conditions = ['pb.project_id = ?', 'pb.session_id = ?', 'pb.parent_prompt_id IS NULL', `pb.origin IN (${origins.map(() => '?').join(', ')})`];
  const params: unknown[] = [scope.projectId, sessionId, ...origins];
  if (opts.promptId !== undefined) {
    conditions.push(`pb.prompt_id = (SELECT COALESCE(parent_prompt_id, prompt_id) FROM prompt_batches WHERE project_id = ? AND session_id = ? AND prompt_id = ?)`);
    params.push(scope.projectId, sessionId, opts.promptId);
  }
  if (k.where !== '') { conditions.push(k.where); params.push(...k.params); }
  const { results } = await prepareViewRead(db, "M01:turns_listTurns:0", `SELECT pb.prompt_id, pb.origin, pb.prompt_kind, pb.thread_label, substr(pb.text, 1, ${turns_TURN_PREVIEW_CHARS}) AS preview, length(pb.text) AS text_chars, pb.blob_key, pb.created_at,
                     ${turns_TOOL_CALL_COUNT} AS tool_call_count, ${turns_RESPONSE_COUNT} AS response_count, ${turns_CHILD_COUNT} AS child_count, ${turns_PLAN_COUNT} AS plan_count, ${turns_ATTACHMENT_COUNT} AS attachment_count
                FROM prompt_batches pb
               WHERE ${conditions.join(' AND ')}
               ORDER BY pb.created_at ${direction}, pb.prompt_id ${direction} LIMIT ?`)
    .bind(...params, k.limit + 1)
    .all<Record<string, unknown>>();
  const rows: turns_TurnRow[] = results.map((r) => ({
    promptId: r.prompt_id as string,
    origin: r.origin as string,
    promptKind: (r.prompt_kind as string | null) ?? null,
    threadLabel: (r.thread_label as string | null) ?? null,
    preview: (r.preview as string | null) ?? null,
    textChars: (r.text_chars as number | null) ?? null,
    blobKey: (r.blob_key as string | null) ?? null,
    createdAt: r.created_at as number,
    toolCallCount: r.tool_call_count as number,
    responseCount: r.response_count as number,
    childCount: r.child_count as number,
    planCount: r.plan_count as number,
    attachmentCount: r.attachment_count as number,
  }));
  return turns_import_page(rows, k.limit, (r) => ({ createdAt: r.createdAt, id: r.promptId }));
}

/** True when a prompt of that id sits in the session. */
async function turns_promptInSession(db: turns_import_RelationalStore, scope: turns_import_ReadScope, sessionId: string, promptId: string): Promise<boolean> {
  const row = await prepareViewRead(db, "M02:turns_promptInSession:0", `SELECT 1 AS present FROM prompt_batches WHERE project_id = ? AND session_id = ? AND prompt_id = ?`)
    .bind(scope.projectId, sessionId, promptId)
    .first<{ present: number }>();
  return row !== null;
}

/** One turn's body, or null when no prompt of that id sits in the session. Tool calls are not here: they are read on their own, page by page, when the reader opens them. */
async function turns_turnDetail(db: turns_import_RelationalStore, scope: turns_import_ReadScope, sessionId: string, promptId: string): Promise<turns_TurnDetail | null> {
  const children = await turns_steeringChildPage(db, scope, sessionId, promptId, { limit: turns_TURN_BODY_LIMIT });
  const bodies = await turns_readTurnBodies(db, scope, sessionId, [promptId, ...children.rows.map(r => r.prompt_id as string)]);
  const body = bodies.get(promptId);
  if (body === undefined) return null;
  body.children = [...turns_steeringBodies(children, bodies).rows];
  body.cursors.children = children.cursor;
  return body;
}

/** First pages are hydrated in bulk; each child keeps its own collection cursors. */
async function turns_readTurnBodies(db: turns_import_RelationalStore, scope: turns_import_ReadScope, sessionId: string, promptIds: readonly string[]): Promise<Map<string, turns_TurnDetail>> {
  const bodies = new Map<string, turns_TurnDetail>();
  if (promptIds.length === 0) return bodies;
  const { results } = await prepareViewRead(db, "M03:turns_readTurnBodies:0", `SELECT ${turns_PROMPT_COLUMNS},
    (SELECT MAX(+created_at) FROM responses WHERE project_id = pb.project_id AND session_id = pb.session_id AND prompt_id = pb.prompt_id) AS last_reply,
    (SELECT json_group_array(json_object('toolName', tool_name, 'count', n)) FROM (
      ${turns_toolUsageSql(true, true)})) AS tools,
    (SELECT json_object('receiptId', i.id, 'sporeIds', i.spore_ids, 'createdAt', i.created_at, 'planIds', json(COALESCE(i.plan_ids, '[]')))
      FROM spore_injections i WHERE i.project_id = pb.project_id AND i.session_id = pb.session_id AND i.delivered_prompt_id = pb.prompt_id
        AND ${hook_placement_hookPlacementSql({ project: 'i.project_id', session: 'i.session_id', prompt: 'i.delivered_prompt_id' })}
      ORDER BY +i.created_at DESC LIMIT 1) AS injection,
    (SELECT agent FROM sessions s WHERE s.project_id = pb.project_id AND s.session_id = pb.session_id) AS agent
    FROM (SELECT value AS wanted_prompt FROM json_each(?)) wanted CROSS JOIN prompt_batches pb
    WHERE pb.project_id = ? AND pb.session_id = ? AND pb.prompt_id = wanted.wanted_prompt`)
    .bind(JSON.stringify(promptIds), scope.projectId, sessionId).all<Record<string, unknown>>();
  const ids = results.map(r => r.prompt_id as string);
  const [responses, attachments, plans, answers] = await Promise.all([
    children_listChildrenByPrompt(db, children_RESPONSE_QUERY, scope, sessionId, ids, turns_TURN_BODY_LIMIT),
    children_listChildrenByPrompt(db, children_ATTACHMENT_QUERY, scope, sessionId, ids, turns_TURN_BODY_LIMIT),
    children_listChildrenByPrompt(db, children_TURN_PLAN_QUERY, scope, sessionId, ids, turns_TURN_BODY_LIMIT),
    children_listChildrenByPrompt(db, turns_ANSWER_QUERY, scope, sessionId, ids, turns_TURN_BODY_LIMIT),
  ]);
  type Served = { receiptId: string; sporeIds: string[]; createdAt: number; planIds: string[]; };
  const served = new Map(results.map(r => {
    const raw = r.injection === null ? null : JSON.parse(r.injection as string) as Omit<Served, 'sporeIds'> & { sporeIds: string };
    return [r.prompt_id as string, raw === null ? null : { ...raw, sporeIds: turns_retainedIds(raw.sporeIds) }] as const;
  }));
  const plansByReceipt = await receiptPlans(db, scope, [...served.values()].flatMap(r => r === null ? [] : [{ receiptId: r.receiptId, planIds: r.planIds }]));
  const sporeIds = [...new Set([...served.values()].flatMap(i => i?.sporeIds ?? []))];
  const spores = [];
  for (let offset = 0; offset < sporeIds.length; offset += turns_import_MAX_SPORE_LIMIT) spores.push(...await turns_import_listSporesByIds(db, scope, sporeIds.slice(offset, offset + turns_import_MAX_SPORE_LIMIT)));
  const byId = new Map(spores.map(spore => [spore.id, spore]));
  for (const row of results) {
    const prompt = turns_toPrompt(row);
    const id = prompt.promptId;
    const receipt = served.get(id);
    const planById = new Map((receipt == null ? [] : plansByReceipt.get(receipt.receiptId) ?? []).map(plan => [plan.planKey, { planKey: plan.planKey, title: plan.title }]));
    const injection = receipt == null ? null : {
      sporeIds: receipt.sporeIds, planIds: receipt.planIds, createdAt: receipt.createdAt,
      plans: receipt.planIds.flatMap(id => { const plan = planById.get(id); return plan === undefined ? [] : [plan]; }),
      spores: receipt.sporeIds.flatMap(id => {
        const spore = byId.get(id);
        return spore === undefined ? [] : [{ id, observationType: spore.observationType, preview: turns_import_oneLine(spore.agentLine ?? spore.content) }];
      })
    };
    bodies.set(id, {
      prompt, responses: [...responses.get(id)!.rows], attachments: [...attachments.get(id)!.rows],
      plans: [...plans.get(id)!.rows], answers: [...answers.get(id)!.rows], injection, children: [],
      metrics: { tools: JSON.parse(row.tools as string), durationMs: !turns_import_sourceTimestampsRecorded(turns_import_CAPTURE_RULE_BUNDLES, row.agent as string | null) || row.last_reply == null ? null : Math.max(0, (row.last_reply as number) - prompt.createdAt), tokens: null },
      cursors: {
        responses: responses.get(id)!.cursor, attachments: attachments.get(id)!.cursor,
        plans: plans.get(id)!.cursor, answers: answers.get(id)!.cursor, children: null
      },
    });
  }
  return bodies;
}

/** A bounded page of steering prompts, with their bodies hydrated together. */
async function turns_listSteeringChildren(db: turns_import_RelationalStore, scope: turns_import_ReadScope, sessionId: string, promptId: string, opts: { limit?: number; cursor?: string } = {}): Promise<turns_import_Page<turns_TurnChild>> {
  const children = await turns_steeringChildPage(db, scope, sessionId, promptId, opts);
  const bodies = await turns_readTurnBodies(db, scope, sessionId, children.rows.map(r => r.prompt_id as string));
  return turns_steeringBodies(children, bodies);
}

async function turns_steeringChildPage(db: turns_import_RelationalStore, scope: turns_import_ReadScope, sessionId: string, promptId: string, opts: { limit?: number; cursor?: string }): Promise<turns_import_Page<Record<string, unknown>>> {
  const k = turns_import_keyset(opts, { order: 'pb.created_at', id: 'pb.prompt_id', direction: 'ASC' });
  if (k === null) return { rows: [], cursor: null };
  const { results } = await prepareViewRead(db, "M05:turns_steeringChildPage:0", `SELECT ${turns_PROMPT_COLUMNS}, ${turns_TOOL_CALL_COUNT} AS tool_call_count, ${turns_CHILD_COUNT} AS child_count FROM prompt_batches pb
    WHERE pb.project_id = ? AND pb.session_id = ? AND pb.parent_prompt_id = ? ${k.where === '' ? '' : `AND ${k.where}`}
    ORDER BY +pb.created_at ASC, pb.prompt_id ASC LIMIT ?`)
    .bind(scope.projectId, sessionId, promptId, ...k.params, k.limit + 1).all<Record<string, unknown>>();
  return turns_import_page(results, k.limit, (r) => ({ createdAt: r.created_at as number, id: r.prompt_id as string }));
}

/** A turn collection's continuation, confined to the prompt's Project and session. */
function turns_turnCollection(db: turns_import_RelationalStore, scope: turns_import_ReadScope, sessionId: string, promptId: string, collection: turns_TurnCollection, opts: { limit?: number; cursor?: string }) {
  const bounded = { ...opts, limit: Math.min(opts.limit ?? turns_TURN_BODY_LIMIT, turns_TURN_BODY_LIMIT), promptId };
  switch (collection) {
    case 'responses': return children_listChildren(db, children_RESPONSE_QUERY, scope, sessionId, bounded);
    case 'attachments': return children_listChildren(db, children_ATTACHMENT_QUERY, scope, sessionId, bounded);
    case 'plans': return children_listChildren(db, children_TURN_PLAN_QUERY, scope, sessionId, bounded);
    case 'answers': return children_listChildren(db, turns_ANSWER_QUERY, scope, sessionId, bounded);
    case 'children': return turns_listSteeringChildren(db, scope, sessionId, promptId, bounded);
  }
}

/** Counts every stored call, independent of the page of call details. */
async function turns_toolUsage(db: turns_import_RelationalStore, scope: turns_import_ReadScope, sessionId: string, promptId?: string): Promise<turns_ToolUsage[]> {
  const { results } = await prepareViewRead(db, "M06:turns_toolUsage:0", turns_toolUsageSql(promptId !== undefined))
    .bind(scope.projectId, sessionId, ...(promptId === undefined ? [] : [promptId])).all<{ tool_name: string; n: number }>();
  return results.map((r) => ({ toolName: r.tool_name, count: r.n }));
}

/** Sub-agent preambles use the parent hint carried by their canonical start event. */
async function turns_sessionTurnContexts(db: turns_import_RelationalStore, scope: turns_import_ReadScope, sessionId: string): Promise<Record<string, turns_TurnContext>> {
  const contexts = await hook_placement_sessionContextHints(db, scope, sessionId);
  const { results } = await prepareViewRead(db, "M07:turns_sessionTurnContexts:0", `SELECT r.placement_hint AS prompt_id, COUNT(*) AS n FROM (${contexts.sql}) r
    WHERE r.project_id = ? AND r.session_id = ? AND r.kind LIKE 'cortex:%'
      AND ${hook_placement_hookPlacementSql({ project: 'r.project_id', session: 'r.session_id', prompt: 'r.placement_hint' })}
    GROUP BY r.placement_hint`).bind(...contexts.params, scope.projectId, sessionId).all<{ prompt_id: string; n: number }>();
  return Object.fromEntries(results.map(row => [row.prompt_id, { subagents: row.n }]));
}

export async function injectedPromptRecord(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string, promptId: string): Promise<{ spore_ids: string; created_at: number } | null> {
  return prepareViewRead(db, "M45:injectedPromptRecord:0", `SELECT spore_ids, created_at FROM spore_injections
               WHERE project_id = ? AND session_id = ? AND delivered_prompt_id = ?
                 AND ${hook_placement_hookPlacementSql({ project: 'spore_injections.project_id', session: 'spore_injections.session_id', prompt: 'spore_injections.delivered_prompt_id' })}
               ORDER BY created_at DESC LIMIT 1`)
    .bind(scope.projectId, sessionId, promptId)
    .first<{ spore_ids: string; created_at: number }>();
}

export async function processedBundle(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, id: string) {
  return prepareViewRead(db, "M26:processedBundle:0", `SELECT t.input_bundle_id AS bundle_id, t.input_bundle_entry AS entry,
        t.input AS preview, t.input_bytes AS bytes, t.token_id
      FROM tool_calls t
      WHERE t.project_id=? AND t.tool_call_id=?`).bind(scope.projectId, id)
    .first<{
      bundle_id: number | null; entry: number | null; preview: string | null; bytes: number | null;
      token_id: string
    }>();
}

export {
  processed_processedField,
};

/** A version's source is eligible, read through the source table's identity index. */
const core_embedding_source_state_eligibleSource = (row: string): string => `(${core_embedding_source_state_import_CURRENT_EMBEDDING_SOURCES.map((source) =>
  `(${row}.type = '${source.type}' AND EXISTS (SELECT 1 FROM ${source.table}
    WHERE project_id = ${row}.project_id AND ${source.id} = ${row}.record_id AND (${source.eligible})))`).join(' OR ')})`;

/** A receipt names an eligible source's current revision. */
const core_embedding_source_state_currentSource = (row: string): string => `EXISTS (SELECT 1 FROM embedding_versions v
  WHERE v.project_id = ${row}.project_id AND v.type = ${row}.type AND v.record_id = ${row}.record_id
    AND v.revision = ${row}.revision AND ${core_embedding_source_state_eligibleSource('v')})`;

/** A calibration member names a current indexed spore receipt that is included in calibration. */
const core_embedding_source_state_currentHubnessMember = (row: string): string => `EXISTS (SELECT 1 FROM embedding_receipts r
  WHERE r.project_id = ${row}.project_id AND r.model_key = ${row}.model_key AND r.id = ${row}.id
    AND r.type = 'spore' AND r.ready = ${core_embedding_source_state_import_RECEIPT.ready} AND r.rewrites = 0 AND ${core_embedding_source_state_currentSource('r')})`;

/** The `model_key` of a passed-over source no model can read. */
const core_embedding_reconcile_ANY_MODEL = '';

/** How long a source a model's provider refused as input is passed over before that model is asked again. */
const core_embedding_reconcile_INPUT_REFUSAL_RETRY_MS = 24 * 60 * 60_000;

/**
 * Source `s`'s current revision is one embedding passes over under a model: its stored text cannot be read, or the model
 * refused it as input within `INPUT_REFUSAL_RETRY_MS`. Binds: `passedOverBinds(modelKey, now)`.
 */
const core_embedding_reconcile_PASSED_OVER = `(EXISTS (SELECT 1 FROM embedding_source_failures f WHERE f.project_id = s.project_id AND f.type = s.type
  AND f.record_id = s.record_id AND f.revision = s.revision AND f.model_key = '${core_embedding_reconcile_ANY_MODEL}') OR EXISTS (
  SELECT 1 FROM embedding_source_failures f WHERE f.project_id = s.project_id AND f.type = s.type AND f.record_id = s.record_id
    AND f.revision = s.revision AND f.model_key = ? AND f.recorded_at > ?))`;

const core_embedding_reconcile_passedOverBinds = (modelKey: string, now: number): [string, number] => [modelKey, now - core_embedding_reconcile_INPUT_REFUSAL_RETRY_MS];

/** A source embedding passes over, as Health and a switch list it: where it is, what it is, and why. */
interface core_embedding_reconcile_PassedOverSource {
  projectId: string;
  projectName: string | null;
  type: string;
  recordId: string;
  title: string;
  /** The model it is passed over under, or `ANY_MODEL` when its stored text cannot be read. */
  modelKey: string;
  reason: string;
  recordedAt: number;
}

/**
 * The current sources embedding passes over under any of `models` (and those no model can read), newest first, at most
 * `limit`, with how many there are in all; a source passed over for more than one reason is listed once, with its
 * latest. `notArchived` keeps to Projects that are not archived, and `unbuiltUnder` to sources holding no indexed
 * vector under that model.
 */
async function core_embedding_reconcile_passedOverSources(
  db: core_embedding_reconcile_import_RelationalStore, models: readonly string[], now: number, options: { limit: number; notArchived?: boolean; unbuiltUnder?: string },
): Promise<{ sources: core_embedding_reconcile_PassedOverSource[]; count: number }> {
  const scope = `FROM embedding_source_failures f JOIN embedding_sources s ON s.project_id = f.project_id AND s.type = f.type
    AND s.record_id = f.record_id AND s.revision = f.revision
    WHERE (f.model_key = '${core_embedding_reconcile_ANY_MODEL}' OR (f.model_key IN (SELECT value FROM json_each(?)) AND f.recorded_at > ?))
    ${options.notArchived === true ? 'AND EXISTS (SELECT 1 FROM projects p WHERE p.project_id = s.project_id AND p.archived_at IS NULL)' : ''}
    ${options.unbuiltUnder === undefined ? '' : `AND NOT EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type
      AND r.record_id = s.record_id AND r.revision = s.revision AND r.model_key = ? AND r.ready = ${core_embedding_reconcile_import_RECEIPT.ready})`}`;
  const binds = [JSON.stringify(models), now - core_embedding_reconcile_INPUT_REFUSAL_RETRY_MS, ...(options.unbuiltUnder === undefined ? [] : [options.unbuiltUnder])];
  const { results } = await prepareViewRead(db, "M33:core_embedding_reconcile_passedOverSources:0", `SELECT f.project_id AS projectId, (SELECT p.name FROM projects p WHERE p.project_id = f.project_id) AS projectName,
      f.type, f.record_id AS recordId, s.title, f.model_key AS modelKey, f.reason, MAX(f.recorded_at) AS recordedAt
    ${scope} GROUP BY f.project_id, f.type, f.record_id ORDER BY recordedAt DESC, f.record_id LIMIT ?`).bind(...binds, options.limit).all<core_embedding_reconcile_PassedOverSource>();
  const total = await prepareViewRead(db, "M33:core_embedding_reconcile_passedOverSources:1", `SELECT COUNT(*) AS n FROM (SELECT 1 ${scope} GROUP BY f.project_id, f.type, f.record_id)`).bind(...binds).first<{ n: number }>();
  return { sources: results, count: total?.n ?? 0 };
}

/**
 * A source `s` needs no write while its revision's receipt under the model is indexed or claimed for deletion; a claimed
 * receipt is written afresh once it is retired. Binds: the model key.
 */
const core_embedding_reconcile_SOURCE_HELD = `EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type
  AND r.record_id = s.record_id AND r.revision = s.revision AND r.model_key = ? AND r.ready <> ${core_embedding_reconcile_import_RECEIPT.journaled})`;

/** The earliest source refusal expiry under a model, read through its retry index. */
async function core_embedding_reconcile_embeddingFailureWakeAt(db: core_embedding_reconcile_import_RelationalStore, projectId: string, model: string, now: number): Promise<number | null> {
  const row = await prepareViewRead(db, "M33:core_embedding_reconcile_embeddingFailureWakeAt:0", `SELECT recorded_at AS at FROM embedding_source_failures
    WHERE project_id = ? AND model_key = ? AND recorded_at > ? ORDER BY recorded_at LIMIT 1`)
    .bind(projectId, model, now - core_embedding_reconcile_INPUT_REFUSAL_RETRY_MS).first<{ at: number }>();
  return row === null ? null : row.at + core_embedding_reconcile_INPUT_REFUSAL_RETRY_MS;
}

export { type core_embedding_reconcile_PassedOverSource, core_embedding_reconcile_passedOverSources, core_embedding_reconcile_embeddingFailureWakeAt };

interface core_embedding_selection_EmbeddingQuery { sql: string; binds: unknown[] }

interface core_embedding_selection_RetiringReceipt { id: string; model_key: string; type: core_embedding_selection_import_VectorType; record_id: string; revision: string; ready: number; updated_at: number }

/** Separate indexed ranges cover retired models, stale revisions and each deletion retry state. */
function core_embedding_selection_retirementQueries(projectId: string, retained: readonly string[], now: number): core_embedding_selection_EmbeddingQuery[] {
  const models = [...new Set(retained)].sort(core_embedding_selection_import_binaryOrder);
  const order = ' ORDER BY r.updated_at, r.id LIMIT 1';
  const prefix = 'SELECT r.* FROM embedding_receipts r WHERE r.project_id = ?';
  const ranges = Array.from({ length: models.length + 1 }, (_, index) => {
    const lower = models[index - 1], upper = models[index];
    return {
      sql: `${prefix} AND r.ready >= ${core_embedding_selection_import_RECEIPT.journaled}${lower === undefined ? '' : ' AND r.model_key > ?'}${upper === undefined ? '' : ' AND r.model_key < ?'}${order}`,
      binds: [projectId, ...(lower === undefined ? [] : [lower]), ...(upper === undefined ? [] : [upper])],
    };
  });
  return [
    ...ranges,
    ...models.map((model) => ({ sql: `${prefix} AND r.model_key = ? AND r.ready >= ${core_embedding_selection_import_RECEIPT.journaled} AND NOT ${core_embedding_source_state_currentSource('r')}${order}`, binds: [projectId, model] })),
    ...core_embedding_selection_import_DELETION_RETRIES.map(({ state, waitMs }) => ({
      sql: `${prefix} AND r.ready < ${core_embedding_selection_import_RECEIPT.journaled} AND r.ready = ? AND r.updated_at <= ?${order}`, binds: [projectId, state, now - waitMs],
    })),
  ];
}

async function core_embedding_selection_retiringReceipt(db: core_embedding_selection_import_RelationalStore, projectId: string, retained: readonly string[], now: number): Promise<core_embedding_selection_RetiringReceipt | null> {
  const candidates: core_embedding_selection_RetiringReceipt[] = [];
  for (const { sql, binds } of core_embedding_selection_retirementQueries(projectId, retained, now)) {
    const row = await prepareViewRead(db, "M31:core_embedding_selection_retiringReceipt:0", sql).bind(...binds).first<core_embedding_selection_RetiringReceipt>();
    if (row !== null) candidates.push(row);
  }
  return candidates.sort((a, b) => a.updated_at - b.updated_at || core_embedding_selection_import_binaryOrder(a.id, b.id))[0] ?? null;
}

/** Source work starts at the version index; eligibility is a point lookup in its owning source table. */
function core_embedding_selection_unwrittenQuery(projectId: string, model: string, now: number): core_embedding_selection_EmbeddingQuery {
  return {
    sql: `SELECT 1 AS pending FROM embedding_versions s WHERE s.project_id = ? AND ${core_embedding_source_state_eligibleSource('s')}
    AND NOT ${core_embedding_reconcile_SOURCE_HELD} AND NOT ${core_embedding_reconcile_PASSED_OVER} LIMIT 1`, binds: [projectId, model, ...core_embedding_reconcile_passedOverBinds(model, now)]
  };
}

/** New sources precede stale sources; each arm follows the attempted-at index in source order. */
function core_embedding_selection_sourceSelectionQuery(projectId: string, type: string, model: string, now: number, stale: boolean): core_embedding_selection_EmbeddingQuery {
  return {
    sql: `SELECT s.record_id, s.revision FROM embedding_versions s
    WHERE s.project_id = ? AND s.type = ? AND ${core_embedding_source_state_eligibleSource('s')} AND NOT ${core_embedding_reconcile_SOURCE_HELD} AND NOT ${core_embedding_reconcile_PASSED_OVER}
      AND ${stale ? '' : 'NOT '}EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type AND r.record_id = s.record_id)
    ORDER BY s.attempted_at, s.record_id LIMIT 1`, binds: [projectId, type, model, ...core_embedding_reconcile_passedOverBinds(model, now)]
  };
}

/** The earliest timed retry, found through the failure and deletion-state indexes. */
async function core_embedding_selection_embeddingWakeAt(db: core_embedding_selection_import_RelationalStore, projectId: string, writes: readonly string[], now: number): Promise<number | null> {
  const deadlines: number[] = [];
  for (const model of writes) {
    const deadline = await core_embedding_reconcile_embeddingFailureWakeAt(db, projectId, model, now);
    if (deadline !== null) deadlines.push(deadline);
  }
  for (const { state, waitMs } of core_embedding_selection_import_DELETION_RETRIES) {
    const row = await prepareViewRead(db, "M31:core_embedding_selection_embeddingWakeAt:0", `SELECT updated_at AS at FROM embedding_receipts
      WHERE project_id = ? AND ready < ${core_embedding_selection_import_RECEIPT.journaled} AND ready = ? AND updated_at > ? ORDER BY updated_at LIMIT 1`)
      .bind(projectId, state, now - waitMs).first<{ at: number }>();
    if (row !== null) deadlines.push(row.at + waitMs);
  }
  return deadlines.length === 0 ? null : Math.min(...deadlines);
}

export { type core_embedding_selection_RetiringReceipt, core_embedding_selection_retiringReceipt, core_embedding_selection_embeddingWakeAt };

type core_embedding_work_sweep_SweepPhase = 'sources' | 'receipts' | 'members';

interface core_embedding_work_sweep_SweepCursor { phase: core_embedding_work_sweep_SweepPhase; a: string; b: string; count: number; min: number | null; max: number | null; uncovered: boolean }

const core_embedding_work_sweep_begin = (phase: core_embedding_work_sweep_SweepPhase): core_embedding_work_sweep_SweepCursor => ({ phase, a: '', b: '', count: 0, min: null, max: null, uncovered: false });

const core_embedding_work_sweep_resume = (cursor: string | null, phase: core_embedding_work_sweep_SweepPhase): core_embedding_work_sweep_SweepCursor => cursor === null ? core_embedding_work_sweep_begin(phase) : JSON.parse(cursor) as core_embedding_work_sweep_SweepCursor;

const core_embedding_work_sweep_advance = (phase: core_embedding_work_sweep_SweepPhase): string => JSON.stringify(core_embedding_work_sweep_begin(phase));

/** One indexed page of source versions or receipts; no full-corpus probe runs during an idle safety sweep. */
async function core_embedding_work_sweep_embeddingSweep(
  db: core_embedding_work_sweep_import_RelationalStore, projectId: string, writes: readonly string[], retained: readonly string[], now: number, saved: string | null,
): Promise<core_embedding_work_sweep_import_WorkSweep> {
  const cursor = core_embedding_work_sweep_resume(saved, 'sources');
  if (cursor.phase === 'sources') {
    const predicate = writes.length === 0 ? '0' : `(${writes.map(() => `(NOT ${core_embedding_reconcile_SOURCE_HELD} AND NOT ${core_embedding_reconcile_PASSED_OVER})`).join(' OR ')})`;
    const rows = (await prepareViewRead(db, "M32:core_embedding_work_sweep_embeddingSweep:0", `WITH page AS MATERIALIZED (SELECT * FROM embedding_versions
      WHERE project_id = ? AND (type,record_id) > (?,?) ORDER BY type,record_id LIMIT ${core_embedding_work_sweep_import_WORK_SWEEP_PAGE})
      SELECT s.type,s.record_id,(${core_embedding_source_state_eligibleSource('s')} AND ${predicate}) AS pending FROM page s`)
      .bind(projectId, cursor.a, cursor.b, ...writes.flatMap((model) => [model, ...core_embedding_reconcile_passedOverBinds(model, now)]))
      .all<{ type: string; record_id: string; pending: number }>()).results;
    const last = rows.at(-1);
    return {
      pending: rows.some((row) => row.pending === 1), cursor: rows.length < core_embedding_work_sweep_import_WORK_SWEEP_PAGE ? core_embedding_work_sweep_advance('receipts')
        : JSON.stringify({ ...cursor, a: last!.type, b: last!.record_id })
    };
  }
  const rows = (await prepareViewRead(db, "M32:core_embedding_work_sweep_embeddingSweep:1", `WITH page AS MATERIALIZED (SELECT * FROM embedding_receipts
    WHERE project_id = ? AND (model_key,id) > (?,?) ORDER BY model_key,id LIMIT ${core_embedding_work_sweep_import_WORK_SWEEP_PAGE})
    SELECT r.*,${core_embedding_source_state_currentSource('r')} AS current FROM page r`).bind(projectId, cursor.a, cursor.b)
    .all<{ model_key: string; id: string; ready: number; updated_at: number; current: number }>()).results;
  const pending = rows.some((row) => row.ready >= core_embedding_work_sweep_import_RECEIPT.journaled ? !retained.includes(row.model_key) || row.current === 0
    : core_embedding_work_sweep_import_deletionRetryDue(row.ready, row.updated_at, now));
  const last = rows.at(-1);
  return { pending, cursor: rows.length < core_embedding_work_sweep_import_WORK_SWEEP_PAGE ? null : JSON.stringify({ ...cursor, a: last!.model_key, b: last!.id }) };
}

/** Bounded receipt and membership pages also recompute the moments-count invariant over a complete sweep cycle. */
async function core_embedding_work_sweep_hubnessSweep(
  db: core_embedding_work_sweep_import_RelationalStore, projectId: string, model: string, now: number, saved: string | null, paired: boolean,
): Promise<core_embedding_work_sweep_import_WorkSweep> {
  const cursor = core_embedding_work_sweep_resume(saved, 'receipts');
  if (cursor.phase === 'receipts') {
    const rows = (await prepareViewRead(db, "M32:core_embedding_work_sweep_hubnessSweep:0", `WITH page AS MATERIALIZED (SELECT * FROM embedding_receipts INDEXED BY idx_embedding_receipts_spore
      WHERE project_id = ? AND model_key = ? AND type = 'spore' AND ready = ${core_embedding_work_sweep_import_RECEIPT.ready} AND id > ? ORDER BY id LIMIT ${core_embedding_work_sweep_import_WORK_SWEEP_PAGE})
      SELECT r.id,r.rewrites,r.updated_at,${core_embedding_source_state_currentSource('r')} AS current,EXISTS (SELECT 1 FROM embedding_hubness_members m
        WHERE m.project_id=r.project_id AND m.model_key=r.model_key AND m.id=r.id) AS member FROM page r`)
      .bind(projectId, model, cursor.b).all<{ id: string; rewrites: number; updated_at: number; current: number; member: number }>()).results;
    const count = Math.min(2, cursor.count + rows.filter((row) => row.current === 1).length);
    const uncovered = cursor.uncovered || rows.some((row) => row.current === 1 && row.member === 0
      && !(row.rewrites >= core_embedding_work_sweep_import_VECTOR_REWRITE_LIMIT && row.updated_at <= now - core_embedding_work_sweep_import_VECTOR_LOST_MS));
    if ((!paired || count === 2) && uncovered) return { pending: true, cursor: null };
    const last = rows.at(-1);
    if (rows.length === core_embedding_work_sweep_import_WORK_SWEEP_PAGE) return { pending: false, cursor: JSON.stringify({ ...cursor, count, uncovered, b: last!.id }) };
    return { pending: false, cursor: paired && count < 2 ? null : core_embedding_work_sweep_advance('members') };
  }
  const active = await prepareViewRead(db, "M32:core_embedding_work_sweep_hubnessSweep:1", 'SELECT hubness_cursor FROM embedding_cursors WHERE project_id = ?').bind(projectId).first<{ hubness_cursor: string | null }>();
  if (active?.hubness_cursor != null) return { pending: true, cursor: null };
  const rows = (await prepareViewRead(db, "M32:core_embedding_work_sweep_hubnessSweep:2", `WITH page AS MATERIALIZED (SELECT * FROM embedding_hubness_members
    WHERE project_id = ? AND (model_key,id) > (?,?) ORDER BY model_key,id LIMIT ${core_embedding_work_sweep_import_WORK_SWEEP_PAGE})
    SELECT m.model_key,m.id,m.state,m.n,${core_embedding_source_state_currentHubnessMember('m')} AS current FROM page m`)
    .bind(projectId, cursor.a, cursor.b).all<{ model_key: string; id: string; state: number; n: number; current: number }>()).results;
  if (rows.some((row) => row.model_key !== model || row.state !== core_embedding_work_sweep_import_HUBNESS_MEMBER.settled || row.current === 0)) return { pending: true, cursor: null };
  const ns = rows.map((row) => row.n);
  const next = {
    ...cursor, count: cursor.count + rows.length,
    min: ns.length === 0 ? cursor.min : Math.min(cursor.min ?? Infinity, ...ns),
    max: ns.length === 0 ? cursor.max : Math.max(cursor.max ?? -Infinity, ...ns)
  };
  const last = rows.at(-1);
  return rows.length === core_embedding_work_sweep_import_WORK_SWEEP_PAGE
    ? { pending: false, cursor: JSON.stringify({ ...next, a: last!.model_key, b: last!.id }) }
    : { pending: next.count > 0 && (next.min !== next.count - 1 || next.max !== next.count - 1), cursor: null };
}

export { core_embedding_work_sweep_embeddingSweep, core_embedding_work_sweep_hubnessSweep };

/** Only currently referenced text blobs contribute to the search backlog. */
const core_search_index_REFERENCED = `EXISTS (SELECT 1 FROM prompt_batches p WHERE p.project_id = q.project_id AND p.blob_key = q.blob_key AND ${core_search_index_import_processedResourceProofSql('p.project_id', 'prompt', 'p.prompt_id', 'p.blob_key')})
  OR EXISTS (SELECT 1 FROM responses r WHERE r.project_id = q.project_id AND r.blob_key = q.blob_key AND ${core_search_index_import_processedResourceProofSql('r.project_id', 'response', 'r.response_id', 'r.blob_key')})
  OR EXISTS (SELECT 1 FROM plans p WHERE p.project_id = q.project_id AND p.blob_key = q.blob_key AND ${core_search_index_import_processedResourceProofSql('p.project_id', 'plan', 'p.plan_key', 'p.blob_key')})`;

/** The referenced text blobs the full-text index has not finished: every Project's, one Project's, or a set's. */
async function core_search_index_pendingSearchBlobs(db: core_search_index_import_RelationalStore, projects?: string | core_search_index_import_ProjectSet): Promise<number> {
  const scoped = projects === undefined ? null
    : typeof projects === 'string' ? { sql: 'q.project_id = ?', params: [projects] } : core_search_index_import_projectsBoundOnce(projects, 'q');
  const row = await prepareViewRead(db, "M27:core_search_index_pendingSearchBlobs:0", `SELECT COUNT(*) AS n FROM search_blob_queue q
    WHERE q.complete = 0 AND (${core_search_index_REFERENCED})${scoped === null ? '' : ` AND ${scoped.sql}`}`)
    .bind(...(scoped?.params ?? [])).first<{ n: number }>();
  return row?.n ?? 0;
}

/** The referenced text blobs still waiting for the full-text index, and the store instant of the longest-waiting of them. */
async function core_search_index_searchBacklog(db: core_search_index_import_RelationalStore): Promise<{ pending: number; oldestStoredAt: number | null }> {
  const row = await prepareViewRead(db, "M27:core_search_index_searchBacklog:0", `SELECT COUNT(*) AS n, MIN(b.received_at) AS oldest FROM search_blob_queue q
    JOIN blobs b ON b.project_id = q.project_id AND b.key = q.blob_key
    WHERE q.complete = 0 AND (${core_search_index_REFERENCED})`).first<{ n: number; oldest: number | null }>();
  return { pending: row?.n ?? 0, oldestStoredAt: row?.oldest ?? null };
}

export { core_search_index_pendingSearchBlobs, core_search_index_searchBacklog };

/** Indexed spore receipts under the model whose source revision is current. Binds: project id, model key. */
const core_embedding_hubness_sporeVectors = (columns: string) => `SELECT ${columns} FROM embedding_receipts r INDEXED BY idx_embedding_receipts_spore
  WHERE r.project_id = ? AND r.model_key = ? AND r.type = 'spore' AND r.ready = 1 AND ${core_embedding_source_state_currentSource('r')}`;

/** Every current spore vector, including one left out of calibration while the vector store does not return it. */
const core_embedding_hubness_SPORE_VECTORS = core_embedding_hubness_sporeVectors('r.id');

/** The spore vectors calibration covers: current, and not left out while the vector store does not return them. */
const core_embedding_hubness_CURRENT_SPORE_VECTORS = `${core_embedding_hubness_SPORE_VECTORS} AND r.rewrites = 0`;

const core_embedding_hubness_NOT_MEMBER = `NOT EXISTS (SELECT 1 FROM embedding_hubness_members m
  WHERE m.project_id = r.project_id AND m.model_key = r.model_key AND m.id = r.id)`;

/** Current spore vectors no member row names. Binds: project id, model key. */
const core_embedding_hubness_UNCOVERED = `${core_embedding_hubness_sporeVectors('r.id, r.updated_at, r.rewrites')} AND r.rewrites = 0 AND ${core_embedding_hubness_NOT_MEMBER}`;

/** Spore vectors left out of calibration while the vector store does not return them. Binds: project id, model key. */
const core_embedding_hubness_MISSING = `${core_embedding_hubness_sporeVectors('r.id, r.updated_at, r.rewrites')} AND r.rewrites > 0 AND ${core_embedding_hubness_NOT_MEMBER}`;

/** A left-out spore vector no longer written again: written again the most times, and still not returned `VECTOR_LOST_MS` after the last write. Binds: the lost cutoff. */
const core_embedding_hubness_ABANDONED = `(r.rewrites >= ${core_embedding_hubness_import_VECTOR_REWRITE_LIMIT} AND r.updated_at <= ?)`;

/** Settled members whose moments do not count exactly the other members. Binds: project id, model key. */
const core_embedding_hubness_MISCOUNTED = `SELECT COALESCE(MIN(n) <> COUNT(*) - 1 OR MAX(n) <> COUNT(*) - 1, 0) AS miscounted
  FROM embedding_hubness_members WHERE project_id = ? AND model_key = ?`;

/** A Project's spore vectors under one model left out of calibration while the vector store does not return them. */
interface core_embedding_hubness_MissingSporeVectors {
  /** Being written again, or due to be. */
  rewriting: number;
  /** Written again, and waited on for `VECTOR_LOST_MS` from that write. */
  waiting: number;
  /** Written again `VECTOR_REWRITE_LIMIT` times and still not returned; no longer written again. */
  abandoned: number;
}

async function core_embedding_hubness_missingSporeVectors(db: core_embedding_hubness_import_RelationalStore, projectId: string, model: string, now: number): Promise<core_embedding_hubness_MissingSporeVectors> {
  const row = await prepareViewRead(db, "M34:core_embedding_hubness_missingSporeVectors:0", `SELECT COALESCE(SUM(r.ready = 0 OR (r.updated_at <= ? AND r.rewrites < ${core_embedding_hubness_import_VECTOR_REWRITE_LIMIT})), 0) AS rewriting,
      COALESCE(SUM(r.ready = 1 AND r.updated_at > ?), 0) AS waiting,
      COALESCE(SUM(r.ready = 1 AND r.updated_at <= ? AND r.rewrites >= ${core_embedding_hubness_import_VECTOR_REWRITE_LIMIT}), 0) AS abandoned
    FROM embedding_receipts r JOIN embedding_sources s
      ON s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision
    WHERE r.project_id = ? AND r.model_key = ? AND r.rewrites > 0 AND r.ready >= 0 AND r.type = 'spore'`)
    .bind(now - core_embedding_hubness_import_VECTOR_LOST_MS, now - core_embedding_hubness_import_VECTOR_LOST_MS, now - core_embedding_hubness_import_VECTOR_LOST_MS, projectId, model).first<core_embedding_hubness_MissingSporeVectors>();
  return { rewriting: row?.rewriting ?? 0, waiting: row?.waiting ?? 0, abandoned: row?.abandoned ?? 0 };
}

/**
 * Calibration work is pending: a member of another model, an operation in progress, a member whose vector is no longer
 * current, a current vector no member covers, a left-out vector that is still looked for or due to be written again,
 * statistics still to publish, or settled moments that do not count the other members. Each probe starts at an indexed partition.
 */
function core_embedding_hubness_hubnessQueries(projectId: string, model: string, now: number): core_embedding_selection_EmbeddingQuery[] {
  return [
    ...['<', '>'].map((op) => ({ sql: `SELECT 1 FROM embedding_hubness_members WHERE project_id = ? AND model_key ${op} ? LIMIT 1`, binds: [projectId, model] })),
    { sql: 'SELECT 1 FROM embedding_hubness_members WHERE project_id = ? AND model_key = ? AND state > 0 LIMIT 1', binds: [projectId, model] },
    { sql: `SELECT 1 FROM embedding_hubness_members m WHERE m.project_id = ? AND m.model_key = ? AND m.state = 0 AND NOT ${core_embedding_source_state_currentHubnessMember('m')} LIMIT 1`, binds: [projectId, model] },
    { sql: `${core_embedding_hubness_UNCOVERED} LIMIT 1`, binds: [projectId, model] },
    { sql: `${core_embedding_hubness_MISSING} AND NOT ${core_embedding_hubness_ABANDONED} LIMIT 1`, binds: [projectId, model, now - core_embedding_hubness_import_VECTOR_LOST_MS] },
    { sql: 'SELECT 1 FROM embedding_cursors WHERE project_id = ? AND hubness_cursor IS NOT NULL', binds: [projectId] },
    { sql: `SELECT 1 FROM (${core_embedding_hubness_MISCOUNTED}) WHERE miscounted = 1`, binds: [projectId, model] },
  ];
}

async function core_embedding_hubness_recordedHubness(db: core_embedding_hubness_import_RelationalStore, projectId: string, model: string, now: number): Promise<boolean> {
  const hasPair = async () => (await prepareViewRead(db, "M34:core_embedding_hubness_recordedHubness:0", `${core_embedding_hubness_SPORE_VECTORS} LIMIT 2`).bind(projectId, model).all()).results.length === 2;
  return core_embedding_hubness_import_recordedWork(db, projectId, model, 'hubness', JSON.stringify({ predicate: core_embedding_hubness_import_WORK_PREDICATE_VERSION }), now, async () => {
    if (!(await hasPair())) return { pending: false };
    for (const statement of prepareHubnessWork(db, projectId, model, now)) if (await statement.first() !== null) return { pending: true };
    return { pending: false };
  }, (cursor) => core_embedding_work_sweep_hubnessSweep(db, projectId, model, now, cursor, true));
}

/** Calibration has work only with at least two current spore vectors. */
async function core_embedding_hubness_calibrationPending(db: core_embedding_hubness_import_RelationalStore, projectId: string, model: string, now: number): Promise<boolean> {
  return core_embedding_hubness_recordedHubness(db, projectId, model, now);
}

export { type core_embedding_hubness_MissingSporeVectors, core_embedding_hubness_missingSporeVectors, core_embedding_hubness_calibrationPending };

/** True while the switch `id` stands and is building. Binds: the switch id. */
const core_embedding_switch_store_BUILDING_SQL = `EXISTS (SELECT 1 FROM embedding_switches WHERE slot = 'deployment' AND id = ? AND state = 'building')`;

/** Source `s` belongs to a Project that is not archived: the sources a switch builds and counts. Binds nothing. */
const core_embedding_switch_store_COUNTED_SOURCE = `EXISTS (SELECT 1 FROM projects p WHERE p.project_id = s.project_id AND p.archived_at IS NULL)`;

/** Source `s` holds an indexed vector under a model. Binds: the model key. */
const core_embedding_switch_store_BUILT_SOURCE = `EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type
  AND r.record_id = s.record_id AND r.revision = s.revision AND r.model_key = ? AND r.ready = ${core_embedding_switch_store_import_RECEIPT.ready})`;

/** Counted sources neither built under a model nor passed over under it. Binds: `unbuiltBinds(modelKey, now)`. */
const core_embedding_switch_store_UNBUILT_SOURCES = `SELECT 1 FROM embedding_sources s WHERE ${core_embedding_switch_store_COUNTED_SOURCE} AND NOT ${core_embedding_switch_store_BUILT_SOURCE} AND NOT ${core_embedding_reconcile_PASSED_OVER}`;

const core_embedding_switch_store_unbuiltBinds = (modelKey: string, now: number): Array<string | number> => [modelKey, ...core_embedding_reconcile_passedOverBinds(modelKey, now)];

/**
 * The condition every statement of a switch's completion carries: it is still building, and no counted source is left
 * unbuilt as of `now`. Binds: the switch id, then `unbuiltBinds`.
 */
const core_embedding_switch_store_completionCondition = (sw: EmbeddingSwitch, now: number): { sql: string; params: Array<string | number> } =>
  ({ sql: `${core_embedding_switch_store_BUILDING_SQL} AND NOT EXISTS (${core_embedding_switch_store_UNBUILT_SOURCES})`, params: [sw.id, ...core_embedding_switch_store_unbuiltBinds(sw.modelKey, now)] });

/** The statement that ends a completed switch, carrying `completionCondition`. The sources it passed over stay recorded. */
const core_embedding_switch_store_completionStatements = (db: core_embedding_switch_store_import_RelationalStore, sw: EmbeddingSwitch, now: number): core_embedding_switch_store_import_PreparedStatement[] => {
  const condition = core_embedding_switch_store_completionCondition(sw, now);
  return [prepareViewRead(db, "M35:core_embedding_switch_store_completionStatements:0", `DELETE FROM embedding_switches WHERE slot = 'deployment' AND ${condition.sql}`).bind(...condition.params)];
};

/** The counted sources, and those holding an indexed vector under the switch's model. */
async function core_embedding_switch_store_switchProgress(db: core_embedding_switch_store_import_RelationalStore, modelKey: string): Promise<{ built: number; total: number }> {
  const row = await prepareViewRead(db, "M35:core_embedding_switch_store_switchProgress:0", `SELECT COUNT(*) AS total, COALESCE(SUM(${core_embedding_switch_store_BUILT_SOURCE}), 0) AS built FROM embedding_sources s WHERE ${core_embedding_switch_store_COUNTED_SOURCE}`)
    .bind(modelKey).first<{ total: number; built: number }>();
  return { built: row?.built ?? 0, total: row?.total ?? 0 };
}

/** The counted sources a new model would read, and their characters, with a blob-backed plan read up to its bounded prefix of `prefixChars`. */
async function core_embedding_switch_store_sourceTotals(db: core_embedding_switch_store_import_RelationalStore, prefixChars: number): Promise<{ sources: number; characters: number }> {
  const row = await prepareViewRead(db, "M35:core_embedding_switch_store_sourceTotals:0", `SELECT COUNT(*) AS sources, COALESCE(SUM(CASE WHEN blob_key IS NULL THEN MIN(COALESCE(length(text), 0), ?) ELSE ? END), 0) AS chars
    FROM embedding_sources s WHERE ${core_embedding_switch_store_COUNTED_SOURCE}`).bind(prefixChars, prefixChars).first<{ sources: number; chars: number }>();
  return { sources: row?.sources ?? 0, characters: row?.chars ?? 0 };
}

/** Whether every counted source holds an indexed vector under the model or is passed over under it. */
async function core_embedding_switch_store_switchComplete(db: core_embedding_switch_store_import_RelationalStore, modelKey: string, now: number): Promise<boolean> {
  const row = await prepareViewRead(db, "M35:core_embedding_switch_store_switchComplete:0", `SELECT NOT EXISTS (${core_embedding_switch_store_UNBUILT_SOURCES}) AS complete`).bind(...core_embedding_switch_store_unbuiltBinds(modelKey, now)).first<{ complete: number }>();
  return row?.complete === 1;
}

export { core_embedding_switch_store_switchProgress, core_embedding_switch_store_sourceTotals, core_embedding_switch_store_switchComplete };

export function prepareEmbeddingUnwritten(db: sessions_import_RelationalStore, projectId: string, model: string, now: number) {
  const { sql, binds } = core_embedding_selection_unwrittenQuery(projectId, model, now); return prepareViewRead(db, "M31:prepareEmbeddingUnwritten:0", sql).bind(...binds);
}

export function prepareEmbeddingSelection(db: sessions_import_RelationalStore, projectId: string, type: string, model: string, now: number, stale: boolean) {
  const { sql, binds } = core_embedding_selection_sourceSelectionQuery(projectId, type, model, now, stale); return prepareViewRead(db, "M31:prepareEmbeddingSelection:0", sql).bind(...binds);
}

export function prepareEmbeddingSource(db: sessions_import_RelationalStore, projectId: string, type: string, recordId: string, revision: string) {
  return prepareViewRead(db, "M33:prepareEmbeddingSource:0", `SELECT s.*, ${core_embedding_reconcile_import_registeredObjectKeySql('s.project_id', 's.blob_key')} AS object_key
      FROM embedding_sources s WHERE s.project_id = ? AND s.type = ? AND s.record_id = ? AND s.revision = ?`).bind(projectId, type, recordId, revision);
}

export function prepareEmbeddingReadyReceipt(db: sessions_import_RelationalStore, receipt: readonly [string, string, string], projectId: string, type: string, recordId: string, revision: string) {
  return prepareViewRead(db, "M33:prepareEmbeddingReadyReceipt:0", `UPDATE embedding_receipts SET ready = ${core_embedding_reconcile_import_RECEIPT.ready} WHERE project_id = ? AND model_key = ? AND id = ? AND ready = ${core_embedding_reconcile_import_RECEIPT.journaled}
        AND EXISTS (SELECT 1 FROM embedding_sources s WHERE s.project_id = ? AND s.type = ? AND s.record_id = ? AND s.revision = ?)`).bind(...receipt, projectId, type, recordId, revision);
}

export function prepareNextSearchBlob(db: sessions_import_RelationalStore) {
  return prepareViewRead(db, "M28:prepareNextSearchBlob:0", `SELECT q.project_id, q.blob_key, q.next_offset, ${core_search_index_import_registeredObjectKeySql('q.project_id', 'q.blob_key')} AS object_key
    FROM search_blob_queue q
    WHERE q.complete = 0 AND (${core_search_index_REFERENCED}) ORDER BY q.attempted_at, q.project_id, q.blob_key LIMIT 1`);
}

export function prepareLeavingHubness(db: sessions_import_RelationalStore, projectId: string, model: string, limit: number) {
  return prepareViewRead(db, "M34:prepareLeavingHubness:0", `SELECT m.id FROM embedding_hubness_members m WHERE m.project_id = ? AND m.model_key = ?
      AND m.state = ${core_embedding_hubness_import_MEMBER.settled} AND NOT ${core_embedding_source_state_currentHubnessMember('m')} ORDER BY m.id LIMIT ?`).bind(projectId, model, limit);
}

export function prepareJoiningHubness(db: sessions_import_RelationalStore, projectId: string, model: string, limit: number) {
  return prepareViewRead(db, "M34:prepareJoiningHubness:0", `${core_embedding_hubness_UNCOVERED} ORDER BY r.id LIMIT ?`).bind(projectId, model, limit);
}

export function prepareMissingHubness(db: sessions_import_RelationalStore, projectId: string, model: string, lostBefore: number, probe: string, limit: number) {
  return prepareViewRead(db, "M34:prepareMissingHubness:0", `${core_embedding_hubness_MISSING} ORDER BY ${core_embedding_hubness_ABANDONED}, ${core_embedding_hubness_ABANDONED} AND r.id <= ?, r.id LIMIT ?`).bind(projectId, model, lostBefore, lostBefore, probe, limit);
}

export function prepareHubnessPublication(db: sessions_import_RelationalStore, projectId: string, model: string) {
  return prepareViewRead(db, "M34:prepareHubnessPublication:0", `SELECT NOT EXISTS (SELECT 1 FROM embedding_hubness_members m WHERE m.project_id = ? AND m.model_key = ?
      AND m.state <> ${core_embedding_hubness_import_MEMBER.leaving} AND NOT ${core_embedding_source_state_currentHubnessMember('m')}) AND NOT EXISTS (${core_embedding_hubness_UNCOVERED}) AS complete`).bind(projectId, model, projectId, model);
}

export async function countCurrentSporeVectors(db: sessions_import_RelationalStore, projectId: string, model: string, covered: boolean) {
  const sql = covered ? core_embedding_hubness_CURRENT_SPORE_VECTORS : core_embedding_hubness_SPORE_VECTORS;
  return (await prepareViewRead(db, "M34:countCurrentSporeVectors:0", "SELECT COUNT(*) AS n FROM (" + sql + ")").bind(projectId, model).first<{ n: number }>())!.n;
}

export async function currentSporeVectorIds(db: sessions_import_RelationalStore, projectId: string, model: string) {
  return (await prepareViewRead(db, "M34:currentSporeVectorIds:0", core_embedding_hubness_CURRENT_SPORE_VECTORS + " ORDER BY r.id").bind(projectId, model).all<{ id: string }>()).results.map(row => row.id);
}

export function prepareSwitchedSettings(db: sessions_import_RelationalStore, choice: SwitchSettings, actor: string, nowMs: number, sw: EmbeddingSwitch, stamps: ReadonlyMap<string, string>) {
  const condition = core_embedding_switch_store_completionCondition(sw, nowMs);
  const statements = switchSettingLeaves.flatMap((part) => {
    const value = choice[part];
    if (value !== undefined) {
      return [prepareViewRead(db, "M35:prepareSwitchedSettings:0", `INSERT INTO deployment_settings (leaf, value, updated_at, updated_by, write_id) SELECT ?, ?, ?, ?, ? WHERE ${condition.sql}
        ON CONFLICT(leaf) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by, write_id = excluded.write_id`)
        .bind(part, JSON.stringify(value), nowMs, actor, crypto.randomUUID(), ...condition.params)];
    }
    return stamps.has(part) ? [
      prepareViewRead(db, "M35:prepareSwitchedSettings:1", `DELETE FROM deployment_settings WHERE leaf = ? AND ${condition.sql}`).bind(part, ...condition.params),
      prepareViewRead(db, "M35:prepareSwitchedSettings:2", `INSERT INTO deployment_setting_resets (leaf, reset_at, reset_by) SELECT ?, ?, ? WHERE ${condition.sql}
        ON CONFLICT(leaf) DO UPDATE SET reset_at = excluded.reset_at, reset_by = excluded.reset_by`).bind(part, nowMs, actor, ...condition.params),
    ] : [];
  });
  return statements;
}

export function prepareSwitchEnd(db: sessions_import_RelationalStore, sw: EmbeddingSwitch, now: number) {
  return core_embedding_switch_store_completionStatements(db, sw, now);
}

export { core_embedding_reconcile_ANY_MODEL, core_embedding_reconcile_INPUT_REFUSAL_RETRY_MS };

export function prepareRestoredSessionUnread(db: sessions_import_RelationalStore, sessions: string) {
  return prepareViewRead(db, "M46:prepareRestoredSessionUnread:0", `UPDATE session_read_facts SET eligible_prompts =
  (SELECT COUNT(*) FROM prompt_batches p WHERE p.project_id = session_read_facts.project_id
    AND p.session_id = session_read_facts.session_id AND ${extraction_coverage_unreadPromptSql('p')})
  WHERE (project_id, session_id) IN (SELECT json_extract(value, '$.projectId'), json_extract(value, '$.sessionId') FROM json_each(?))`).bind(sessions);
}

function extractionAckSource(servedId: string | undefined): string {
  return servedId === undefined
    ? `SELECT p.project_id, p.prompt_id AS record_id, p.session_id, NULL AS served_id FROM prompt_batches p
        JOIN agent_runs r ON r.project_id = p.project_id AND r.id = ?
        WHERE p.project_id = ? AND p.prompt_id = ?`
    : `SELECT m.project_id, m.record_id, m.session_id, m.served_id FROM run_served_material m
        WHERE m.run_id = ? AND m.project_id = ? AND m.served_id = ?`;
}

export function prepareExtractionAckItem(db: sessions_import_RelationalStore, projectId: string, runId: string, recordId: string | undefined, servedId: string | undefined) {
  return prepareViewRead(db, "M40:prepareExtractionAckItem:0", extractionAckSource(servedId)).bind(runId, projectId, recordId);
}

export function prepareRecordAcknowledgement(db: sessions_import_RelationalStore, projectId: string, runId: string, recordId: string | undefined, servedId: string | undefined, ackId: string, now: number) {
  const source = extractionAckSource(servedId);
  const params = [runId, projectId, recordId];
  return prepareViewRead(db, "M40:prepareRecordAcknowledgement:0", `INSERT INTO extraction_acks
    (project_id, ack_id, session_id, kind, record_id, served_id, run_id, acknowledged_at)
    SELECT material.project_id, ?, material.session_id, 'record', material.record_id, material.served_id, ?, ?
    FROM (${source}) material
    JOIN prompt_batches p ON p.project_id = material.project_id AND p.prompt_id = material.record_id AND p.session_id = material.session_id
    JOIN sessions s ON s.project_id = p.project_id AND s.session_id = p.session_id
    WHERE ${sessions_import_notTombstonedSql('s')}
      AND NOT EXISTS (SELECT 1 FROM extraction_acks a WHERE a.project_id = material.project_id
        AND a.record_id = material.record_id AND a.kind = 'record' AND a.run_id = ? AND a.served_id IS material.served_id)
    ON CONFLICT (project_id, served_id) DO NOTHING`).bind(ackId, runId, now, ...params, runId);
}

const release_PATHS_MARK_SQL = 'CASE WHEN ? = 1 THEN (SELECT COUNT(*) FROM tool_calls t WHERE t.project_id = g.project_id AND t.session_id = g.session_id) ELSE 0 END';

const release_FENCE = 'EXISTS (SELECT 1 FROM project_release_provenance f WHERE f.project_id = ? AND f.check_run_id = ? AND f.revision = ?)';

const release_HELD_SOURCE = "json_extract(knowledge_release_state.evidence_json, '$.source')";

const release_NEW_SOURCE = "json_extract(excluded.evidence_json, '$.source')";

const release_RELEASE_UPSERT = `ON CONFLICT(project_id, identity_key) DO UPDATE SET source_session_id = excluded.source_session_id, state = excluded.state, confidence = excluded.confidence,
    basis_kind = excluded.basis_kind, basis_ref = excluded.basis_ref, basis_sha = excluded.basis_sha,
    release_pr_number = excluded.release_pr_number, reason = excluded.reason,
    evidence_json = CASE WHEN knowledge_release_state.state IS excluded.state AND ${release_HELD_SOURCE} IS ${release_NEW_SOURCE}
      THEN json_set(excluded.evidence_json, '$.previous', json(COALESCE(json_extract(knowledge_release_state.evidence_json, '$.previous'), 'null')))
      ELSE json_set(excluded.evidence_json, '$.previous', json_object('state', knowledge_release_state.state, 'source', ${release_HELD_SOURCE},
        'basis_ref', knowledge_release_state.basis_ref, 'checked_at', knowledge_release_state.checked_at)) END,
    checked_at = excluded.checked_at, updated_at = excluded.checked_at
  WHERE knowledge_release_state.state <> 'released' OR (${release_HELD_SOURCE} IS NOT NULL AND ${release_HELD_SOURCE} IS NOT ${release_NEW_SOURCE})`;

const release_DERIVED = [['spores', 'spores', 'id'], ['plans', 'plans', 'plan_key']] as const;

export function prepareReleasePaths(db: sessions_import_RelationalStore, projectId: string, sessionId: string) {
  return prepareViewRead(db, "M44:prepareReleasePaths:0", `SELECT files_affected AS files FROM tool_calls
    WHERE project_id = ? AND session_id = ? AND files_affected IS NOT NULL LIMIT 200`).bind(projectId, sessionId);
}

export function prepareReleaseCandidates(db: sessions_import_RelationalStore, projectId: string, mapped: number, prefix: string, fingerprint: string | null, limit: number) {
  return prepareViewRead(db, "M44:prepareReleaseCandidates:0", `SELECT g.session_id AS sessionId, g.capture_point AS point, g.head_sha AS headSha,
      ${releaseCleanliness} AS cleanliness, ${release_PATHS_MARK_SQL} AS pathsMark, g.captured_at AS capturedAt
    FROM knowledge_git_provenance g
    WHERE g.project_id = ? AND g.session_id IS NOT NULL AND g.head_sha IS NOT NULL
      AND (g.capture_point = 'session_end' OR (g.capture_point = 'session_start' AND NOT EXISTS (
        SELECT 1 FROM knowledge_git_provenance e WHERE e.project_id = g.project_id AND e.identity_key = 'session:' || g.session_id || ':session_end')))
      AND NOT EXISTS (SELECT 1 FROM knowledge_release_state k
        WHERE k.project_id = g.project_id AND k.identity_key = ? || g.session_id
          AND ((k.state = 'released' AND json_extract(k.evidence_json, '$.source') IS NULL)
            OR (json_extract(k.evidence_json, '$.source') = g.capture_point || ':' || g.head_sha || ':' || ${releaseCleanliness}
              AND (k.state = 'released' OR (? IS NOT NULL AND json_extract(k.evidence_json, '$.refs_fingerprint') = ?
                AND json_extract(k.evidence_json, '$.paths_mark') IS ${release_PATHS_MARK_SQL})))))
    ORDER BY capturedAt DESC, sessionId LIMIT ?`).bind(mapped, projectId, prefix, fingerprint, fingerprint, mapped, limit);
}

export function prepareReleaseClassification(db: sessions_import_RelationalStore, projectId: string, sessionId: string, identity: string, columns: readonly unknown[], now: number, fence: readonly unknown[]) {
  const derived = (namespace: string, table: string, key: string) => prepareViewRead(db, "M44:prepareReleaseClassification:0", `INSERT INTO knowledge_release_state
      (project_id, id, identity_key, namespace, record_id, source_session_id, state, confidence, basis_kind, basis_ref,
       basis_sha, release_pr_number, reason, evidence_json, checked_at, created_at)
    SELECT project_id, 'rs_' || lower(hex(randomblob(16))), project_id || ':${namespace}:' || ${key}, '${namespace}', ${key}, session_id,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM ${table} WHERE project_id = ? AND session_id = ? AND ${release_FENCE} ${release_RELEASE_UPSERT}`).bind(...columns, now, projectId, sessionId, ...fence);
  return [
    prepareViewRead(db, "M44:prepareReleaseClassification:1", `INSERT INTO knowledge_release_state (project_id, id, identity_key, namespace, record_id, source_session_id,
        state, confidence, basis_kind, basis_ref, basis_sha, release_pr_number, reason, evidence_json, checked_at, created_at)
      SELECT ?, ?, ?, 'sessions', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${release_FENCE} ${release_RELEASE_UPSERT}`)
      .bind(projectId, `rs_${crypto.randomUUID().replaceAll('-', '')}`, identity, sessionId, sessionId, ...columns, now, ...fence),
    ...release_DERIVED.map(([namespace, table, key]) => derived(namespace, table, key)),
  ];
}

export function prepareReleasePropagation(db: sessions_import_RelationalStore, projectId: string, sessionPrefix: string, now: number, fence: readonly unknown[], limit: number) {
  return release_DERIVED.map(([namespace, table, key]) => prepareViewRead(db, "M44:prepareReleasePropagation:0", `INSERT INTO knowledge_release_state
      (project_id, id, identity_key, namespace, record_id, source_session_id, state, confidence, basis_kind, basis_ref,
       basis_sha, release_pr_number, reason, evidence_json, checked_at, created_at)
    SELECT r.project_id, 'rs_' || lower(hex(randomblob(16))), r.project_id || ':${namespace}:' || r.${key}, '${namespace}', r.${key}, r.session_id,
       k.state, k.confidence, k.basis_kind, k.basis_ref, k.basis_sha, k.release_pr_number, k.reason,
       json_remove(k.evidence_json, '$.previous'), k.checked_at, ?
      FROM ${table} r JOIN knowledge_release_state k ON k.project_id = r.project_id AND k.identity_key = ? || r.session_id
      WHERE r.project_id = ? AND ${release_FENCE} AND NOT EXISTS (SELECT 1 FROM knowledge_release_state d
        WHERE d.project_id = r.project_id AND d.identity_key = r.project_id || ':${namespace}:' || r.${key}
          AND (d.source_session_id IS r.session_id OR d.state = 'released'))
      LIMIT ? ${release_RELEASE_UPSERT}`).bind(now, sessionPrefix, projectId, ...fence, limit));
}

type ViewReadOperation = (typeof VIEW_READ_OPERATION_IDS)[number];

function prepareViewRead(db: sessions_import_RelationalStore, operation: ViewReadOperation, sql: string) {
  return db.prepare('/*vs:' + operation + '*/' + sql);
}

export function* prepareHubnessWork(db: sessions_import_RelationalStore, projectId: string, model: string, now: number) {
  for (const { sql, binds } of core_embedding_hubness_hubnessQueries(projectId, model, now)) yield prepareViewRead(db, "M34:core_embedding_hubness_recordedHubness:1", sql).bind(...binds);
}

export { turns_readTurnBodies, lineage_sessionsNamed, lineage_childIdsOf, sessions_instantStatements };

export function childrenRowsByPrompt(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string, collection: 'response' | 'attachment' | 'plan' | 'answer', promptIds: readonly string[], limit: number) {
  switch (collection) {
    case 'response': return children_listChildrenByPrompt(db, children_RESPONSE_QUERY, scope, sessionId, promptIds, limit);
    case 'attachment': return children_listChildrenByPrompt(db, children_ATTACHMENT_QUERY, scope, sessionId, promptIds, limit);
    case 'plan': return children_listChildrenByPrompt(db, children_TURN_PLAN_QUERY, scope, sessionId, promptIds, limit);
    case 'answer': return children_listChildrenByPrompt(db, turns_ANSWER_QUERY, scope, sessionId, promptIds, limit);
  }
}

export function turnChildPage(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string, collection: 'plan' | 'answer', opts: children_ChildOptions) {
  return collection === 'plan' ? children_listChildren(db, children_TURN_PLAN_QUERY, scope, sessionId, opts) : children_listChildren(db, turns_ANSWER_QUERY, scope, sessionId, opts);
}
