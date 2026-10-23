type Decision = { twin: string } | { absent: string };

/** Every old-table index has a declared instance-storage access path or a semantic exclusion. */
export const VIEW_ACCESS_PATH_DECISIONS: Readonly<Record<string, Decision>> = {
  idx_prompt_batches_session: { twin: 'idx_view_prompts_created' },
  idx_prompt_batches_first: { twin: 'idx_view_prompts_created' },
  idx_prompt_batches_turns: { twin: 'idx_view_prompts_origin' },
  idx_prompt_batches_parent: { twin: 'idx_view_prompts_children' },
  idx_prompt_batches_user_received: { twin: 'idx_view_prompts_received' },
  idx_prompt_batches_claimed: { twin: 'idx_view_prompts_claimed' },
  idx_prompt_batches_unprocessed: { absent: 'View extraction eligibility uses source/record acknowledgements, not the retired processed flag.' },
  idx_prompt_batches_blob_key: { twin: 'idx_view_prompts_blob_key' },
  idx_prompt_batches_search_blob: { twin: 'idx_view_prompts_blob_key' },
  idx_responses_session: { twin: 'idx_view_responses_created' },
  idx_responses_prompt: { twin: 'idx_view_responses_prompt' },
  idx_responses_blob_key: { twin: 'idx_view_responses_blob_key' },
  idx_responses_search_blob: { twin: 'idx_view_responses_blob_key' },
  idx_tool_calls_session: { twin: 'idx_view_tool_calls_created' },
  idx_tool_calls_activity: { twin: 'idx_view_tool_calls_created' },
  idx_tool_calls_prompt: { twin: 'idx_view_tool_calls_prompt' },
  idx_tool_calls_tool: { twin: 'idx_view_tool_calls_tool' },
  idx_tool_calls_input_blob_key: { twin: 'idx_view_tool_calls_input_blob_key' },
  idx_tool_calls_output_blob_key: { twin: 'idx_view_tool_calls_output_blob_key' },
  idx_plans_session: { twin: 'idx_view_plans_updated' },
  idx_plans_prompt: { twin: 'idx_view_plans_prompt_updated' },
  idx_plans_blob_key: { twin: 'idx_view_plans_blob_key' },
  idx_plans_search_blob: { twin: 'idx_view_plans_blob_key' },
  idx_plans_updated_deployment: { twin: 'idx_view_plans_updated_deployment' },
};
