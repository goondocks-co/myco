import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../lib/cn';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/** Stored markdown sits inside a page that already owns its top headings, so the document's own headings step down two levels and never outrank the page's. */
const DEMOTED_HEADINGS: Components = {
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
};

/** Stored Markdown — instructions, digests, skills, prompts, plans — rendered as prose. */
export function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div className={cn('prose-myco', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={DEMOTED_HEADINGS}>{content}</ReactMarkdown>
    </div>
  );
}
