import { useEffect, useState } from 'react';
import { Copy, Info, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationSessionNotice } from 'shared/types';
import { toast } from '@/components/ui/toast';
import { PixelGridLoader } from '@/components/ui/pixel-grid-loader';
import { getErrorMessage } from '@/lib/modals';
import { cn } from '@/lib/utils';
import {
  waitingAdvisory,
  isRequestTerminal,
} from '@/features/conversation/runtimeStatus';
import { parseReconnectProgressTitle } from '@/features/conversation/inlineRuntimeStatus';
import {
  formatRuntimeConnectionMessage,
  localizeBackendNoticeTitle,
} from '@/features/conversation/sessionNoticeCopy';
import { ConversationStatusDetails } from '@/components/NormalizedConversation/conversation/ConversationStatusDetails';
import type { StatusNoticeActor } from '@/contexts/ConversationStatusContext';
import { StatusNoticeActorChip } from './StatusNoticeActorChip';

type Props = {
  notice: ConversationSessionNotice;
  actor?: StatusNoticeActor;
  placement?: 'composer' | 'stream';
  titleOverride?: string | null;
  onReconnect?: () => void | Promise<unknown>;
  onCancel?: () => void | Promise<unknown>;
  onRetry?: () => void | Promise<unknown>;
};

const MAX_STREAM_DISPLAY_ELAPSED_SECONDS = 24 * 3600;
const STREAM_ELAPSED_VISIBILITY_SECONDS = 15;
const STREAM_LONG_WAIT_ADVISORY_SECONDS = 30;
const MAX_STREAM_REASON_CHARS = 96;

function formatStreamElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function summarizeStreamRetryReason(
  rawMessage: string | null | undefined,
  formattedSummary: string | null,
  code: string | null | undefined
): string | null {
  const candidate = (formattedSummary || rawMessage || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!candidate) {
    return code ? `HTTP ${code}` : null;
  }
  const clipped =
    candidate.length > MAX_STREAM_REASON_CHARS
      ? `${candidate.slice(0, MAX_STREAM_REASON_CHARS - 1).trimEnd()}…`
      : candidate;
  if (code && !clipped.includes(code)) {
    return `${clipped} (${code})`;
  }
  return clipped;
}

