import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CalendarClock,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  formatPulseErrorMessage,
  usePulseDeckSnapshot,
} from '@/hooks/usePulseDeckSnapshot';
import {
  pulseApi,
  type EventSourceKind,
  type PulseObservedCandidateView,
  type PulseRuleView,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';
import { buildBotPulseProposalSpec } from './collaborationPulseEvents';
import { PulseRuleProposalCard } from './PulseRuleProposalCard';

function formatLocalTimestamp(
  iso: string | null | undefined,
  locale?: string
): string {
  if (!iso) return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(parsed);
  } catch {
    return parsed.toLocaleString();
  }
}

function sourceKindTranslationKey(kind: EventSourceKind): string {
  return `pulseFilter.sources.${kind.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())}`;
}

export function BotAutomationsPanel({
  memberId,
  botName,
  workspaceId = null,
  initialCreateKind = null,
  createRequestNonce,
}: {
  memberId: string;
  botName: string;
  workspaceId?: string | null;
  initialCreateKind?: 'event' | 'schedule' | null;
  createRequestNonce?: number;
}) {
  const { t, i18n } = useTranslation('panels');
  const {
    snapshot,
    isLoading,
    error: queryError,
    refetch,
    setSnapshotData,
    invalidateSnapshot,
  } = usePulseDeckSnapshot(null, { enabled: Boolean(memberId) });

  const [creatingKind, setCreatingKind] = useState<'event' | 'schedule' | null>(
    initialCreateKind
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [togglingRuleIds, setTogglingRuleIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [promotingCandidateId, setPromotingCandidateId] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (!initialCreateKind) return;
    setCreatingKind(initialCreateKind);
  }, [createRequestNonce, initialCreateKind]);

  const rules = useMemo<PulseRuleView[]>(() => {
    if (!memberId) return [];
    const allRules = snapshot?.rules ?? [];
    return allRules.filter((rule) =>
      rule.spec.targets.some(
        (target) => target.kind === 'bot' && target.memberId === memberId
      )
    );
  }, [memberId, snapshot?.rules]);

  const pendingCandidates = useMemo<PulseObservedCandidateView[]>(() => {
    if (rules.length === 0) return [];
    const ruleIds = new Set(rules.map((rule) => rule.id));
    return (snapshot?.observedCandidates ?? []).filter(
      (candidate) => !candidate.promoted && ruleIds.has(candidate.ruleId)
    );
  }, [rules, snapshot?.observedCandidates]);

  const errorMessage =
    actionError ??
    (queryError
      ? formatPulseErrorMessage(queryError, t('botAutomations.errLoad'))
      : null);

  const handleEnabledChange = async (rule: PulseRuleView, enabled: boolean) => {
    setActionError(null);
    setTogglingRuleIds((current) => new Set(current).add(rule.id));
    try {
      // Legacy rules paused via the mode selector need a runnable mode first.
      const updated =
        enabled && rule.spec.evalMode === 'off'
          ? await pulseApi.setRuleMode(rule.id, 'auto')
          : await pulseApi.setRuleEnabled(rule.id, enabled);
      setSnapshotData((prev) =>
        prev
          ? {
              ...prev,
              rules: prev.rules.map((item) =>
                item.id === rule.id ? updated : item
              ),
            }
          : prev
      );
      void invalidateSnapshot();
    } catch (err) {
      setActionError(
        formatPulseErrorMessage(err, t('pulseDeck.errToggleRule'))
      );
    } finally {
      setTogglingRuleIds((current) => {
        const next = new Set(current);
        next.delete(rule.id);
        return next;
      });
    }
  };

  const handleDelete = async (ruleId: string) => {
    setActionError(null);
    try {
      await pulseApi.deleteRule(ruleId);
      setSnapshotData((prev) =>
        prev
          ? {
              ...prev,
              rules: prev.rules.filter((item) => item.id !== ruleId),
            }
          : prev
      );
      void invalidateSnapshot();
    } catch (err) {
      setActionError(
        formatPulseErrorMessage(err, t('botAutomations.errDelete'))
      );
    }
  };

  const handlePromoteCandidate = async (
    candidate: PulseObservedCandidateView
  ) => {
    setActionError(null);
    setPromotingCandidateId(candidate.id);
    try {
      await pulseApi.promoteObservedCandidate(candidate.id);
      setSnapshotData((prev) =>
        prev
          ? {
              ...prev,
              observedCandidates: prev.observedCandidates.map((item) =>
                item.id === candidate.id ? { ...item, promoted: true } : item
              ),
            }
          : prev
      );
      void invalidateSnapshot();
      void refetch();
    } catch (err) {
      setActionError(
        formatPulseErrorMessage(err, t('botAutomations.errPromote'))
      );
    } finally {
      setPromotingCandidateId(null);
    }
  };

  const activeProposalSpec = useMemo(() => {
    if (!creatingKind) return null;
    return buildBotPulseProposalSpec({
      memberId,
      botName,
      sourceKind:
        creatingKind === 'schedule' ? 'time_cron' : 'webhook_standard',
      workspaceId,
    });
  }, [botName, creatingKind, memberId, workspaceId]);

  return (
    <div
      className="space-y-3 text-xs text-foreground"
      data-testid="bot-automations-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5 text-primary" />
          <span className="font-semibold">{t('botAutomations.title')}</span>
          <span
            className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums"
            data-testid="bot-automations-count"
          >
            {rules.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            data-testid="bot-automations-new-trigger"
            onClick={() => setCreatingKind('event')}
            icon={<Plus className="h-3 w-3" />}
          >
            {t('botAutomations.eventTrigger')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="bot-automations-new-schedule"
            onClick={() => setCreatingKind('schedule')}
            icon={<CalendarClock className="h-3 w-3" />}
          >
            {t('botAutomations.schedule')}
          </Button>
        </div>
      </div>

      {errorMessage ? (
        <div
          role="alert"
          data-testid="bot-automations-error"
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive"
        >
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{errorMessage}</span>
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="bot-automations-retry"
            onClick={() => {
              setActionError(null);
              void refetch();
            }}
            icon={<RefreshCw className="h-3 w-3" />}
          >
            {t('botAutomations.retry')}
          </Button>
        </div>
      ) : null}

      {activeProposalSpec ? (
        <PulseRuleProposalCard
          key={`create-${creatingKind}-${createRequestNonce ?? 0}`}
          initialSpec={activeProposalSpec}
          contextLabel={botName}
          onSaved={(saved) => {
            setCreatingKind(null);
            setSnapshotData((prev) =>
              prev
                ? {
                    ...prev,
                    rules: [
                      saved,
                      ...prev.rules.filter((item) => item.id !== saved.id),
                    ],
                  }
                : prev
            );
            void invalidateSnapshot();
          }}
          onCancel={() => setCreatingKind(null)}
        />
      ) : null}

      {isLoading && !snapshot ? (
        <p className="py-2 text-muted-foreground">
          {t('botAutomations.loading')}
        </p>
      ) : rules.length === 0 ? (
        <p
          className="rounded-md border border-border/70 bg-muted/30 px-3 py-3 text-muted-foreground"
          data-testid="bot-automations-empty"
        >
          {t('botAutomations.empty', { botName })}
        </p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => {
            const sourceLabels =
              rule.spec.filter.sourceKinds.length > 0
                ? rule.spec.filter.sourceKinds
                    .map((kind) => t(sourceKindTranslationKey(kind)))
                    .join(', ')
                : t('pulseProposal.allSources');
            const taskMeta = rule.spec.taskMeta;
            const lastRunFailed = taskMeta?.lastRunStatus === 'failed';
            const enabled = rule.enabled && rule.spec.evalMode !== 'off';
            const isToggling = togglingRuleIds.has(rule.id);

            return (
              <div
                key={rule.id}
                data-testid={`bot-pulse-rule-${rule.id}`}
                className="settings-surface space-y-2 rounded-md border border-border bg-background p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate font-medium text-foreground">
                        {rule.spec.name}
                      </p>
                      {rule.draftOnly ? (
                        <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                          {t('botAutomations.draftBadge')}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="rounded bg-muted px-1.5 py-0.5">
                        {sourceLabels}
                      </span>
                      {enabled && rule.nextFireAt ? (
                        <span
                          className="tabular-nums"
                          title={rule.nextFireAt}
                          data-testid={`bot-rule-next-fire-${rule.id}`}
                        >
                          {t('botAutomations.nextFire', {
                            time: formatLocalTimestamp(
                              rule.nextFireAt,
                              i18n.language
                            ),
                          })}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <label className="inline-flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                      <span>{t('botAutomations.enableLabel')}</span>
                      <Switch
                        aria-label={t('pulseDeck.workbench.tasks.switchAria', {
                          name: rule.spec.name,
                        })}
                        checked={enabled}
                        disabled={isToggling}
                        onCheckedChange={(checked) =>
                          void handleEnabledChange(rule, checked)
                        }
                      />
                    </label>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      data-testid={`bot-rule-delete-${rule.id}`}
                      aria-label={t('botAutomations.deleteAria', {
                        name: rule.spec.name,
                      })}
                      disabled={isToggling}
                      onClick={() => void handleDelete(rule.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {taskMeta?.lastRunStatus && taskMeta.lastRunAt ? (
                  <p
                    className={cn(
                      'truncate text-[11px] tabular-nums',
                      lastRunFailed
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                    )}
                    title={taskMeta.lastRunSummary ?? undefined}
                    data-testid={`bot-rule-last-run-${rule.id}`}
                  >
                    {t('botAutomations.lastRun', {
                      status: lastRunFailed
                        ? t('botAutomations.runStatusFailed')
                        : t('botAutomations.runStatusSucceeded'),
                      time: formatLocalTimestamp(
                        taskMeta.lastRunAt,
                        i18n.language
                      ),
                    })}
                    {lastRunFailed && taskMeta.lastRunSummary
                      ? ` · ${taskMeta.lastRunSummary}`
                      : ''}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {pendingCandidates.length > 0 ? (
        <div
          className="space-y-1.5 rounded-md border border-border/80 bg-muted/25 p-2.5"
          data-testid="bot-automations-observed-candidates"
        >
          <p className="text-[11px] font-semibold text-foreground tabular-nums">
            {t('botAutomations.observedCandidatesTitle', {
              count: pendingCandidates.length,
            })}
          </p>
          <div className="space-y-1.5">
            {pendingCandidates.map((candidate) => (
              <div
                key={candidate.id}
                data-testid={`bot-observed-candidate-${candidate.id}`}
                className="flex items-start justify-between gap-2 rounded border border-border/70 bg-background px-2 py-1.5"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {candidate.ruleName}
                  </p>
                  <p className="line-clamp-2 text-[11px] text-muted-foreground">
                    {candidate.summary}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
                    {formatLocalTimestamp(candidate.occurredAt, i18n.language)}
                  </p>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  data-testid={`bot-promote-candidate-${candidate.id}`}
                  disabled={promotingCandidateId === candidate.id}
                  onClick={() => void handlePromoteCandidate(candidate)}
                >
                  {promotingCandidateId === candidate.id
                    ? t('botAutomations.promoting')
                    : t('botAutomations.approveAndRun')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
