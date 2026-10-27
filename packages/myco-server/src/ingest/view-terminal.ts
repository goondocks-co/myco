import { SESSION_END_SETTLE_MS } from '../constants.js';
import { TRANSCRIPT_IDLE_MS } from './parse.js';

/** The common parser's terminal causes, applied to an instance-owned continuation. */
export function viewTerminalSql(checkpoint: string, transcript: string, session: string): string {
  return `(json_extract(${checkpoint}.parser_context,'$.mycoParserUnfinished')=1 AND
    (?=1 OR ${transcript}.imported_at IS NOT NULL OR ${transcript}.last_received_at<=?
      OR ${session}.ended_at<=? AND ${transcript}.last_received_at<=?
      OR json_extract(${checkpoint}.parser_context,'$.mycoParserReplyUnfinished')=1 AND ${session}.working_since IS NULL
        AND ${session}.last_turn_end_at>json_extract(${checkpoint}.parser_context,'$.mycoParserReplyLatestAt')))`;
}

export const viewTerminalParams = (now: number, completeFile = false): number[] => [
  completeFile ? 1 : 0,
  now - TRANSCRIPT_IDLE_MS,
  now - SESSION_END_SETTLE_MS,
  now - SESSION_END_SETTLE_MS,
];