export function AgentRuntimeStatus({
  notice,
  actor,
  placement = 'composer',
  titleOverride,
  onReconnect,
  onCancel,
  onRetry,
}: Props) {
  const { t } = useTranslation('conversation');
  const [now, setNow] = useState(Date.now);
  const [actionPending, setActionPending] = useState(false);
  const runAction = async (action: () => void | Promise<unknown>) => {
    if (actionPending) return;
    setActionPending(true);
    try {
      await action();
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setActionPending(false);
    }
  };
  const connection = notice.connection_status;
  const request = notice.request_status;
  const phase = request?.activity.phase;
  const terminal = phase != null && isRequestTerminal(phase);
  const retry = request?.activity.retry;
  const connectionFailed =
    connection?.status === 'error' || connection?.status === 'closed';
  const requestFailed = phase === 'failed';
  const isError = Boolean(connectionFailed || requestFailed);
  const waitingConnection = Boolean(
    connection && !connection.bound && !connectionFailed
  );

  useEffect(() => {
    if (terminal || isError || (!request && !waitingConnection)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [terminal, isError, request, waitingConnection]);

  const since = request?.since ?? connection?.since;
  const parsedSince = since ? Date.parse(since) : Number.NaN;
  const hasValidSince = Number.isFinite(parsedSince);
  const elapsed = hasValidSince
    ? Math.max(0, Math.floor((now - parsedSince) / 1000))
    : null;
  const rawMessage = connection?.message ?? retry?.reason ?? notice.message;
  const formattedConnectionMessage = formatRuntimeConnectionMessage(
    rawMessage,
    t
  );

  if (placement === 'stream' && !isError && !terminal) {
    const parsedReconnect = parseReconnectProgressTitle(titleOverride);
    const attempt = retry?.attempt ?? parsedReconnect?.attempt ?? null;
    const maxAttempts =
      retry?.max_attempts ?? parsedReconnect?.maxAttempts ?? null;
    const isRetryingStream =
      phase === 'retrying' || connection?.status === 'recovering';
    const streamLabel =
      phase === 'cancelling'
        ? t('runtime.stream.cancelling')
        : attempt != null && maxAttempts != null
          ? t('runtime.stream.connectingRetryingCount', {
              attempt,
              max: maxAttempts,
            })
          : attempt != null
            ? t('runtime.stream.connectingRetryingAttempt', { attempt })
            : isRetryingStream
              ? t('runtime.stream.connectingRetrying')
              : phase === 'waiting_model'
                ? t('runtime.stream.waitingModel')
                : connection ||
                    !phase ||
                    phase === 'submitting' ||
                    phase === 'waiting_agent'
                  ? t('runtime.stream.connecting')
                  : t(`runtime.request.${phase}`);
    const streamElapsed =
      elapsed !== null && elapsed < MAX_STREAM_DISPLAY_ELAPSED_SECONDS
        ? elapsed
        : null;
    const showStreamElapsed =
      streamElapsed !== null &&
      phase !== 'cancelling' &&
      (streamElapsed >= STREAM_ELAPSED_VISIBILITY_SECONDS ||
        ((phase === 'waiting_model' || isRetryingStream) &&
          streamElapsed >= 1));
    const backoffSeconds =
      isRetryingStream && retry?.delay_ms != null && hasValidSince
        ? Math.ceil((Number(retry.delay_ms) - (now - parsedSince)) / 1000)
        : null;
    const showBackoff =
      backoffSeconds !== null && backoffSeconds > 0 && backoffSeconds <= 3600;
    const streamReason = isRetryingStream
      ? summarizeStreamRetryReason(
          rawMessage,
          formattedConnectionMessage.summary,
          retry?.code
        )
      : null;
    const streamAdvisory =
      streamElapsed !== null &&
      streamElapsed >= STREAM_LONG_WAIT_ADVISORY_SECONDS &&
      phase !== 'cancelling'
        ? waitingConnection
          ? t('runtime.connectionWait')
          : request &&
              phase &&
              since &&
              waitingAdvisory(phase, since, now) != null
            ? t('runtime.longWait')
            : null
        : null;

    return (
      <div className="conv-entry-item conv-assistant-msg px-4 py-2 text-sm">
        <div
          className="conv-thinking-placeholder flex-col items-start gap-1"
          role="status"
          aria-live="polite"
          data-testid={
            connection ? 'agent-connection-status' : 'agent-request-status'
          }
          data-placement={placement}
        >
          <div className="flex flex-wrap items-center gap-2">
            <PixelGridLoader size="sm" />
            <span className="conv-shimmer-text tabular-nums">
              {streamLabel}
            </span>
            {showBackoff ? (
              <span
                className="text-xs text-muted-foreground/80 tabular-nums"
                data-testid="stream-retry-backoff"
              >
                {t('runtime.stream.retryBackoff', { seconds: backoffSeconds })}
              </span>
            ) : null}
            {showStreamElapsed ? (
              <span
                className="text-xs text-muted-foreground/70 tabular-nums"
                aria-label={t('runtime.elapsed')}
                data-testid="stream-elapsed"
              >
                {formatStreamElapsed(streamElapsed)}
              </span>
            ) : null}
          </div>
          {streamReason ? (
            <p
              className="pl-5 text-xs text-muted-foreground/80 break-words"
              data-testid="stream-retry-reason"
            >
              {streamReason}
            </p>
          ) : null}
          {streamAdvisory ? (
            <p
              className="pl-5 text-xs text-muted-foreground/75"
              data-testid="stream-long-wait"
            >
              {streamAdvisory}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const connectionKey = connection?.bound
    ? 'ready'
    : connection?.status === 'ready'
      ? 'binding'
      : connection?.status;
  const trimmedTitleOverride = titleOverride?.trim() || null;
  const localizedTitleOverride = trimmedTitleOverride
    ? localizeBackendNoticeTitle(trimmedTitleOverride, t)
    : null;
  const title =
    localizedTitleOverride ||
    (terminal && phase
      ? t(`runtime.request.${phase}`)
      : connection
        ? t(`runtime.connection.${connectionKey}`)
        : t(`runtime.request.${phase ?? 'waiting_agent'}`));
  const advisory =
    request && phase && since ? waitingAdvisory(phase, since, now) : null;
  const visibleSummary =
    formattedConnectionMessage.summary &&
    formattedConnectionMessage.summary !== rawMessage?.trim()
      ? formattedConnectionMessage.summary
      : connection?.status === 'closed' && !rawMessage
        ? t('runtime.connectionClosedSummary')
        : null;
  const technicalDetail = rawMessage?.trim() || null;
  const isActive = !terminal && (Boolean(request) || waitingConnection);

  const content = (
    <div
      className={cn(
        placement === 'stream'
          ? cn(
              'rounded-lg border px-3 py-2 text-xs text-muted-foreground transition-colors',
              isError
                ? 'border-destructive/30 bg-destructive/5'
                : 'border-border/60 bg-muted/35'
            )
          : 'composer-status-row text-xs text-muted-foreground'
      )}
      data-testid={
        connection ? 'agent-connection-status' : 'agent-request-status'
      }
      data-placement={placement}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusNoticeActorChip actor={actor} />
        {isActive ? (
          <PixelGridLoader size="sm" />
        ) : isError ? (
          <TriangleAlert
            className="h-3.5 w-3.5 shrink-0 text-destructive"
            aria-hidden="true"
          />
        ) : placement === 'stream' ? (
          <Info
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80"
            aria-hidden="true"
          />
        ) : null}
        <span
          role="status"
          className={cn(
            isError
              ? 'font-medium text-destructive'
              : 'font-medium text-foreground/90'
          )}
        >
          {title}
        </span>
        {elapsed !== null && !terminal && (!connection || waitingConnection) ? (
          <span
            className="tabular-nums text-muted-foreground/80"
            aria-label={t('runtime.elapsed')}
          >
            {elapsed}s
          </span>
        ) : null}
        {retry?.attempt != null ? (
          <span className="tabular-nums">
            {t('runtime.attempt', { count: retry.attempt })}
            {retry.max_attempts != null ? ` / ${retry.max_attempts}` : ''}
          </span>
        ) : null}
        {retry?.delay_ms != null && hasValidSince ? (
          <span className="tabular-nums">
            {t('runtime.backoff', {
              seconds: Math.max(
                0,
                Math.ceil((Number(retry.delay_ms) - (now - parsedSince)) / 1000)
              ),
            })}
          </span>
        ) : null}
        <div
          className={cn(
            'flex items-center gap-1.5',
            placement === 'stream'
              ? 'ml-auto'
              : 'composer-status-action-slot ml-auto'
          )}
        >
          {connectionFailed && onReconnect ? (
            <button
              type="button"
              className="composer-status-action"
              disabled={actionPending}
              onClick={() => void runAction(onReconnect)}
            >
              {t('runtime.reconnect')}
            </button>
          ) : null}
          {((request && !terminal && phase !== 'cancelling') ||
            waitingConnection) &&
          onCancel ? (
            <button
              type="button"
              className="composer-status-action"
              disabled={actionPending}
              onClick={() => void runAction(onCancel)}
            >
              {t('runtime.cancel')}
            </button>
          ) : null}
          {request &&
          (phase === 'failed' ||
            phase === 'interrupted' ||
            phase === 'cancelled') &&
          onRetry ? (
            <button
              type="button"
              className="composer-status-action"
              disabled={actionPending}
              onClick={() => void runAction(onRetry)}
            >
              {t('runtime.retry')}
            </button>
          ) : null}
        </div>
      </div>
      {visibleSummary ? (
        <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
          {visibleSummary}
        </p>
      ) : null}
      {advisory != null ? (
        <p className="mt-1">{t('runtime.longWait')}</p>
      ) : null}
      {waitingConnection && elapsed !== null && elapsed >= 30 ? (
        <p className="mt-1">{t('runtime.connectionWait')}</p>
      ) : null}
      {technicalDetail || retry?.code ? (
        <ConversationStatusDetails
          title={title}
          label={t('statusDock.showDetails')}
          mono={isError}
        >
          <p className="whitespace-pre-wrap break-words">
            {technicalDetail}
            {retry?.code ? ` (${retry.code})` : ''}
          </p>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              className="composer-status-action font-sans"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    [technicalDetail, retry?.code].filter(Boolean).join(' ')
                  );
                  toast.success(t('runtime.copySuccess'));
                } catch {
                  toast.error(t('runtime.copyFailed'));
                }
              }}
            >
              <Copy className="h-3 w-3" aria-hidden="true" />
              {t('runtime.copyError')}
            </button>
          </div>
        </ConversationStatusDetails>
      ) : null}
    </div>
  );

  if (placement === 'stream') {
    return <div className="conv-entry-item px-4 py-1.5">{content}</div>;
  }

  return content;
}
