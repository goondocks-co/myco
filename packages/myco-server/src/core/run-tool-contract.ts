/** A refused run operation always carries its repair call beside the offending input or state. */
export interface RunRefusal {
  what: string;
  actual: string;
  next: { tool: string; op: string; [argument: string]: unknown };
  repair?: string;
  read?: boolean;
}

export function runRefusal({ what, actual, next, repair, read }: RunRefusal): { ok: false; error: string } {
  const { tool, ...args } = next;
  const error = `${read ? 'Not read' : 'Not saved'}: ${what}; ${actual.replace(/\.+$/, '')}. ${repair === undefined ? '' : `${repair} `}Next call: ${tool} ${JSON.stringify(args)}.`;
  if (error.split('Next call:').length !== 2) throw new Error('A run refusal requires a bare cause and one next call.');
  return { ok: false, error };
}

export const RUN_ACTION_MAX_CHARS = 192;
export const RUN_KEY_MAX_CHARS = 192;
export const RUN_VERSION_CHARS = 16;
export const RUN_SPORE_ID_MAX_CHARS = 192;
export const RUN_SPORE_CURSOR_MAX_CHARS = 256;

export const REPORT_NEXT = { tool: 'myco_run', op: 'report' } as const;

export type RefuseRunWrite = (refusal: RunRefusal) => Promise<ReturnType<typeof runRefusal>>;
