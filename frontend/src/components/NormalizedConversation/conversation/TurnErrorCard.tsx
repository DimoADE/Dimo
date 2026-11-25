import { useEffect, useId, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import {
  Ban,
  Copy,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  AgentPlanUsage,
  ConversationError,
  ConversationTurnErrorKind,
} from 'shared/types';
import type { StatusNoticeActor } from '@/contexts/ConversationStatusContext';
import { StatusNoticeActorChip } from '@/components/tasks/follow-up/StatusNoticeActorChip';
import { describeReset } from '@/components/kanban/planUsageFormat';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { stripInternalErrorPrefixes } from '@/features/conversation/sessionNoticeCopy';
import {
  ConversationStatusDetailsContent,
  ConversationStatusDetailsTrigger,
} from './ConversationStatusDetails';
import { cn } from '@/lib/utils';

/**
 * Turn-failure surface, keyed on the agent's *real* ACP/runtime error kind and
 * structured code so each failure reads in plain language (title + 1-line
 * summary + collapsible technical details with copy) and offers the exact
 * matching recovery actions.
 */
export function TurnErrorCard({
  error,
  actor,
  onReload,
  onRebind,
  onRetry,
  onDismiss,
  dismissLabel,
  placement = 'timeline',
}: {
  error: ConversationError;
  actor?: StatusNoticeActor;
  onReload?: () => void | Promise<unknown>;
  onRebind?: () => void | Promise<unknown>;
  onRetry?: () => void | Promise<unknown>;
  onDismiss?: () => void;
  dismissLabel?: string;
  placement?: 'timeline' | 'composer';
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const [reloading, setReloading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const detailsId = useId();
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const view = describeError(error, t);

  useEffect(() => {
    setDetailsExpanded(false);
  }, [view.technicalDetail, view.summary]);

  const showRebind =
    view.tone === 'error' && view.canRebind && Boolean(onRebind);
  const showReload =
    view.tone === 'error' && !showRebind && view.canReload && Boolean(onReload);
  const showRetry =
    view.tone === 'error' && !showRebind && view.canRetry && Boolean(onRetry);

  const handleReload = () => {
    const action = showRebind ? onRebind : onReload;
    if (!action) return;
    setReloading(true);
    void Promise.resolve(action()).finally(() => setReloading(false));
  };

  const handleRetry = () => {
    if (!onRetry) return;
    setRetrying(true);
    void Promise.resolve(onRetry()).finally(() => setRetrying(false));
  };

  const handleCopyDetails = () => {
    if (!view.technicalDetail) return;
    void navigator.clipboard
      .writeText(view.technicalDetail)
      .then(() => toast.success(t('turnErrorCard.copiedDetails')))
      .catch(() => toast.error(t('runtime.copyFailed')));
  };

  const busy = reloading || retrying;

  if (placement === 'composer') {
    const hasHeaderRight = Boolean(
      view.technicalDetail || showRetry || showRebind || showReload || onDismiss
    );
    return (
      <div
        role={view.tone === 'error' ? 'alert' : 'status'}
        data-tone={view.tone}
        className="composer-status-row text-xs text-foreground"
      >
        <div className="composer-status-header">
          <div className="composer-status-heading">
            <StatusNoticeActorChip actor={actor} />
            <div className="composer-status-title">{view.title}</div>
            <Badge
              className="composer-status-badge"
              variant={view.tone === 'error' ? 'error' : 'neutral'}
              label={
                view.tone === 'error'
                  ? t('statusDock.errorBadge')
                  : t('statusDock.infoBadge')
              }
            />
          </div>
          {hasHeaderRight ? (
            <div className="composer-status-action-slot">
              {view.technicalDetail ? (
                <ConversationStatusDetailsTrigger
                  title={view.title}
                  label={t('statusDock.showDetails')}
                  accessibleLabel={t('statusDock.showDetailsFor', {
                    title: view.title,
                  })}
                  expanded={detailsExpanded}
                  controlsId={detailsId}
                  onToggle={() => setDetailsExpanded((current) => !current)}
                />
              ) : null}
              {showRetry ? (
                <button
                  type="button"
                  className="composer-status-action"
                  disabled={busy}
                  onClick={handleRetry}
                >
                  <RotateCcw
                    className={cn('h-3.5 w-3.5', retrying && 'animate-spin')}
                  />
                  {t('runtime.retry')}
                </button>
              ) : null}
              {showRebind || showReload ? (
                <button
                  type="button"
                  className="composer-status-action"
                  disabled={busy}
                  onClick={handleReload}
                >
                  <RefreshCw
                    className={cn('h-3.5 w-3.5', reloading && 'animate-spin')}
                  />
                  {showRebind
                    ? t('turnErrorCard.rebindSession')
                    : t('turnErrorCard.reloadSession')}
                </button>
              ) : null}
              {onDismiss ? (
                <ComposerDismissButton
                  label={dismissLabel ?? t('statusDock.dismiss')}
                  onClick={onDismiss}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {view.summary ? (
          <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
            {view.summary}
          </p>
        ) : null}
        {view.technicalDetail && detailsExpanded ? (
          <ConversationStatusDetailsContent
            id={detailsId}
            mono={view.tone === 'error'}
          >
            <div className="whitespace-pre-wrap break-words">
              {view.technicalDetail}
            </div>
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                className="composer-status-action font-sans"
                onClick={handleCopyDetails}
              >
                <Copy className="h-3 w-3" aria-hidden="true" />
                {t('turnErrorCard.copyDetails')}
              </button>
            </div>
          </ConversationStatusDetailsContent>
        ) : null}
        <PlanUsageAside usage={error.plan_usage} />
      </div>
    );
  }

  return (
    <div
      role={view.tone === 'error' ? 'alert' : 'status'}
      data-tone={view.tone}
      className={cn(
        'conv-entry-item mb-2 rounded-lg border px-3 py-2.5 text-sm',
        view.tone === 'neutral'
          ? 'border-border bg-muted/40 text-muted-foreground'
          : 'border-destructive/40 bg-destructive/10 text-destructive'
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">{view.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{view.title}</div>
          {view.summary ? (
            <div className="mt-0.5 whitespace-pre-wrap break-words leading-5 opacity-90">
              {view.summary}
            </div>
          ) : null}
          <PlanUsageAside usage={error.plan_usage} />
          {view.technicalDetail ? (
            <div className="mt-1.5">
              <ConversationStatusDetailsTrigger
                title={view.title}
                label={t('statusDock.showDetails')}
                accessibleLabel={t('statusDock.showDetailsFor', {
                  title: view.title,
                })}
                expanded={detailsExpanded}
                controlsId={detailsId}
                onToggle={() => setDetailsExpanded((current) => !current)}
              />
              {detailsExpanded ? (
                <ConversationStatusDetailsContent
                  id={detailsId}
                  mono={view.tone === 'error'}
                >
                  <div className="whitespace-pre-wrap break-words">
                    {view.technicalDetail}
                  </div>
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      className="composer-status-action font-sans"
                      onClick={handleCopyDetails}
                    >
                      <Copy className="h-3 w-3" aria-hidden="true" />
                      {t('turnErrorCard.copyDetails')}
                    </button>
                  </div>
                </ConversationStatusDetailsContent>
              ) : null}
            </div>
          ) : null}
          {showRetry || showRebind || showReload ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {showRetry ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={handleRetry}
                >
                  <RotateCcw
                    className={cn(
                      'mr-1 h-3.5 w-3.5',
                      retrying && 'animate-spin'
                    )}
                  />
                  {t('runtime.retry')}
                </Button>
              ) : null}
              {showRebind || showReload ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={handleReload}
                >
                  <RefreshCw
                    className={cn(
                      'mr-1 h-3.5 w-3.5',
                      reloading && 'animate-spin'
                    )}
                  />
                  {showRebind
                    ? t('turnErrorCard.rebindSession')
                    : t('turnErrorCard.reloadSession')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            className={cn(
              'shrink-0 rounded-md p-1 opacity-70 transition-opacity hover:opacity-100',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
            )}
            onClick={onDismiss}
            title={dismissLabel ?? t('statusDock.dismiss')}
            aria-label={dismissLabel ?? t('statusDock.dismiss')}
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ComposerDismissButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="composer-status-dismiss"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <X className="h-4 w-4" />
    </button>
  );
}

type ErrorTone = 'neutral' | 'error';

type ErrorView = {
  title: string;
  summary: string | null;
  technicalDetail: string | null;
  tone: ErrorTone;
  icon: React.ReactNode;
  canRetry: boolean;
  canReload: boolean;
  canRebind: boolean;
};

const BILLING_QUOTA_CODES = new Set([
  'billing_quota',
  'insufficient_balance',
  'insufficient_quota',
  'payment_required',
  'quota_exceeded',
  'http_402',
  '402',
]);

const SERVICE_UNAVAILABLE_CODES = new Set([
  'service_unavailable',
  'overloaded',
  'overloaded_error',
  'http_503',
  '503',
]);

function extractTimeoutSeconds(message: string | null): number | null {
  if (!message) return null;
  const match = message.match(/\b(\d+)\s*(?:s|sec|secs|seconds|秒)\b/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function buildTechnicalDetail(
  rawMessage: string | null,
  code: string | null | undefined,
  t: TFunction
): string | null {
  const normalizedCode = code?.trim() || null;
  const parts: string[] = [];
  if (rawMessage) {
    parts.push(rawMessage);
  }
  if (normalizedCode) {
    parts.push(t('turnErrorCard.errorCodeLabel', { code: normalizedCode }));
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function describeError(error: ConversationError, t: TFunction): ErrorView {
  const rawMessage = error.message?.trim() || null;
  const normalizedCode = error.code?.trim().toLowerCase() || null;
  const technicalDetail = buildTechnicalDetail(rawMessage, error.code, t);

  // Structured code-specific views take precedence over generic `unknown` /
  // `service_error` fallbacks while keeping `errorKind(error)` authoritative.
  if (normalizedCode && BILLING_QUOTA_CODES.has(normalizedCode)) {
    return {
      title: t('turnErrorCard.billingQuotaTitle'),
      summary: t('turnErrorCard.billingQuotaDetail'),
      technicalDetail,
      tone: 'error',
      icon: <TriangleAlert className="h-4 w-4" />,
      canRetry: true,
      canReload: false,
      canRebind: false,
    };
  }

  if (normalizedCode === 'model_unreachable') {
    return {
      title: t('turnErrorCard.modelUnreachableTitle'),
      summary: t('turnErrorCard.modelUnreachableDetail'),
      technicalDetail,
      tone: 'error',
      icon: <TriangleAlert className="h-4 w-4" />,
      canRetry: true,
      canReload: true,
      canRebind: false,
    };
  }

  if (normalizedCode && SERVICE_UNAVAILABLE_CODES.has(normalizedCode)) {
    return {
      title: t('turnErrorCard.serviceUnavailableTitle'),
      summary: t('turnErrorCard.serviceUnavailableDetail'),
      technicalDetail,
      tone: 'error',
      icon: <TriangleAlert className="h-4 w-4" />,
      canRetry: true,
      canReload: false,
      canRebind: false,
    };
  }

  switch (normalizedCode ?? '') {
    case 'turn_failed_empty':
      return {
        title: t('turnErrorCard.emptyTurnTitle'),
        summary: t('turnErrorCard.emptyTurnDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: true,
        canReload: true,
        canRebind: false,
      };
    case 'turn_failed_refusal':
      return {
        title: t('turnErrorCard.refusalTitle'),
        summary: t('turnErrorCard.refusalDetail'),
        technicalDetail,
        tone: 'error',
        icon: <Ban className="h-4 w-4" />,
        canRetry: false,
        canReload: false,
        canRebind: false,
      };
    case 'turn_failed_max_tokens':
      return {
        title: t('turnErrorCard.maxTokensTitle'),
        summary: t('turnErrorCard.maxTokensDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: false,
        canReload: false,
        canRebind: false,
      };
    case 'turn_failed_max_turn_requests':
      return {
        title: t('turnErrorCard.maxTurnRequestsTitle'),
        summary: t('turnErrorCard.maxTurnRequestsDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: false,
        canReload: false,
        canRebind: false,
      };
    case 'incomplete_tool_call':
      return {
        title: t('turnErrorCard.incompleteToolCallTitle'),
        summary: t('turnErrorCard.incompleteToolCallDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: true,
        canReload: true,
        canRebind: false,
      };
    case 'cancel_unacknowledged':
      return {
        title: t('turnErrorCard.cancelUnacknowledgedTitle'),
        summary: t('turnErrorCard.cancelUnacknowledgedDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: true,
        canReload: false,
        canRebind: false,
      };
    case 'pi_project_trust_required':
      return {
        title: t('turnErrorCard.trustRequiredTitle'),
        summary: t('turnErrorCard.trustRequiredDetail'),
        technicalDetail,
        tone: 'error',
        icon: <ShieldAlert className="h-4 w-4" />,
        canRetry: true,
        canReload: false,
        canRebind: false,
      };
    case 'agent_not_installed':
      return {
        title: t('turnErrorCard.agentNotInstalledTitle'),
        summary: t('turnErrorCard.agentNotInstalledDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: true,
        canReload: false,
        canRebind: false,
      };
    case 'acp_session_not_bound':
      return {
        title: t('turnErrorCard.sessionNotBoundTitle'),
        summary: t('turnErrorCard.sessionNotBoundDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: false,
        canReload: true,
        canRebind: false,
      };
  }

  switch (errorKind(error)) {
    case 'cancelled':
      return {
        title: t('turnErrorCard.cancelledTitle'),
        summary: t('turnErrorCard.cancelledSummary'),
        technicalDetail:
          rawMessage &&
          rawMessage.toLowerCase() !==
            'the request was cancelled by the client.' &&
          rawMessage.toLowerCase() !== 'request cancelled' &&
          rawMessage.toLowerCase() !== 'cancelled'
            ? rawMessage
            : null,
        tone: 'neutral',
        icon: <Ban className="h-4 w-4" />,
        canRetry: false,
        canReload: false,
        canRebind: false,
      };
    case 'resource_not_found':
      return {
        title: t('turnErrorCard.resourceNotFoundTitle'),
        summary: t('turnErrorCard.resourceNotFoundDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: false,
        canReload: false,
        canRebind: true,
      };
    case 'session_resume_unsupported':
      return {
        title: t('turnErrorCard.sessionResumeUnsupportedTitle'),
        summary: t('turnErrorCard.sessionResumeUnsupportedDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: false,
        canReload: false,
        canRebind: true,
      };
    case 'session_load_failed':
      return {
        title: t('turnErrorCard.sessionLoadFailedTitle'),
        summary: t('turnErrorCard.sessionLoadFailedDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: false,
        canReload: false,
        canRebind: true,
      };
    case 'idle_timeout': {
      const timeoutSeconds = extractTimeoutSeconds(rawMessage);
      return {
        title: t('turnErrorCard.idleTimeoutTitle'),
        summary:
          timeoutSeconds != null
            ? t('turnErrorCard.idleTimeoutDetailWithSeconds', {
                seconds: timeoutSeconds,
              })
            : t('turnErrorCard.idleTimeoutDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: true,
        canReload: true,
        canRebind: false,
      };
    }
    case 'connection_closed':
      return {
        title: t('turnErrorCard.connectionClosedTitle'),
        summary: t('turnErrorCard.connectionClosedDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: true,
        canReload: true,
        canRebind: false,
      };
    case 'auth_required':
      return {
        title: t('turnErrorCard.authRequiredTitle'),
        summary: t('turnErrorCard.authRequiredDetail'),
        technicalDetail,
        tone: 'error',
        icon: <ShieldAlert className="h-4 w-4" />,
        canRetry: true,
        canReload: false,
        canRebind: false,
      };
    case 'rejected':
      return {
        title: t('turnErrorCard.rejectedTitle'),
        summary: t('turnErrorCard.rejectedDetail'),
        technicalDetail,
        tone: 'error',
        icon: <Ban className="h-4 w-4" />,
        canRetry: false,
        canReload: false,
        canRebind: true,
      };
    case 'service_error':
      return {
        title: t('turnErrorCard.serviceErrorTitle'),
        summary: t('turnErrorCard.serviceErrorDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: true,
        canReload: true,
        canRebind: false,
      };
    case 'rate_limited':
      return {
        title: t('turnErrorCard.rateLimitedTitle'),
        summary: t('turnErrorCard.rateLimitedDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: true,
        canReload: false,
        canRebind: false,
      };
    case 'prompt_conflict':
      return {
        title: t('turnErrorCard.promptConflictTitle'),
        summary: t('turnErrorCard.promptConflictDetail'),
        technicalDetail,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: true,
        canReload: false,
        canRebind: false,
      };
    case 'unknown': {
      const cleanedMessage = rawMessage
        ? stripInternalErrorPrefixes(rawMessage)
        : null;
      const isShortSingleLine =
        cleanedMessage != null &&
        !cleanedMessage.includes('\n') &&
        cleanedMessage.length <= 180;
      const summary = isShortSingleLine
        ? cleanedMessage
        : t('turnErrorCard.defaultSummary');
      const showTechnicalDetail =
        technicalDetail != null &&
        (!isShortSingleLine ||
          Boolean(error.code?.trim()) ||
          cleanedMessage !== rawMessage);
      return {
        title: t('turnErrorCard.defaultTitle'),
        summary,
        technicalDetail: showTechnicalDetail ? technicalDetail : null,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canRetry: true,
        canReload: true,
        canRebind: false,
      };
    }
  }
}

function errorKind(error: ConversationError): ConversationTurnErrorKind {
  if (error.kind) {
    return error.kind;
  }
  switch (error.code) {
    case 'invalid_request':
    case 'invalid_params':
      return 'rejected';
    case 'internal_error':
      return 'service_error';
    case 'request_cancelled':
    case 'cancelled':
      return 'cancelled';
    case 'auth_required':
      return 'auth_required';
    case 'resource_not_found':
      return 'resource_not_found';
    case 'session_resume_unsupported':
      return 'session_resume_unsupported';
    case 'session_load_failed':
      return 'session_load_failed';
    case 'idle_timeout':
      return 'idle_timeout';
    case 'connection_closed':
    case 'agent_connection_lost':
      return 'connection_closed';
    case 'prompt_conflict':
      return 'prompt_conflict';
    default:
      return 'unknown';
  }
}

function PlanUsageAside({ usage }: { usage?: AgentPlanUsage | null }) {
  const { t } = useTranslation(['conversation']);
  const window = usage?.windows.find(
    (item) => item.usedPercent != null || item.resetsAtMs != null
  );
  if (!window) return null;
  const percent =
    typeof window.usedPercent === 'number'
      ? Math.round(window.usedPercent)
      : null;
  const reset = describeReset(window.resetsAtMs, Date.now());
  const resetLabel = !reset
    ? null
    : reset.kind === 'soon'
      ? t('turnErrorCard.planUsageResetSoon')
      : t(`turnErrorCard.planUsageReset_${reset.kind}`, {
          count: reset.count,
        });
  return (
    <div className="mt-1 text-xs opacity-80">
      {percent != null && resetLabel
        ? t('turnErrorCard.planUsageAside', { percent, reset: resetLabel })
        : percent != null
          ? t('turnErrorCard.planUsagePercent', { percent })
          : resetLabel
            ? t('turnErrorCard.planUsageResetOnly', { reset: resetLabel })
            : null}
    </div>
  );
}
