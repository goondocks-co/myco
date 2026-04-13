import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';
import { type LogLevel, levelBadgeVariant, levelDotColor } from '../../lib/constants';

export interface LogRowEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  [key: string]: unknown;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}

export function LogRow({ entry }: { entry: LogRowEntry }) {
  return (
    <tr className="hover:bg-surface-container-high/30 transition-colors">
      <td className="whitespace-nowrap py-1.5 pl-4 pr-3 text-on-surface-variant/60 align-top w-[68px]">
        {formatTimestamp(entry.timestamp)}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 align-top w-[20px]">
        <div className={cn('h-2 w-2 rounded-full mt-1', levelDotColor(entry.level))} />
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 align-top w-[54px]">
        <Badge variant={levelBadgeVariant(entry.level)} className="px-1.5 py-0 text-[10px] uppercase">
          {entry.level}
        </Badge>
      </td>
      <td className="py-1.5 pr-4 text-on-surface align-top break-words">
        {entry.message}
      </td>
    </tr>
  );
}
