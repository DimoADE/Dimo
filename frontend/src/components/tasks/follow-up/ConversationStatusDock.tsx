import { Badge } from '@astryxdesign/core/Badge';
import {
  ChevronDown,
  ChevronUp,
  Copy,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ConversationStatusNotice,
  StatusNoticeActor,
} from '@/contexts/ConversationStatusContext';
import { TurnErrorCard } from '@/components/NormalizedConversation/conversation/TurnErrorCard';
import {
  ConversationStatusDetailsContent,
  ConversationStatusDetailsTrigger,
} from '@/components/NormalizedConversation/conversation/ConversationStatusDetails';
import {
  getConversationSessionNoticeView,
  stripInternalErrorPrefixes,
} from '@/features/conversation/sessionNoticeCopy';
import {
  rememberVisibleSessionAnnouncements,
  useConversationStatusDismissal,
} from '@/features/conversation/conversationStatusDismissal';
import { sessionNoticeNeedsRebind } from '@/features/conversation/sessionNoticeNeedsRebind';
import { getErrorMessage } from '@/lib/modals';
import { toast } from '@/components/ui/toast';
import { AgentRuntimeStatus } from './AgentRuntimeStatus';
import { SessionNoticeActions } from './SessionNoticeActions';
import { StatusNoticeActorChip } from './StatusNoticeActorChip';

type ConversationStatusDockProps = {
  notices: ConversationStatusNotice[];
  localError?: string | null;
  onDismissLocalError?: () => void;
  dismissalScope?: string | null;
  placement?: 'composer' | 'panel';
  extra?: ReactNode;
  maxVisibleCount?: number;
};

