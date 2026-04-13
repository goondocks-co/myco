import type { LogEntry } from '../daemon/logger.js';

/** Max display length for extra field values in pretty-printed output. */
const LOG_VALUE_MAX_DISPLAY = 80;

/** Core fields that are handled positionally, not as extras. */
const CORE_FIELDS: ReadonlyArray<keyof LogEntry> = ['timestamp', 'level', 'component', 'message'];

export function formatLogLine(entry: LogEntry): string {
  const time = formatLocalTime(entry.timestamp);
  const lvl = entry.level.toUpperCase().padEnd(5);
  const comp = `[${entry.component}]`.padEnd(14);

  const extras: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (CORE_FIELDS.includes(key)) continue;
    const str = String(value);
    const display = str.length > LOG_VALUE_MAX_DISPLAY
      ? str.slice(0, LOG_VALUE_MAX_DISPLAY) + '...'
      : str;
    extras.push(`${key}=${display}`);
  }

  const extraStr = extras.length > 0 ? '  ' + extras.join(' ') : '';
  return `${time} ${lvl} ${comp} ${entry.message}${extraStr}`;
}

export function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function parseIntFlag(args: string[], long: string, short?: string): number | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === long || (short && args[i] === short)) {
      const val = parseInt(args[i + 1], 10);
      return isNaN(val) ? undefined : val;
    }
  }
  return undefined;
}

export function parseStringFlag(args: string[], long: string, short?: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === long || (short && args[i] === short)) {
      return args[i + 1];
    }
  }
  return undefined;
}
