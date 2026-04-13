import { cn } from '../../lib/cn';

/* ---------- Component ---------- */

interface PromptViewerProps {
  /** The prompt or markdown content to display. */
  content: string;
  /** Title shown above the viewer. */
  title?: string;
  /** Optional filename label. */
  filename?: string;
  className?: string;
}

export function PromptViewer({ content, title, filename, className }: PromptViewerProps) {
  return (
    <div className={cn('flex flex-col h-full', className)}>
      {(title || filename) && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--ghost-border)]">
          {title && (
            <span className="font-sans text-sm font-medium text-on-surface">{title}</span>
          )}
          {filename && (
            <span className="font-mono text-xs text-on-surface-variant">{filename}</span>
          )}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        <pre className="rounded-md bg-surface-container-lowest p-4 font-mono text-xs text-on-surface-variant whitespace-pre-wrap break-words leading-relaxed min-h-[300px]">
          {content || 'No content available.'}
        </pre>
      </div>
    </div>
  );
}
