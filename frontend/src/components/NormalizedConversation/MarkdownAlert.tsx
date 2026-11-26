import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Info,
  Lightbulb,
  MessageSquareWarning,
  OctagonAlert,
} from 'lucide-react';

export type MarkdownAlertKind =
  | 'note'
  | 'tip'
  | 'important'
  | 'warning'
  | 'caution';

const ALERT_META: Record<
  MarkdownAlertKind,
  { label: string; Icon: typeof Info }
> = {
  note: { label: 'Note', Icon: Info },
  tip: { label: 'Tip', Icon: Lightbulb },
  important: { label: 'Important', Icon: MessageSquareWarning },
  warning: { label: 'Warning', Icon: AlertTriangle },
  caution: { label: 'Caution', Icon: OctagonAlert },
};

export function isMarkdownAlertKind(
  value: unknown
): value is MarkdownAlertKind {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(ALERT_META, value)
  );
}

export function MarkdownAlert({
  kind,
  title,
  children,
}: {
  kind: MarkdownAlertKind;
  title?: string;
  children: ReactNode;
}) {
  const { label, Icon } = ALERT_META[kind];
  const heading = title?.trim() || label;

  return (
    <aside
      className="conv-md-alert"
      data-alert-kind={kind}
      role="note"
      aria-label={heading}
    >
      <div className="conv-md-alert-title">
        <Icon aria-hidden="true" className="conv-md-alert-icon" />
        <span>{heading}</span>
      </div>
      <div className="conv-md-alert-body">{children}</div>
    </aside>
  );
}
