import { Check, ChevronRight } from 'lucide-react';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ConversationQuestionRequest,
  ConversationQuestionResponse,
} from 'shared/types';
import { cn } from '@/lib/utils';
import { useExpandable } from '@/stores/useExpandableStore';
import { AgentQuestionCard } from '@/components/tasks/follow-up/AgentQuestionCard';
import {
  answerStateFromResponse,
  answerStateFromToolResult,
  displayAnswerLabels,
  firstQuestionTitle,
  isQuestionDeclined,
  mergeQuestionRequestWithToolUse,
  questionRequestFromToolUse,
  questionTabsFromRequest,
} from '@/components/tasks/follow-up/agentQuestionModel';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';

export function AskQuestionToolCard({
  use,
  result = null,
  request,
  response = null,
  expansionKey,
  onExpandedChange,
}: {
  use?: ToolUseBlock | null;
  result?: ToolResultBlock | null;
  request?: ConversationQuestionRequest | null;
  response?: ConversationQuestionResponse | null;
  expansionKey?: string;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const { t } = useTranslation('conversation');
  const id = useId();
  const [open, setOpen] = useExpandable(expansionKey ?? id);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const [titleOverflows, setTitleOverflows] = useState(false);
  const resolvedRequest = useMemo(
    () =>
      request
        ? mergeQuestionRequestWithToolUse(request, use)
        : use
          ? questionRequestFromToolUse(use)
          : null,
    [request, use]
  );
  const questions = useMemo(
    () => (resolvedRequest ? questionTabsFromRequest(resolvedRequest) : []),
    [resolvedRequest]
  );
  const answers = useMemo(
    () =>
      answerStateFromResponse(questions, response) ??
      answerStateFromToolResult(questions, result),
    [questions, response, result]
  );
  const declined = useMemo(
    () => !answers && isQuestionDeclined(response, result),
    [answers, response, result]
  );
  const answeredSummary = useMemo(() => {
    if (!answers) return [];
    return questions.flatMap((question, index) => {
      const labels = displayAnswerLabels(question, answers[question.id]);
      if (labels.length === 0) return [];
      return [{ question, index, labels }];
    });
  }, [answers, questions]);
  const hasAnyAnswer = answeredSummary.length > 0;
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const activeQuestionTitle =
    questions[activeQuestionIndex]?.question ||
    questions[activeQuestionIndex]?.header ||
    firstQuestionTitle(questions);
  const title = activeQuestionTitle || t('askQuestion.title');

  useLayoutEffect(() => {
    const node = titleRef.current;
    if (!node) return;
    const update = () => {
      setTitleOverflows(node.scrollWidth - node.clientWidth > 1);
    };
    update();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(update);
    if (typeof observer.observe !== 'function') return undefined;
    observer.observe(node);
    return () => observer.disconnect();
  }, [title]);

  if (!resolvedRequest) return null;

  return (
    <div
      role="group"
      aria-label={title}
      data-testid="ask-question-tool-card"
      data-expanded={open ? 'true' : 'false'}
      data-status={
        hasAnyAnswer ? 'answered' : declined ? 'declined' : 'pending'
      }
      className="ask-question-tool-card rounded-lg border border-border bg-card text-sm text-card-foreground"
    >
      <div className="ask-question-tool-header">
        <span
          ref={titleRef}
          data-testid="ask-question-title"
          title={title}
          className={cn(
            'ask-question-tool-title min-w-0 flex-1 font-medium text-foreground',
            titleOverflows && 'is-overflow'
          )}
        >
          {title}
        </span>
        <div className="ask-question-tool-badges">
          {hasAnyAnswer ? (
            <span
              data-testid="ask-question-status"
              className="ask-question-status-pill is-answered"
            >
              <span className="ask-question-status-dot" aria-hidden="true">
                <Check className="h-2.5 w-2.5" strokeWidth={3} />
              </span>
              <span>{t('questionRequestCard.answered')}</span>
            </span>
          ) : declined ? (
            <span
              data-testid="ask-question-status"
              className="ask-question-status-pill is-declined"
            >
              <span>{t('askQuestion.declined')}</span>
            </span>
          ) : null}
          {questions.length > 0 ? (
            <button
              type="button"
              className="ask-question-details-toggle"
              aria-expanded={open}
              onClick={() => {
                onExpandedChange?.(!open);
                setOpen(!open);
              }}
            >
              <ChevronRight
                aria-hidden
                className={cn(
                  'h-3 w-3 transition-transform duration-150',
                  open && 'rotate-90'
                )}
              />
              <span>{t('askQuestion.viewDetails')}</span>
            </button>
          ) : null}
        </div>
      </div>

      {!open && hasAnyAnswer ? (
        <div
          className="ask-question-summary"
          data-testid="ask-question-summary"
        >
          {questions.length === 1 ? (
            <div className="ask-question-summary-chips">
              {answeredSummary[0].labels.map((label, idx) => (
                <span
                  key={`${idx}-${label}`}
                  className="ask-question-answer-chip"
                >
                  <Check
                    className="h-3 w-3 shrink-0"
                    strokeWidth={2.5}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate">{label}</span>
                </span>
              ))}
            </div>
          ) : (
            <div className="ask-question-summary-list">
              {answeredSummary.map(({ question, index, labels }) => (
                <div key={question.id} className="ask-question-summary-row">
                  <span className="ask-question-summary-index tabular-nums">
                    {index + 1}
                  </span>
                  <span
                    className="ask-question-summary-question"
                    title={question.question}
                  >
                    {question.question || question.header}
                  </span>
                  <span className="ask-question-summary-answers">
                    {labels.map((label, idx) => (
                      <span
                        key={`${idx}-${label}`}
                        className="ask-question-answer-chip"
                        title={label}
                      >
                        <Check
                          className="h-3 w-3 shrink-0"
                          strokeWidth={2.5}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 truncate">{label}</span>
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {open && questions.length > 0 ? (
        <AgentQuestionCard
          request={resolvedRequest}
          mode="readonly"
          answers={answers}
          onQuestionIndexChange={setActiveQuestionIndex}
        />
      ) : null}
    </div>
  );
}
