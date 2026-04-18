/**
 * myco_save_plan — persist a plan directly into Myco for the current session.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';

interface SavePlanInput {
  session_id: string;
  content: string;
  source_path?: string;
  plan_key?: string;
  title?: string;
  status?: string;
  tags?: string[];
}

interface SavePlanResult {
  id: string;
  logical_key: string;
  title: string | null;
  status: string;
  source_path: string | null;
  session_id: string | null;
  prompt_batch_id: number | null;
  tags: string[];
  created_at: number;
  updated_at: number | null;
}

export async function handleMycoSavePlan(
  input: SavePlanInput,
  client: DaemonClient,
): Promise<SavePlanResult | null> {
  const result = await client.post('/api/mcp/plans', {
    session_id: input.session_id,
    content: input.content,
    source_path: input.source_path,
    plan_key: input.plan_key,
    title: input.title,
    status: input.status,
    tags: input.tags,
  });

  if (!result.ok || !result.data) return null;
  return result.data as SavePlanResult;
}
