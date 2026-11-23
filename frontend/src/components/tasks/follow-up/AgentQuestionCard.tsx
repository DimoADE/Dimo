import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Badge } from '@astryxdesign/core';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CornerDownLeft,
  PenLine,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentElicitationResponse,
  ConversationQuestionRequest,
} from 'shared/types';
import { Button } from '@/components/ui/button';
import type { StatusNoticeActor } from '@/contexts/ConversationStatusContext';
import { getErrorMessage } from '@/lib/modals';
import { cn } from '@/lib/utils';
import { GlideMenu } from './GlideMenu';
import { StatusNoticeActorChip } from './StatusNoticeActorChip';
import {
  emptyQuestionAnswerState,
  hasAnswer,
  hasCompletedAnswers,
  initialAnswerState,
  questionTabsFromRequest,
  responseContent,
  type PrimitiveValue,
  type QuestionAnswerState,
  type QuestionTab,
} from './agentQuestionModel';

const ROLL_MS = 400;
const AUTO_ADVANCE_MS = 480;
const SLIDE = '360ms cubic-bezier(0.22, 1, 0.36, 1)';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function isOrphanedQuestionResponseError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return /no active.*(agent|connection|turn|session)|unknown elicitation|elicitation.*not found|question.*(expired|not found|closed)|bad\s*request|invalid question id|\b400\b/i.test(
    message
  );
}

