import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../lib/cn';

export interface MarkdownProps {
  /** Stored Markdown: a response, a prompt, a plan. */
  content: string;
  className?: string;
}

/** Stored Markdown sits inside a page that owns its top headings, so the document's own headings step down two levels and never outrank the page's. */
const DEMOTED_HEADINGS: Components = {
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
};

/** Stored Markdown rendered as reading prose on the type scale. */
export function Markdown({ content, className }: MarkdownProps) {
  return (
    <div className={cn('prose-read min-w-0', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={DEMOTED_HEADINGS}>{content}</ReactMarkdown>
    </div>
  );
}
