import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../lib/cn';

interface MarkdownContentProps {
  content: string;
  className?: string;
  /**
   * Compact rendering for list-row previews — headings are flattened to inline
   * body text and block margins are removed so the result lives happily inside
   * a `line-clamp-N` container.
   */
  compact?: boolean;
  /** Per-tag component overrides, passed straight through to ReactMarkdown. */
  components?: Components;
}

export function MarkdownContent({ content, className, compact = false, components }: MarkdownContentProps) {
  return (
    <div className={cn(compact ? 'prose-myco-compact' : 'prose-myco', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
