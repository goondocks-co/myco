import { claimableRawIdentitySql, effectiveRawOwnerSql } from './raw-claims.js';
import { TRANSCRIPT_PARSE_ADAPTER } from '../constants.js';

/** The projected fields whose complete bodies are Deployment-shared. */
export const PROCESSED_FIELDS = {
  prompt: { table: 'prompt_batches', id: 'prompt_id', text: 'text', blob: 'blob_key' },
  response: { table: 'responses', id: 'response_id', text: 'text', blob: 'blob_key' },
  plan: { table: 'plans', id: 'plan_key', text: 'content', blob: 'blob_key' },
  'tool-input': { table: 'tool_calls', id: 'tool_call_id', text: 'input', blob: 'input_blob_key' },
  'tool-output': { table: 'tool_calls', id: 'tool_call_id', text: 'output_preview', blob: 'output_blob_key' },
  attachment: { table: 'attachments', id: 'attachment_id', text: null, blob: 'blob_key' },
} as const;

/** A projected field carries a verified upload or a server-parser reference. */
export const processedReferenceSql = (alias: string, field: { blob: string }): string => `EXISTS (
  SELECT 1 FROM blobs b WHERE b.project_id = ${alias}.project_id AND b.key = ${alias}.${field.blob}
    AND (b.token_id = ${alias}.token_id
      OR EXISTS (SELECT 1 FROM raw_resources r JOIN member_credentials c ON c.id = ${alias}.token_id
        WHERE r.project_id = b.project_id AND r.kind = 'blob' AND r.resource_id = b.key
          AND r.classification = 'raw' AND ${effectiveRawOwnerSql('r.owner_member_id', 'r.provenance', 'r.revision', 'r.claim_member_id')} = c.member_id
          AND (r.provenance <> 'missing' OR ${claimableRawIdentitySql('r.project_id', 'r.kind', 'r.resource_id', 'c.member_id')}))
      OR EXISTS (SELECT 1 FROM events e WHERE e.project_id = ${alias}.project_id AND e.event_id = ${alias}.event_id
        AND e.producer_adapter = '${TRANSCRIPT_PARSE_ADAPTER}')))`;

/** An immutable admission for this exact logical field and stored body. */
export const processedResourceProofSql = (project: string, kind: keyof typeof PROCESSED_FIELDS, id: string, blob: string): string => `EXISTS (
  SELECT 1 FROM processed_resources pr WHERE pr.project_id = ${project} AND pr.kind = '${kind}'
    AND pr.resource_id = ${id} AND pr.blob_key = ${blob} AND pr.classification = 'processed')`;
