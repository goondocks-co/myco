import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check } from 'lucide-react';
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
 * task list's item keeps its words as its name, marked done with a check and
 * muted text, and says so in words for assistive technology.
 */
const COMPONENTS: Components = {
  li: ({ node, className, children }) => {
    if (!String(className ?? '').split(' ').includes('task-list-item')) return <li className={className}>{children}</li>;
    const box = node?.children.find((child) => child.type === 'element' && child.tagName === 'input');
    const done = box !== undefined && box.type === 'element' && box.properties.checked === true;
    return <li className={cn(className, done && 'task-done')} data-task={done ? 'done' : 'open'}>{children}</li>;
  },
  // The item's own words stay its name; whether it is done is a mark, and words for assistive technology.
  input: ({ type, checked }) => (type === 'checkbox'
    ? (
      <>
        {checked
          ? <Check aria-hidden className="task-box task-box-done" strokeWidth={2.5} />
          : <span aria-hidden className="task-box" />}
        <span className="sr-only">{checked ? 'Done:' : 'To do:'}</span>
      </>
    )
    : null),
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