/** Odometer digit counter — changed characters roll vertically on step change. */
function RollingDigits({ value }: { value: string }) {
  const prevRef = useRef(value);
  const [oldVal, setOldVal] = useState(value);
  const [newVal, setNewVal] = useState(value);
  const [rolling, setRolling] = useState(false);
  const [shifted, setShifted] = useState(false);
  const [dir, setDir] = useState<'up' | 'down'>('up');

  useEffect(() => {
    if (prevRef.current === value) return;
    const from = prevRef.current;
    prevRef.current = value;
    if (prefersReducedMotion()) {
      setOldVal(value);
      setNewVal(value);
      setRolling(false);
      setShifted(false);
      return;
    }
    const fromN = parseInt(from, 10);
    const toN = parseInt(value, 10);
    setDir(
      Number.isFinite(fromN) && Number.isFinite(toN) && toN < fromN
        ? 'down'
        : 'up'
    );
    setOldVal(from);
    setNewVal(value);
    setRolling(true);
    setShifted(false);

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShifted(true));
    });
    const done = setTimeout(() => {
      setRolling(false);
      setOldVal(value);
      setShifted(false);
    }, ROLL_MS);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(done);
    };
  }, [value]);

  const chars = rolling ? newVal : oldVal;

  return (
    <span aria-hidden="true" className="inline-flex items-center">
      {Array.from({ length: chars.length }, (_, i) => {
        const o = oldVal[i] ?? '';
        const n = chars[i] ?? '';
        if (!rolling || o === n) {
          return <span key={`${i}-${n}`}>{n}</span>;
        }
        const top = dir === 'down' ? n : o;
        const bottom = dir === 'down' ? o : n;
        const restY = dir === 'down' ? '0' : '-1em';
        const startY = dir === 'down' ? '-1em' : '0';
        return (
          <span
            key={`${i}-${o}-${n}-${dir}`}
            style={{
              display: 'inline-block',
              position: 'relative',
              overflow: 'hidden',
              height: '1em',
              lineHeight: '1em',
              verticalAlign: '-0.05em',
            }}
          >
            <span
              style={{
                display: 'flex',
                flexDirection: 'column',
                transition: 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)',
                transform: `translateY(${shifted ? restY : startY})`,
              }}
            >
              <span style={{ height: '1em', lineHeight: '1em' }}>{top}</span>
              <span style={{ height: '1em', lineHeight: '1em' }}>{bottom}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}

export function AgentQuestionCard({
  request,
  onRespond,
  onDismiss,
  responding = false,
  mode = 'interactive',
  answers = null,
  onQuestionIndexChange,
  actor,
}: {
  request: ConversationQuestionRequest;
  onRespond?: (
    questionId: string,
    response: AgentElicitationResponse
  ) => void | Promise<unknown>;
  onDismiss?: (questionId: string) => void;
  responding?: boolean;
  mode?: 'interactive' | 'readonly';
  answers?: Record<string, QuestionAnswerState> | null;
  onQuestionIndexChange?: (index: number) => void;
  actor?: StatusNoticeActor;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const questions = useMemo(() => questionTabsFromRequest(request), [request]);
  const [answerState, setAnswerState] = useState(() =>
    initialAnswerState(questions)
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [open, setOpen] = useState(true);
  const [sent, setSent] = useState(false);
  const [respondError, setRespondError] = useState<string | null>(null);
  const [localDismissed, setLocalDismissed] = useState(false);

  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const questionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const measured = useRef(false);
  const [viewportH, setViewportH] = useState<number | undefined>(undefined);
  const [trackY, setTrackY] = useState(0);
  const [animate, setAnimate] = useState(false);
  const [ready, setReady] = useState(false);

  const clearAdvanceTimer = () => {
    if (advanceTimer.current) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  };

  useEffect(() => {
    clearAdvanceTimer();
    measured.current = false;
    setAnswerState(initialAnswerState(questions));
    setActiveIndex(0);
    setOpen(true);
    setSent(false);
    setRespondError(null);
    setLocalDismissed(false);
    setReady(false);
  }, [questions, request.question_id]);

  useEffect(() => () => clearAdvanceTimer(), []);

  const syncViewport = useCallback((targetIndex: number, withAnim: boolean) => {
    const item = questionRefs.current[targetIndex];
    if (!item) return;
    const nextHeight = item.offsetHeight > 0 ? item.offsetHeight : undefined;
    setViewportH(nextHeight);
    setTrackY(item.offsetTop);
    setAnimate(withAnim && !prefersReducedMotion());
  }, []);

  useLayoutEffect(() => {
    if (mode === 'readonly' || localDismissed || !open || sent) return;
    const withAnim = measured.current;
    measured.current = true;
    syncViewport(activeIndex, withAnim);
    setReady(true);
  }, [
    activeIndex,
    answerState,
    open,
    sent,
    localDismissed,
    mode,
    questions,
    syncViewport,
  ]);

  useEffect(() => {
    if (mode === 'readonly' || localDismissed || !open || sent) return;
    const id = requestAnimationFrame(() =>
      syncViewport(activeIndex, measured.current)
    );
    const activeNode = questionRefs.current[activeIndex];
    if (!activeNode || typeof ResizeObserver !== 'function') {
      return () => cancelAnimationFrame(id);
    }
    const observer = new ResizeObserver(() => {
      syncViewport(activeIndex, false);
    });
    if (typeof observer.observe === 'function') {
      observer.observe(activeNode);
    }
    return () => {
      cancelAnimationFrame(id);
      observer.disconnect();
    };
  }, [activeIndex, mode, open, sent, localDismissed, syncViewport]);

  if (mode === 'readonly') {
    const question = questions[activeIndex] ?? questions[0];
    if (!question) return null;
    const readonlyAnswers = answers ?? {};
    const updateReadonlyIndex = (nextIndex: number) => {
      setActiveIndex(nextIndex);
      onQuestionIndexChange?.(nextIndex);
    };
    return (
      <div
        className="agent-question-detail"
        data-testid="agent-question-detail"
        data-mode="readonly"
      >
        <ReadonlyQuestionFields
          requestId={request.question_id}
          question={question}
          answer={readonlyAnswers[question.id] ?? emptyQuestionAnswerState()}
        />
        {questions.length > 1 ? (
          <div className="agent-question-detail-pager">
            <button
              type="button"
              className="agent-question-detail-pager-btn"
              aria-label={t('questionRequestCard.previous')}
              disabled={activeIndex === 0}
              onClick={() => updateReadonlyIndex(Math.max(0, activeIndex - 1))}
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            </button>
            <span className="agent-question-card-position">
              {activeIndex + 1} / {questions.length}
            </span>
            <button
              type="button"
              className="agent-question-detail-pager-btn"
              aria-label={t('questionRequestCard.next')}
              disabled={activeIndex >= questions.length - 1}
              onClick={() =>
                updateReadonlyIndex(
                  Math.min(questions.length - 1, activeIndex + 1)
                )
              }
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const activeQuestion = questions[activeIndex];
  if (localDismissed || !activeQuestion) return null;

  const isLast = activeIndex === questions.length - 1;
  const activeAnswer =
    answerState[activeQuestion.id] ?? emptyQuestionAnswerState();
  const currentHasAnswer = hasAnswer(activeAnswer);
  const canSubmit = currentHasAnswer || hasCompletedAnswers(answerState);

  const goTo = (nextIndex: number) => {
    clearAdvanceTimer();
    const clamped = Math.min(Math.max(nextIndex, 0), questions.length - 1);
    setActiveIndex(clamped);
    onQuestionIndexChange?.(clamped);
  };

  const dismissCard = () => {
    clearAdvanceTimer();
    setLocalDismissed(true);
    onDismiss?.(request.question_id);
  };

  const submitState = async (
    targetState: Record<string, QuestionAnswerState>
  ) => {
    if (responding || !onRespond) return;
    const readyToSend =
      hasAnswer(targetState[activeQuestion.id]) ||
      hasCompletedAnswers(targetState);
    if (!readyToSend) return;
    clearAdvanceTimer();
    setRespondError(null);
    try {
      await Promise.resolve(
        onRespond(request.question_id, {
          action: 'accept',
          content: responseContent(request, questions, targetState),
        })
      );
      setSent(true);
    } catch (error) {
      setRespondError(getErrorMessage(error));
    }
  };

  const submit = () => submitState(answerState);

  const decline = async () => {
    if (responding || !onRespond) return;
    clearAdvanceTimer();
    setRespondError(null);
    try {
      await Promise.resolve(
        onRespond(request.question_id, { action: 'decline' })
      );
    } catch (error) {
      if (isOrphanedQuestionResponseError(error)) {
        dismissCard();
        return;
      }
      setRespondError(getErrorMessage(error));
    }
  };

  const handleChoiceSelect = (
    question: QuestionTab,
    questionIndex: number,
    value: PrimitiveValue
  ) => {
    if (responding) return;
    clearAdvanceTimer();
    const current = answerState[question.id] ?? emptyQuestionAnswerState();
    const updatedQuestionState: QuestionAnswerState = !question.multiSelect
      ? {
          selected: [value],
          customActive: false,
          customText: '',
        }
      : {
          ...current,
          selected: current.selected.some((item) => item === value)
            ? current.selected.filter((item) => item !== value)
            : [...current.selected, value],
        };
    const nextState: Record<string, QuestionAnswerState> = {
      ...answerState,
      [question.id]: updatedQuestionState,
    };
    setAnswerState(nextState);

    if (!question.multiSelect) {
      const targetIsLast = questionIndex >= questions.length - 1;
      const allAnswered = questions.every((item) =>
        hasAnswer(nextState[item.id])
      );
      advanceTimer.current = setTimeout(() => {
        advanceTimer.current = null;
        if (!targetIsLast) {
          const nextIdx = Math.min(questions.length - 1, questionIndex + 1);
          setActiveIndex(nextIdx);
          onQuestionIndexChange?.(nextIdx);
        } else if (allAnswered) {
          void submitState(nextState);
        }
      }, AUTO_ADVANCE_MS);
    }
  };

  const handleCustomTextChange = (
    question: QuestionTab,
    customText: string
  ) => {
    if (responding) return;
    if (!question.multiSelect) {
      clearAdvanceTimer();
    }
    const hasCustomText = customText.length > 0;
    setAnswerState((current) => {
      const existing = current[question.id] ?? emptyQuestionAnswerState();
      return {
        ...current,
        [question.id]: {
          ...existing,
          customActive: hasCustomText || question.choices.length === 0,
          customText,
          selected: question.multiSelect ? existing.selected : [],
        },
      };
    });
  };

  if (sent) {
    return (
      <div
        className="flex w-full items-center gap-2.5"
        data-testid="agent-question-sent"
        style={{
          animation: prefersReducedMotion()
            ? undefined
            : 'agent-question-pop-in 260ms cubic-bezier(0.23,1,0.32,1) both',
        }}
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[hsl(var(--success)/0.14)] py-1 pl-1 pr-3 text-[12.5px] font-medium text-[var(--status-success-text)]">
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--status-success-text)] text-[var(--surface-dialog)]">
            <Check className="h-3 w-3" strokeWidth={3} />
          </span>
          {t('questionRequestCard.sentMessage')}
        </span>
      </div>
    );
  }

  if (!open) {
    const collapsedTitle =
      activeQuestion.question ||
      activeQuestion.header ||
      t('questionRequestCard.title');
    return (
      <div className="w-full">
        <section
          role="group"
          aria-label={t('questionRequestCard.title')}
          className="agent-question-card agent-question-card--collapsed relative overflow-hidden"
          data-expanded="false"
          data-testid="agent-question-card"
        >
          <button
            type="button"
            data-testid="agent-question-reopen"
            aria-expanded={false}
            aria-label={t('questionRequestCard.expand')}
            title={collapsedTitle}
            onClick={() => {
              measured.current = false;
              setOpen(true);
            }}
            className="agent-question-collapsed-bar flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-[var(--surface-control-hover)]"
          >
            {actor ? (
              <StatusNoticeActorChip
                actor={{ ...actor, onOpenSession: undefined }}
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-[var(--text-primary)]">
              {collapsedTitle}
            </span>
            <span
              data-testid="agent-question-position"
              aria-label={`${activeIndex + 1} / ${questions.length}`}
              className="agent-question-card-position shrink-0 text-[12px] font-medium tabular-nums text-[var(--text-muted)]"
            >
              {activeIndex + 1} / {questions.length}
            </span>
            <ChevronUp
              className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
              strokeWidth={2}
              aria-hidden
            />
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="w-full">
      <section
        role="group"
        aria-label={t('questionRequestCard.title')}
        className="agent-question-card relative overflow-hidden"
        data-expanded="true"
        data-testid="agent-question-card"
        style={{
          animation: prefersReducedMotion()
            ? undefined
            : 'agent-question-fade-up 380ms cubic-bezier(0.23,1,0.32,1) both',
        }}
      >
        <button
          type="button"
          aria-label={t('questionRequestCard.collapse')}
          aria-expanded={true}
          title={t('questionRequestCard.collapse')}
          onClick={() => {
            clearAdvanceTimer();
            setOpen(false);
          }}
          className="absolute right-2.5 top-2.5 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors duration-100 hover:bg-[var(--surface-control-hover)] hover:text-[var(--text-primary)]"
        >
          <ChevronDown className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>

        <div className="agent-question-card-content">
          {actor ? (
            <div className="mb-2 flex items-center pr-9">
              <StatusNoticeActorChip actor={actor} />
            </div>
          ) : null}
          <div
            className="overflow-hidden"
            style={{
              height: viewportH,
              transition: animate ? `height ${SLIDE}` : undefined,
            }}
            aria-live="polite"
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 26,
                transform: `translate3d(0, ${-trackY}px, 0)`,
                transition: animate ? `transform ${SLIDE}` : undefined,
                willChange: 'transform',
              }}
            >
              {questions.map((question, qIdx) => {
                const active = qIdx === activeIndex;
                if (!ready && !active) return null;
                const qAnswer =
                  answerState[question.id] ?? emptyQuestionAnswerState();
                const questionStyle: CSSProperties = {
                  opacity: active ? 1 : 0,
                  transition: animate ? `opacity ${SLIDE}` : undefined,
                  pointerEvents: active ? undefined : 'none',
                };

                return (
                  <div
                    key={question.id}
                    ref={(el) => {
                      questionRefs.current[qIdx] = el;
                    }}
                    aria-hidden={active ? undefined : true}
                    style={questionStyle}
                  >
                    <div className="agent-question-card-prompt pr-9">
                      {question.question}
                    </div>
                    <GlideMenu
                      role={question.multiSelect ? 'group' : 'radiogroup'}
                      ariaLabel={question.question}
                      className="mt-2.5 flex flex-col gap-1"
                      highlightClassName="inset-x-0 rounded-[var(--radius)] bg-[var(--surface-control)]"
                    >
                      {question.choices.map((choice, choiceIndex) => {
                        const selected = qAnswer.selected.some(
                          (value) => value === choice.value
                        );
                        const controlId = `${request.question_id}-${question.id}-${choiceIndex}`;
                        return (
                          <label
                            key={`${choiceIndex}-${choice.label}`}
                            data-menu-row
                            htmlFor={controlId}
                            className={cn(
                              'agent-question-option-row relative z-10 flex cursor-pointer items-start gap-2 rounded-[var(--radius)] pl-1.5 pr-2.5 py-1.5 text-left transition-colors duration-100',
                              selected && 'is-selected',
                              responding && 'cursor-default opacity-60'
                            )}
                          >
                            <input
                              id={controlId}
                              type={question.multiSelect ? 'checkbox' : 'radio'}
                              name={`${request.question_id}-${question.id}`}
                              value={String(choice.value)}
                              checked={selected}
                              disabled={responding || !active}
                              tabIndex={active ? 0 : -1}
                              onChange={() => {
                                if (active) {
                                  handleChoiceSelect(
                                    question,
                                    qIdx,
                                    choice.value
                                  );
                                }
                              }}
                              className="sr-only"
                            />
                            <span
                              aria-hidden
                              className={cn(
                                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center transition-colors duration-200',
                                question.multiSelect
                                  ? 'rounded-sm'
                                  : 'rounded-full',
                                selected
                                  ? 'bg-[var(--text-primary)] text-[var(--surface-dialog)]'
                                  : 'text-transparent shadow-[inset_0_0_0_1.5px_var(--border-strong)]'
                              )}
                            >
                              {question.multiSelect ? (
                                <Check className="h-3 w-3" strokeWidth={3} />
                              ) : (
                                <span
                                  className="h-1.5 w-1.5 rounded-full bg-[var(--surface-dialog)] transition-transform duration-200"
                                  style={{
                                    transform: selected
                                      ? 'scale(1)'
                                      : 'scale(0)',
                                  }}
                                />
                              )}
                            </span>
                            <span className="agent-question-option-copy">
                              <span
                                className={cn(
                                  'agent-question-option-label text-[13px] leading-snug transition-colors duration-200',
                                  selected
                                    ? 'text-[var(--text-primary)]'
                                    : 'text-[var(--text-secondary)]'
                                )}
                              >
                                <span>{choice.label}</span>
                                {choice.recommended ? (
                                  <Badge
                                    label={t('questionRequestCard.recommended')}
                                    className="agent-question-recommended"
                                  />
                                ) : null}
                              </span>
                              {choice.description ? (
                                <span className="agent-question-option-description">
                                  {choice.description}
                                </span>
                              ) : null}
                            </span>
                          </label>
                        );
                      })}

                      <label
                        data-menu-row
                        className={cn(
                          'agent-question-custom-row relative z-10 flex cursor-text items-center rounded-[var(--radius)] px-2.5 py-2 transition-colors duration-100',
                          question.choices.length === 0 &&
                            'agent-question-custom-row--solo'
                        )}
                      >
                        <input
                          type={
                            question.valueType === 'number' ||
                            question.valueType === 'integer'
                              ? 'number'
                              : 'text'
                          }
                          tabIndex={active ? 0 : -1}
                          disabled={responding || !active}
                          value={qAnswer.customText}
                          onChange={(event) => {
                            if (active) {
                              handleCustomTextChange(
                                question,
                                event.target.value
                              );
                            }
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key === 'Enter' &&
                              !event.nativeEvent.isComposing &&
                              active &&
                              currentHasAnswer
                            ) {
                              event.preventDefault();
                              if (isLast) {
                                if (canSubmit) void submit();
                              } else {
                                goTo(activeIndex + 1);
                              }
                            }
                          }}
                          placeholder={t(
                            'questionRequestCard.customPlaceholder'
                          )}
                          aria-label={t('questionRequestCard.customAnswer')}
                          className="agent-question-custom-field min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--text-primary)] shadow-none outline-none focus:outline-none focus-visible:outline-none placeholder:text-[var(--text-muted)]"
                        />
                      </label>
                    </GlideMenu>
                  </div>
                );
              })}
            </div>
          </div>

          {respondError ? (
            <div
              role="alert"
              data-testid="agent-question-error"
              className="mt-2.5 flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
            >
              <span className="min-w-0 flex-1 break-words">{respondError}</span>
              <button
                type="button"
                data-testid="agent-question-dismiss"
                onClick={dismissCard}
                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-destructive/15"
                aria-label={t('common:close')}
              >
                <X className="h-3 w-3" aria-hidden />
                <span>{t('common:close')}</span>
              </button>
            </div>
          ) : null}
        </div>

        <footer className="agent-question-card-actions">
          <div className="flex items-center gap-1 text-[var(--text-muted)]">
            <button
              type="button"
              aria-label={t('questionRequestCard.previous')}
              disabled={activeIndex <= 0 || responding}
              onClick={() => goTo(activeIndex - 1)}
              className="flex h-[20px] w-[20px] items-center justify-center rounded-sm transition-colors duration-100 enabled:hover:text-[var(--text-primary)] disabled:opacity-30"
            >
              <ChevronUp className="h-3.5 w-3.5" aria-hidden />
            </button>
            <span
              data-testid="agent-question-position"
              aria-label={`${activeIndex + 1} / ${questions.length}`}
              className="agent-question-card-position inline-flex items-center text-[12px] font-medium tabular-nums"
              style={{ letterSpacing: '-0.1px', lineHeight: 1 }}
            >
              <RollingDigits
                value={`${activeIndex + 1} / ${questions.length}`}
              />
            </span>
            <button
              type="button"
              aria-label={t('questionRequestCard.next')}
              disabled={isLast || responding}
              onClick={() => goTo(activeIndex + 1)}
              className="flex h-[20px] w-[20px] items-center justify-center rounded-sm transition-colors duration-100 enabled:hover:text-[var(--text-primary)] disabled:opacity-30"
            >
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="agent-question-action agent-question-decline inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-full px-3.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-50"
              disabled={responding}
              onClick={() => {
                if (isLast) {
                  void decline();
                } else {
                  goTo(activeIndex + 1);
                }
              }}
            >
              {t('questionRequestCard.skip')}
            </button>
            <Button
              type="button"
              variant="default"
              size="sm"
              className="agent-question-action agent-question-submit rounded-full px-3.5 text-xs"
              disabled={responding || (isLast ? !canSubmit : !currentHasAnswer)}
              onClick={() => {
                if (isLast) {
                  void submit();
                } else {
                  goTo(activeIndex + 1);
                }
              }}
            >
              <span>
                {isLast
                  ? t('questionRequestCard.submit')
                  : t('questionRequestCard.continue')}
              </span>
              <CornerDownLeft
                className="ml-1 h-3 w-3 opacity-75"
                aria-hidden="true"
              />
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function ReadonlyQuestionFields({
  requestId,
  question,
  answer,
}: {
  requestId: string;
  question: QuestionTab;
  answer: QuestionAnswerState;
}) {
  const { t } = useTranslation(['conversation']);
  return (
    <div className="agent-question-fields">
      <div
        className="agent-question-options"
        role={question.multiSelect ? 'group' : 'radiogroup'}
        aria-label={question.question}
      >
        {question.choices.map((choice, choiceIndex) => {
          const selected = answer.selected.some(
            (value) => value === choice.value
          );
          const controlId = `${requestId}-${question.id}-${choiceIndex}`;
          return (
            <label
              key={`${choiceIndex}-${choice.label}`}
              htmlFor={controlId}
              className={cn(
                'agent-question-option agent-question-option--readonly',
                selected && 'is-answered'
              )}
            >
              <input
                id={controlId}
                type={question.multiSelect ? 'checkbox' : 'radio'}
                name={`${requestId}-${question.id}`}
                value={String(choice.value)}
                checked={selected}
                disabled
                readOnly
                onChange={() => undefined}
              />
              <span className="agent-question-option-indicator" aria-hidden>
                {selected ? (
                  question.multiSelect ? (
                    <Check className="h-2.5 w-2.5" strokeWidth={3} />
                  ) : (
                    <span className="agent-question-option-radio-dot" />
                  )
                ) : null}
              </span>
              <span className="agent-question-option-copy">
                <span className="agent-question-option-label">
                  <span>{choice.label}</span>
                  {choice.recommended ? (
                    <Badge
                      label={t('questionRequestCard.recommended')}
                      className="agent-question-recommended"
                    />
                  ) : null}
                </span>
                {choice.description ? (
                  <span className="agent-question-option-description">
                    {choice.description}
                  </span>
                ) : null}
              </span>
              {selected ? (
                <Check
                  className="agent-question-option-check h-3.5 w-3.5 shrink-0"
                  strokeWidth={2.5}
                  aria-hidden="true"
                />
              ) : null}
            </label>
          );
        })}

        {answer.customActive ? (
          <div className="agent-question-custom-readonly is-answered">
            <PenLine
              className="h-3.5 w-3.5 shrink-0 text-[var(--status-success-text)]"
              aria-hidden="true"
            />
            <input
              type={
                question.valueType === 'number' ||
                question.valueType === 'integer'
                  ? 'number'
                  : 'text'
              }
              className="agent-question-custom-input agent-question-custom-input--readonly"
              aria-label={t('questionRequestCard.customAnswer')}
              placeholder={t('questionRequestCard.customPlaceholder')}
              disabled
              readOnly
              value={answer.customText}
              onChange={() => undefined}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
