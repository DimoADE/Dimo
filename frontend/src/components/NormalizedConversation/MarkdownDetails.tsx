import type { ComponentPropsWithoutRef } from 'react';

export function MarkdownDetails({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'details'>) {
  return (
    <details
      className={`conv-md-details${className ? ` ${className}` : ''}`}
      {...props}
    >
      {children}
    </details>
  );
}

export function MarkdownSummary({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'summary'>) {
  return (
    <summary
      className={`conv-md-summary${className ? ` ${className}` : ''}`}
      {...props}
    >
      <span className="conv-md-summary-chevron" aria-hidden="true" />
      <span className="conv-md-summary-label">{children}</span>
    </summary>
  );
}