export function ConversationStatusDock({
  notices,
  localError,
  onDismissLocalError,
  dismissalScope,
  placement = 'composer',
  extra,
  maxVisibleCount,
}: ConversationStatusDockProps) {
  const { t } = useTranslation(['conversation']);
  const [overflowExpanded, setOverflowExpanded] = useState(false);
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);
  const runNoticeAction = (
    key: string,
    action: (() => void | Promise<unknown>) | undefined
  ) => {
    if (!action || pendingActionKey === key) return;
    setPendingActionKey(key);
    try {
      void Promise.resolve(action())
        .catch((error: unknown) => {
          toast.error(getErrorMessage(error));
        })
        .finally(() => {
          setPendingActionKey((current) => (current === key ? null : current));
        });
    } catch (error: unknown) {
      toast.error(getErrorMessage(error));
      setPendingActionKey((current) => (current === key ? null : current));
    }
  };
  const { dismiss: dismissNotice, isDismissed } =
    useConversationStatusDismissal(dismissalScope);
  const visibleNotices = notices.filter(
    (notice) =>
      (notice.kind === 'session-notice' &&
        (notice.notice.connection_status || notice.notice.request_status)) ||
      !isDismissed(notice)
  );
  const hasOverflow = Boolean(
    maxVisibleCount &&
      maxVisibleCount > 0 &&
      visibleNotices.length > maxVisibleCount
  );
  const displayedNotices =
    hasOverflow && !overflowExpanded
      ? visibleNotices.slice(0, maxVisibleCount)
      : visibleNotices;
  const hiddenCount = hasOverflow
    ? visibleNotices.length - (maxVisibleCount ?? 0)
    : 0;

  useEffect(() => {
    setOverflowExpanded(false);
  }, [dismissalScope]);

  useEffect(() => {
    if (!hasOverflow && overflowExpanded) {
      setOverflowExpanded(false);
    }
  }, [hasOverflow, overflowExpanded]);

  const blockingNotice = visibleNotices.some(
    (notice) =>
      notice.kind === 'turn-error' ||
      Boolean(
        notice.kind === 'session-notice' &&
          (notice.notice.connection_status ||
            notice.onReload ||
            notice.onRebind ||
            notice.onNewConversation)
      )
  );

  useEffect(() => {
    rememberVisibleSessionAnnouncements(dismissalScope, visibleNotices);
  }, [dismissalScope, visibleNotices]);

  if (visibleNotices.length === 0 && !localError && extra == null) return null;

  const cleanedLocalError = localError
    ? stripInternalErrorPrefixes(localError)
    : null;
  const localErrorIsShort =
    cleanedLocalError != null &&
    !cleanedLocalError.includes('\n') &&
    cleanedLocalError.length <= 160;
  const localErrorSummary = localError
    ? localErrorIsShort
      ? cleanedLocalError
      : t('statusDock.localErrorSummary')
    : null;
  const localErrorTechnicalDetail =
    localError && (!localErrorIsShort || cleanedLocalError !== localError)
      ? localError
      : null;

  return (
    <div
      className={
        placement === 'panel'
          ? 'conversation-status-dock conversation-status-dock--panel'
          : 'conversation-status-dock'
      }
      data-testid="conversation-status-dock"
      data-placement={placement}
      data-expanded={blockingNotice ? 'true' : undefined}
      aria-live="polite"
    >
      <div className="composer-status-surface rounded-[var(--radius-composer,0.75rem)]">
        {extra}
        {localError ? (
          <StatusSurface
            tone="error"
            role="alert"
            title={t('statusDock.localErrorTitle')}
            summary={localErrorSummary}
            badgeLabel={t('statusDock.errorBadge')}
            detailsLabel={t('statusDock.showDetails')}
            detailsAccessibleLabel={t('statusDock.showDetailsFor', {
              title: t('statusDock.localErrorTitle'),
            })}
            detailsKey={localError}
            detailsMono
            copyText={localErrorTechnicalDetail}
            detailsContent={
              localErrorTechnicalDetail ? (
                <p className="whitespace-pre-wrap break-words">
                  {localErrorTechnicalDetail}
                </p>
              ) : null
            }
            action={
              onDismissLocalError ? (
                <DismissButton
                  label={t('statusDock.dismissLocalError')}
                  onClick={onDismissLocalError}
                />
              ) : null
            }
          />
        ) : null}

        {displayedNotices.map((notice) => {
          if (notice.kind === 'turn-error') {
            return (
              <TurnErrorCard
                key={notice.id}
                error={notice.error}
                actor={notice.actor}
                onReload={notice.onReload}
                onRebind={notice.onRebind}
                onRetry={notice.onRetry}
                onDismiss={() => dismissNotice(notice)}
                dismissLabel={t('statusDock.dismiss')}
                placement="composer"
              />
            );
          }

          if (notice.kind === 'interrupted-turn') {
            const title = t('messageTurnView.interruptedTitle');
            const summaryText = t('messageTurnView.interruptedDescription');
            return (
              <StatusSurface
                key={notice.id}
                tone="warning"
                role="status"
                actor={notice.actor}
                title={title}
                summary={summaryText}
                badgeLabel={t('statusDock.warningBadge')}
                action={
                  <div className="flex items-center gap-1">
                    {notice.onResend ? (
                      <button
                        type="button"
                        className="composer-status-action"
                        onClick={notice.onResend}
                        title={t('messageTurnView.resendHint')}
                        aria-label={t('messageTurnView.resend')}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {t('messageTurnView.resend')}
                      </button>
                    ) : null}
                    <DismissButton
                      label={t('statusDock.dismissFor', { title })}
                      onClick={() => dismissNotice(notice)}
                    />
                  </div>
                }
              />
            );
          }

          if (notice.notice.connection_status || notice.notice.request_status) {
            return (
              <AgentRuntimeStatus
                key={notice.id}
                notice={notice.notice}
                actor={notice.actor}
                titleOverride={notice.titleOverride}
                onReconnect={notice.onReload}
                onCancel={notice.onCancel}
                onRetry={notice.onRetry}
              />
            );
          }
          const tone =
            notice.notice.severity === 'error'
              ? 'error'
              : notice.notice.severity === 'warning'
                ? 'warning'
                : 'info';
          const view = getConversationSessionNoticeView(notice.notice, t);
          const resolvedTitle = notice.titleOverride?.trim() || view.title;
          return (
            <StatusSurface
              key={notice.id}
              tone={tone}
              role={tone === 'error' ? 'alert' : 'status'}
              actor={notice.actor}
              title={resolvedTitle}
              summary={view.summary}
              badgeLabel={t(`statusDock.${tone}Badge`)}
              detailsLabel={t('statusDock.showDetails')}
              detailsAccessibleLabel={t('statusDock.showDetailsFor', {
                title: resolvedTitle,
              })}
              detailsKey={view.technicalDetail ?? ''}
              detailsMono={tone !== 'info'}
              copyText={tone !== 'info' ? view.technicalDetail : null}
              detailsContent={
                view.technicalDetail ? (
                  <p className="whitespace-pre-wrap break-words">
                    {view.technicalDetail}
                  </p>
                ) : null
              }
              action={
                <div className="flex items-center gap-1">
                  {notice.notice.action ? (
                    <SessionNoticeActions action={notice.notice.action} />
                  ) : null}
                  {notice.kind === 'session-notice' && notice.onReload ? (
                    <button
                      type="button"
                      className="composer-status-action"
                      disabled={pendingActionKey === `${notice.id}:reload`}
                      onClick={() =>
                        runNoticeAction(`${notice.id}:reload`, notice.onReload)
                      }
                    >
                      <RefreshCw
                        className={
                          pendingActionKey === `${notice.id}:reload`
                            ? 'h-3.5 w-3.5 animate-spin'
                            : 'h-3.5 w-3.5'
                        }
                      />
                      {t('turnErrorCard.reloadSession')}
                    </button>
                  ) : null}
                  {notice.kind === 'session-notice' &&
                  notice.onNewConversation ? (
                    <button
                      type="button"
                      className="composer-status-action"
                      disabled={pendingActionKey === `${notice.id}:new`}
                      onClick={() =>
                        runNoticeAction(
                          `${notice.id}:new`,
                          notice.onNewConversation
                        )
                      }
                    >
                      {t('turnErrorCard.newConversation')}
                    </button>
                  ) : null}
                  {notice.onRebind &&
                  sessionNoticeNeedsRebind(notice.notice, notice.id) ? (
                    <button
                      type="button"
                      className="composer-status-action"
                      disabled={pendingActionKey === `${notice.id}:rebind`}
                      onClick={() =>
                        runNoticeAction(`${notice.id}:rebind`, notice.onRebind)
                      }
                    >
                      <RefreshCw
                        className={
                          pendingActionKey === `${notice.id}:rebind`
                            ? 'h-3.5 w-3.5 animate-spin'
                            : 'h-3.5 w-3.5'
                        }
                      />
                      {t('turnErrorCard.rebindSession')}
                    </button>
                  ) : null}
                  <DismissButton
                    label={t('statusDock.dismiss')}
                    onClick={() => dismissNotice(notice)}
                  />
                </div>
              }
            />
          );
        })}

        {hasOverflow ? (
          <button
            type="button"
            className="composer-status-overflow-toggle tabular-nums"
            onClick={() => setOverflowExpanded((current) => !current)}
            aria-expanded={overflowExpanded}
            data-testid="conversation-status-overflow-toggle"
          >
            {overflowExpanded ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t('statusDock.showFewerNotices')}</span>
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {t('statusDock.showMoreNotices', { count: hiddenCount })}
                </span>
              </>
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DismissButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="composer-status-dismiss focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <X className="h-4 w-4" />
    </button>
  );
}

function StatusSurface({
  tone,
  role,
  actor,
  title,
  summary,
  badgeLabel,
  action,
  detailsLabel,
  detailsAccessibleLabel,
  detailsKey,
  detailsMono = false,
  copyText,
  detailsContent,
}: {
  tone: 'error' | 'warning' | 'info';
  role: 'alert' | 'status';
  actor?: StatusNoticeActor;
  title: string;
  summary?: string | null;
  badgeLabel: string;
  action?: React.ReactNode;
  detailsLabel?: string;
  detailsAccessibleLabel?: string;
  detailsKey?: string;
  detailsMono?: boolean;
  copyText?: string | null;
  detailsContent?: React.ReactNode;
}) {
  const { t } = useTranslation(['conversation']);
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
  }, [detailsKey]);

  const hasDetails = Boolean(detailsContent && detailsLabel);

  return (
    <div className="composer-status-row text-xs" data-tone={tone} role={role}>
      <div className="composer-status-header">
        <div className="composer-status-heading">
          <StatusNoticeActorChip actor={actor} />
          <p className="composer-status-title text-foreground">{title}</p>
          <Badge
            className="composer-status-badge"
            variant={tone}
            label={badgeLabel}
          />
        </div>
        {hasDetails || action ? (
          <div className="composer-status-action-slot">
            {hasDetails ? (
              <ConversationStatusDetailsTrigger
                title={title}
                label={detailsLabel!}
                accessibleLabel={detailsAccessibleLabel}
                expanded={expanded}
                controlsId={detailsId}
                onToggle={() => setExpanded((current) => !current)}
              />
            ) : null}
            {action}
          </div>
        ) : null}
      </div>
      {summary ? (
        <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
          {summary}
        </p>
      ) : null}
      {hasDetails && expanded ? (
        <ConversationStatusDetailsContent id={detailsId} mono={detailsMono}>
          {detailsContent}
          {copyText ? (
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                className="composer-status-action font-sans"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(copyText)
                    .then(() => toast.success(t('turnErrorCard.copiedDetails')))
                    .catch(() => toast.error(t('runtime.copyFailed')));
                }}
              >
                <Copy className="h-3 w-3" aria-hidden="true" />
                {t('turnErrorCard.copyDetails')}
              </button>
            </div>
          ) : null}
        </ConversationStatusDetailsContent>
      ) : null}
    </div>
  );
}
