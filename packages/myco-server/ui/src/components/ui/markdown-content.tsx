import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../lib/cn';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/** Stored Markdown — instructions, digests, skills — rendered as prose. */
export function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div className={cn('prose-myco', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
