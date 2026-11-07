/** A refused run operation always carries its repair call beside the offending input or state. */
export interface RunRefusal {
  what: string;
  actual: string;
  next: { tool: string; op: string; [argument: string]: unknown };
  repair?: string;
}

export function runRefusal({ what, actual, next, repair }: RunRefusal): { ok: false; error: string } {
  const { tool, ...args } = next;
  return {
    ok: false,
    error: `Not saved: ${what}; ${actual.replace(/\.+$/, '')}. ${repair === undefined ? '' : `${repair} `}Next call: ${tool} ${JSON.stringify(args)}.`,
  };
}

export const RUN_ACTION_MAX_CHARS = 192;
export const RUN_KEY_MAX_CHARS = 192;
export const RUN_VERSION_CHARS = 16;
export const RUN_SPORE_ID_MAX_CHARS = 192;
export const RUN_SEARCH_MAX_CHARS = 1024;

export const REPORT_NEXT = { tool: 'myco_run', op: 'report' } as const;
