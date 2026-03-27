import { X } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../../lib/cn';
import { renderField, getMetadataEntries } from './field-renderers';
import type { LogEntry } from '../../hooks/use-logs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEVEL_COLOR: Record<string, string> = {
  debug: 'text-on-surface-variant/60',
  info: 'text-primary',
  warn: 'text-secondary',
  error: 'text-tertiary',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface LogDetailProps {
  entry: LogEntry;
  resolved?: Record<string, unknown>;
  onClose: () => void;
}

export function LogDetail({ entry, resolved, onClose }: LogDetailProps) {
  const metadata = getMetadataEntries(entry.data);

  return (
    <div className="flex h-full flex-col bg-surface-container-low">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/10">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
            {entry.kind}
          </Badge>
          <span className={cn('text-xs font-medium', LEVEL_COLOR[entry.level])}>
            {entry.level.toUpperCase()}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          onClick={onClose}
          aria-label="Close detail panel"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Timestamp */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-on-surface-variant/50 mb-0.5">
            Timestamp
          </div>
          <div className="font-mono text-xs tabular-nums">
            {new Date(entry.timestamp).toLocaleString()}
          </div>
        </div>

        {/* Message */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-on-surface-variant/50 mb-0.5">
            Message
          </div>
          <div className="text-sm text-on-surface leading-relaxed">
            {entry.message}
          </div>
        </div>

        {/* Session link (if resolved) */}
        {entry.session_id && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-on-surface-variant/50 mb-0.5">
              Session
            </div>
            <div className="flex items-center gap-2 text-xs">
              {renderField('session_id', entry.session_id)}
              {resolved?.session_title && (
                <span className="text-on-surface-variant/70">
                  {String(resolved.session_title)}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Metadata fields */}
        {metadata.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-on-surface-variant/50 mb-1.5">
              Metadata
            </div>
            <div className="space-y-2">
              {metadata.map(([key, value]) => (
                <div key={key}>
                  <div className="text-[10px] text-on-surface-variant/40 mb-0.5">
                    {key}
                  </div>
                  <div className="text-xs">
                    {renderField(key, value)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer: entry ID */}
      <div className="px-4 py-2 border-t border-outline-variant/10">
        <span className="font-mono text-[10px] text-on-surface-variant/40 tabular-nums">
          id: {entry.id}
        </span>
      </div>
    </div>
  );
}
