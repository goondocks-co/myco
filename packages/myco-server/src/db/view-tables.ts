/** Canonical fact and instance storage for each material kind. */
const MATERIALS = {
  prompt:{ kind:'prompt',fact:'prompt_batches',table:'view_prompts',id:'prompt_id',blobs:['blob_key'],fts:['text'] },
  response:{ kind:'response',fact:'responses',table:'view_responses',id:'response_id',blobs:['blob_key'],fts:['text'] },
  tool:{ kind:'tool',fact:'tool_calls',table:'view_tool_calls',id:'tool_call_id',blobs:['input_blob_key','output_blob_key'],fts:[] },
  plan:{ kind:'plan',fact:'plans',table:'view_plans',id:'plan_key',blobs:['blob_key'],fts:['title','content'] },
} as const;
export const VIEW_MATERIALS=Object.freeze(Object.values(MATERIALS));
