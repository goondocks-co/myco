import { expect, test } from 'bun:test';
import { withViewStores, captureViewSession, captureViewTranscript } from './helpers/view-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { withViewWriterDriver } from '../helpers/statement-recorder.js';
import { fixtureFlipEnvelope } from '../helpers/view-flip-envelope.js';
import { createEmptyView, requestViewRebuild, tryPublishView } from '@myco-server-worker/ingest/view-lifecycle.js';
import { claimViewBuild, SERIAL_VIEW_BUDGET } from '@myco-server-worker/ingest/view-build-queue.js';
import { parseViewOnce } from '@myco-server-worker/ingest/view-parse.js';

test('fresh sequences follow checkpoint ordinal and source offset across material kinds', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const now = Date.now(),
        blobs = memoryBlobStore();
      await captureViewSession(db);
      await createEmptyView(db, 'project', 'session', now);
      const first = 'tx_' + 'f'.repeat(32),
        second = 'tx_' + '0'.repeat(32);
      const content = (label: string) =>
        [
          { v: 1, type: 'prompt', text: label + ' prompt', at: now },
          { v: 1, type: 'tool', name: 'Read', input: { path: label + 'a' }, output: 'one', at: now + 1 },
          { v: 1, type: 'tool', name: 'Read', input: { path: label + 'b' }, output: 'two', at: now + 2 },
          { v: 1, type: 'response', text: label + ' answer', at: now + 3 },
          { v: 1, type: 'prompt', text: label + ' second', at: now + 4 },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n') + '\n';
      const env = await captureViewTranscript(db, blobs, 'session', first, content('first'), now, 0, 'opencode');
      await captureViewTranscript(db, blobs, 'session', second, content('second'), now + 10, 0, 'opencode');
      const instance = await requestViewRebuild(db, 'project', 'session', now + 10);
      const target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now + 10))!;
      for (let pass = 0; pass < 16; pass++)
        if (
          (await parseViewOnce(env, target, now + 10, {
            calls: 500,
            deadline: Date.now() + 10000,
            clock: Date.now,
            completeFile: true,
          })) === null
        )
          break;
      expect((await tryPublishView(db, target, now + 10, fixtureFlipEnvelope(store))).published).toBe(true);
      const rows = (
        await db
          .prepare(
            `SELECT c.ordinal,r.source_offset,r.kind,r.record_id,v.material_seq FROM (
      SELECT instance_id,source_transcript_id,source_offset,'prompt' kind,prompt_id record_id,0 kind_rank FROM view_prompts WHERE project_id=?
      UNION ALL SELECT instance_id,source_transcript_id,source_offset,'response',response_id,1 FROM view_responses WHERE project_id=?
      UNION ALL SELECT instance_id,source_transcript_id,source_offset,'tool',tool_call_id,2 FROM view_tool_calls WHERE project_id=?
      UNION ALL SELECT instance_id,source_transcript_id,source_offset,'plan',plan_key,3 FROM view_plans WHERE project_id=?
      ) r JOIN view_checkpoints c ON c.project_id=? AND c.instance_id=r.instance_id AND c.transcript_id=r.source_transcript_id
      JOIN material_versions v ON v.project_id=c.project_id AND v.kind=r.kind AND v.record_id=r.record_id
      WHERE r.instance_id=? ORDER BY c.ordinal,r.source_offset,r.kind_rank,r.record_id`,
          )
          .bind('project', 'project', 'project', 'project', 'project', instance)
          .all<{ ordinal: number; source_offset: number; kind: string; material_seq: number }>()
      ).results;
      expect(rows.length, store).toBeGreaterThanOrEqual(10);
      expect(rows.map((row) => row.material_seq)).toEqual(rows.map((_, index) => index + 1));
      expect(rows.slice(0, 5).map((row) => row.kind)).toEqual(['prompt', 'tool', 'tool', 'response', 'prompt']);
      const checkpoints = (
        await db
          .prepare('SELECT transcript_id FROM view_checkpoints WHERE project_id=? AND instance_id=? ORDER BY ordinal')
          .bind('project', instance)
          .all<{ transcript_id: string }>()
      ).results;
      expect(checkpoints.map((row) => row.transcript_id)).toEqual([first, second]);
    }),
  );
}, 120000);
