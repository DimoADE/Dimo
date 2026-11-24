import {
  useCallback,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from 'react';
import { Check, ChevronDown, Copy } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';

type TableCopyFormat = 'markdown' | 'csv' | 'tsv';

function extractTableMatrix(table: HTMLTableElement): string[][] {
  const rows = Array.from(table.querySelectorAll('tr'));
  return rows.map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) =>
      (cell.textContent ?? '').replace(/\s+/g, ' ').trim()
    )
  );
}

export function formatMatrixAsMarkdown(matrix: string[][]): string {
  if (matrix.length === 0) return '';
  const colCount = Math.max(...matrix.map((row) => row.length), 0);
  if (colCount === 0) return '';

  const escapeCell = (value: string) => value.replace(/\|/g, '\\|');
  const padRow = (row: string[]) =>
    Array.from({ length: colCount }, (_, idx) => escapeCell(row[idx] ?? ''));

  const header = `| ${padRow(matrix[0] ?? []).join(' | ')} |`;
  const separator = `| ${Array(colCount).fill('---').join(' | ')} |`;
  const body = matrix
    .slice(1)
    .map((row) => `| ${padRow(row).join(' | ')} |`);
  return [header, separator, ...body].join('\n');
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function formatMatrixAsDelimited(
  matrix: string[][],
  delimiter: ',' | '\t'
): string {
  return matrix
    .map((row) =>
      row
        .map((cell) =>
          delimiter === ',' ? escapeCsvCell(cell) : cell.replace(/[\t\r\n]+/g, ' ')
        )
        .join(delimiter)
    )
    .join('\n');
}

export function MarkdownTable({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'table'>) {
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [copied, triggerCopied] = useTemporaryFlag(1400);
  const [copiedFormat, setCopiedFormat] = useState<TableCopyFormat>('markdown');

  const handleCopy = useCallback(
    async (format: TableCopyFormat) => {
      const table = tableRef.current;
      if (!table) return;
      const matrix = extractTableMatrix(table);
      if (matrix.length === 0) return;

      const text =
        format === 'markdown'
          ? formatMatrixAsMarkdown(matrix)
          : formatMatrixAsDelimited(matrix, format === 'csv' ? ',' : '\t');

      try {
        await navigator.clipboard.writeText(text);
        setCopiedFormat(format);
        triggerCopied();
      } catch {
        // Clipboard access depends on host WebView permission state.
      }
    },
    [triggerCopied]
  );

  return (
    <div className="conv-md-table-container">
      <div className="conv-md-table-actions" aria-hidden="false">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={`conv-md-table-copy${copied ? ' is-copied' : ''}`}
              title={copied ? `已复制 (${copiedFormat.toUpperCase()})` : '复制表格'}
              aria-label="复制表格"
            >
              {copied ? (
                <Check className="h-3 w-3" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              <ChevronDown className="h-2.5 w-2.5 opacity-75" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[140px]">
            <DropdownMenuItem onSelect={() => void handleCopy('markdown')}>
              Copy as Markdown
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleCopy('csv')}>
              Copy as CSV
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleCopy('tsv')}>
              Copy as TSV
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        className="conv-md-table-scroll"
        role="group"
        tabIndex={0}
        aria-label="Table"
      >
        <table
          ref={tableRef}
          className={className ? `conv-md-table ${className}` : 'conv-md-table'}
          {...props}
        >
          {children}
        </table>
      </div>
    </div>
  );
}
