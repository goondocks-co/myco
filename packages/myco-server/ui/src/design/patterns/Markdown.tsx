import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../lib/cn';

export interface MarkdownProps {
  /** Stored Markdown: a response, a prompt, a plan. */
  content: string;
  /** Leaves out any raw HTML the Markdown carries, rather than showing it as text. */
  skipHtml?: boolean;
  className?: string;
}

/**
 * Stored Markdown sits inside a page that owns its top headings, so the
 * document's own headings step down two levels and never outrank the page's. A
 * task list's box is read-only and says in words whether its item is done.
 */
const COMPONENTS: Components = {
  input: ({ type, checked, disabled }) => (type === 'checkbox'
    ? <input type="checkbox" checked={checked ?? false} disabled={disabled ?? true} readOnly aria-label={checked ? 'Done' : 'Not done'} />
    : <input type={type} disabled readOnly />),
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
};

/** Stored Markdown rendered as reading prose on the type scale. */
export function Markdown({ content, skipHtml = false, className }: MarkdownProps) {
  return (
    <div className={cn('prose-read min-w-0', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml={skipHtml}>{content}</ReactMarkdown>
    </div>
  );
}
