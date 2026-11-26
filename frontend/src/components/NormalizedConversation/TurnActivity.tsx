import { useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Images } from 'lucide-react';
import type {
  ActionType,
  ConversationDelegationView,
  ConversationQuestionRequest,
  ConversationQuestionResponse,
  ImageData,
  MessageTurn,
  TaskWithAttemptStatus,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import DisplayConversationEntry from './DisplayConversationEntry';
import { useDecodedTimelineImage } from './TimelineDecodedImage';
import { DelegationCard } from './conversation/DelegationCard';
import { HostDelegationLifecycleRow } from './conversation/HostDelegationLifecycleRow';
import {
  collectHostDelegationPollResults,
  isHostDelegationLifecycleTool,
  isHostDelegationTool,
  matchHostDelegationView,
  mergeHostDelegationView,
} from './conversation/hostDelegation';
import {
  isCompanionMcpDiscoverySearch,
  isCompanionSearchQuery,
} from './tools/subagentCardModel';
import {
  getToolCallDescription,
  getToolExitStatus,
  getToolSummary,
} from './conversation-entry-utils';
import type { IndexedTurnItem } from './messageTurnAggregate';
import {
  planTurnBlocks,
  type ToolResultBlock,
  type ToolUseBlock,
  type TurnRenderItem,
} from './messageTurnBlocks';
import {
  toolBlockToNormalizedEntry,
  type ToolDisplayEntry,
} from './messageTurnTool';
import { SubagentCard } from './tools/SubagentCard';
import { AskQuestionToolCard } from './tools/AskQuestionToolCard';
import { GoalToolCall, isGoalToolUse } from './tools/GoalToolCall';
import {
  groupConsecutiveBackgroundTasks,
  isToolCallBackgrounded,
  parseBackgroundPollTaskId,
} from '@/lib/asyncTasks';
import {
  firstQuestionTitle,
  isAskQuestionTool,
  isQuestionToolName,
  questionRequestFromToolUse,
  questionTabsFromRequest,
} from '@/components/tasks/follow-up/agentQuestionModel';
import {
  applySubagentLifecycle,
  buildSubagentCardModel,
  foldSubagentLifecycle,
  isCodexSubagentHeartbeat,
  isNativeSubagentTool,
  isSubagentLifecycleTool,
  shouldHideLifecycleTool,
  type SubagentChildTool,
  type SubagentLifecycleEvent,
  type SubagentStatus,
} from './tools/subagentCardModel';
import { useSubagentLifecycleIndex } from './tools/SubagentLifecycleContext';
import { getToolChatStatus, ToolCallResultDetail } from './tools/ToolCardShell';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { deriveRelativeFilePath } from '@/utils/filePaths';
import { fileReadLocation, resolveToolFilePath } from './tools/FileToolCard';
import { ToolCallTarget } from './tools/ToolCallTarget';
import { listDirPath } from './tools/toolDirListing';
import { useOpenImagePreview } from '@/hooks/useOpenImagePreview';
import { useExpandable, useExpandableItems } from '@/stores/useExpandableStore';
import { cn } from '@/lib/utils';
import { ThinkingEntry } from './ThinkingEntry';
import {
  TurnToolChipRow,
  TurnToolChipsBatch,
  type TurnToolBatchLiveHeader,
  type TurnToolChipItem,
  type TurnToolIconKind,
  type TurnToolStatus,
} from './TurnToolChips';
import {
  countFileChangesStats,
  extractBatchDiffChips,
  type TurnToolDiffChip,
} from './turnToolDiffChips';

type ToolSummaryCategory =
  | 'commands'
  | 'reads'
  | 'edits'
  | 'searches'
  | 'webFetches'
  | 'agents'
  | 'otherActivities'
  | 'other';

const SUMMARY_ORDER: ToolSummaryCategory[] = [
  'commands',
  'edits',
  'agents',
  'searches',
  'reads',
  'webFetches',
  'other',
  'otherActivities',
];

function formatBatchTimestamp(
  timestamp: MessageTurn['timestamp']
): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function categoryIconKind(category: ToolSummaryCategory): TurnToolIconKind {
  switch (category) {
    case 'commands':
      return 'run';
    case 'edits':
      return 'write';
    case 'reads':
      return 'read';
    case 'searches':
      return 'search';
    case 'webFetches':
      return 'web';
    case 'agents':
      return 'agent';
    default:
      return 'tool';
  }
}

function lowercaseLeadingAscii(text: string): string {
  if (!text) return text;
  const first = text.charCodeAt(0);
  if (first >= 65 && first <= 90) {
    return String.fromCharCode(first + 32) + text.slice(1);
  }
  return text;
}

type ActivityEntry =
  | {
      kind: 'tool';
      key: string;
      index: number;
      call: TurnToolChipItem;
      rawEntry: ToolDisplayEntry;
    }
  | {
      kind: 'visible';
      key: string;
      index: number;
      content: ReactNode;
      category?: ToolSummaryCategory | null;
      alwaysVisible?: boolean;
    }
  | {
      kind: 'thinking';
      key: string;
      index: number;
      endIndex: number;
      texts: string[];
    };

type FileReadAction = Extract<ActionType, { action: 'file_read' }>;
type FileEditAction = Extract<ActionType, { action: 'file_edit' }>;

type ViewedImage = {
  key: string;
  image: ImageData;
  path: string;
};

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function ViewedImages({
  expansionKey,
  images,
  onExpandedChange,
}: {
  expansionKey: string;
  images: ViewedImage[];
  onExpandedChange: (expanded: boolean) => void;
}) {
  const { t } = useTranslation('conversation');
  const [expanded, toggle] = useExpandable(expansionKey, false);
  const openImagePreview = useOpenImagePreview();

  return (
    <section className="rounded-lg bg-card text-foreground">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={expanded}
        onClick={() => {
          onExpandedChange(!expanded);
          toggle();
        }}
      >
        <Images className="h-4 w-4" aria-hidden="true" />
        <span>{t('viewedImages.summary', { count: images.length })}</span>
        <ChevronDown
          className={cn(
            'h-4 w-4 transition-transform motion-reduce:transition-none',
            expanded ? 'rotate-0' : '-rotate-90'
          )}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div className="flex flex-wrap gap-2 px-2 pb-2" role="list">
          {images.map(({ key, image, path }) => (
            <ViewedImageThumb
              key={key}
              image={image}
              path={path}
              onOpen={(src) =>
                openImagePreview({
                  imageUrl: src,
                  altText: path,
                  fileName: fileName(path),
                })
              }
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ViewedImageThumb({
  image,
  path,
  onOpen,
}: {
  image: ImageData;
  path: string;
  onOpen: (src: string) => void;
}) {
  const { t } = useTranslation('conversation');
  const src = useDecodedTimelineImage({
    imageKey: `${path}:${image.uri ?? ''}:${image.data.slice(0, 24)}`,
    enabled: true,
    data: image.data,
    mimeType: image.mime_type,
    uri: image.uri ?? null,
  });
  if (!src) return null;
  return (
    <div role="listitem">
      <button
        type="button"
        className="h-24 w-24 overflow-hidden rounded-lg border border-border bg-muted/30 p-1 hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={path}
        aria-label={t('viewedImages.preview', { path })}
        onClick={() => onOpen(src)}
      >
        <img
          src={src}
          alt={path}
          className="h-full w-full rounded-md object-contain"
        />
      </button>
    </div>
  );
}

function FileReadStats({
  action,
  workspacePath,
}: {
  action: FileReadAction;
  workspacePath?: string | null;
}) {
  const panelActions = useOptionalPanelActionsContext();
  const openPreview = useCallback(() => {
    const resolvedPath = resolveToolFilePath(action.path, workspacePath);
    const relativePath = deriveRelativeFilePath(resolvedPath, workspacePath);
    const title = relativePath ?? action.path;
    panelActions?.openFilePreview(resolvedPath, {
      displayPath: title,
      title,
      location: fileReadLocation(action.line_start, action.line_end),
    });
  }, [
    action.line_end,
    action.line_start,
    action.path,
    panelActions,
    workspacePath,
  ]);
  const range =
    action.line_start != null
      ? action.line_end != null
        ? `L${action.line_start}–${action.line_end}`
        : `L${action.line_start}+`
      : null;

  return (
    <ToolCallTarget
      text={action.path}
      path={action.path}
      showIcon={false}
      suffix={range}
      onClick={openPreview}
    />
  );
}

function FileEditPath({
  action,
  workspacePath,
}: {
  action: FileEditAction;
  workspacePath?: string | null;
}) {
  const panelActions = useOptionalPanelActionsContext();
  const openPreview = useCallback(() => {
    const resolvedPath = resolveToolFilePath(action.path, workspacePath);
    const relativePath = deriveRelativeFilePath(resolvedPath, workspacePath);
    const title = relativePath ?? action.path;
    panelActions?.openFilePreview(resolvedPath, {
      mode: 'diff',
      diffViewMode: 'inline',
      displayPath: title,
      title,
    });
  }, [action.path, panelActions, workspacePath]);
  return (
    <ToolCallTarget
      text={action.path}
      path={action.path}
      showIcon={false}
      onClick={openPreview}
    />
  );
}

function subagentChatStatus(status: SubagentStatus): TurnToolStatus {
  switch (status) {
    case 'running':
    case 'background':
      return 'running';
    case 'failed':
      return 'error';
    case 'completed':
      return 'complete';
  }
}

function toolIconKind(action: ActionType): TurnToolIconKind {
  switch (action.action) {
    case 'file_edit':
      return 'write';
    case 'command_run':
      return 'run';
    case 'file_read':
      return 'read';
    case 'search':
      return 'search';
    case 'web_fetch':
      return 'web';
    case 'task_create':
      return 'agent';
    case 'tool':
      return action.tool_name === 'list_dir' ? 'read' : 'tool';
    default:
      return 'tool';
  }
}

function HostDelegationToolCall({
  use,
  result,
  event,
  pollResults,
  onOpenChild,
  workspacePath,
  expansionKey,
  onExpandedChange,
}: {
  use: ToolUseBlock;
  result: ToolResultBlock | null;
  event: ConversationDelegationView | null;
  pollResults: readonly ToolResultBlock[];
  onOpenChild?: (childConversationId: string) => void;
  workspacePath?: string | null;
  expansionKey: string;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const delegation = mergeHostDelegationView(use, result, event, pollResults);
  return (
    <DelegationCard
      delegation={delegation}
      onOpenChild={onOpenChild}
      workspacePath={workspacePath}
      expansionKey={expansionKey}
      onExpandedChange={onExpandedChange}
    />
  );
}

function SubagentToolCall({
  expansionKey,
  label,
  target,
  use,
  result,
  lifecycle,
  childrenTools = [],
  parentAgentId,
  workspacePath,
  onExpandedChange,
}: {
  expansionKey: string;
  label: string;
  target?: string;
  use: ToolUseBlock;
  result: ToolResultBlock | null;
  lifecycle: SubagentLifecycleEvent[];
  childrenTools?: SubagentChildTool[];
  parentAgentId?: string | null;
  workspacePath?: string | null;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useExpandable(expansionKey, true);
  const model = applySubagentLifecycle(
    buildSubagentCardModel(use, result, parentAgentId, childrenTools),
    lifecycle
  );
  const handleExpandedChange = (nextExpanded: boolean) => {
    onExpandedChange(nextExpanded);
    setExpanded(nextExpanded);
  };

  return (
    <div className="space-y-1">
      <TurnToolChipRow
        icon="agent"
        label={label}
        chip={
          target ? <ToolCallTarget text={target} showIcon={false} /> : undefined
        }
        status={subagentChatStatus(model.status)}
        expanded={expanded}
        onExpandedChange={handleExpandedChange}
        ariaControls={expansionKey}
      />
      {expanded ? (
        <div id={expansionKey}>
          <SubagentCard
            use={use}
            result={result}
            lifecycle={lifecycle}
            childrenTools={childrenTools}
            parentAgentId={parentAgentId}
            workspacePath={workspacePath}
            expansionKey={`${expansionKey}:sections`}
            onExpandedChange={onExpandedChange}
          />
        </div>
      ) : null}
    </div>
  );
}

function summaryCategory(action: string): ToolSummaryCategory {
  switch (action) {
    case 'command_run':
      return 'commands';
    case 'file_read':
      return 'reads';
    case 'file_edit':
      return 'edits';
    case 'search':
      return 'searches';
    case 'web_fetch':
      return 'webFetches';
    case 'task_create':
      return 'agents';
    default:
      return 'other';
  }
}

export type TimelineQuestion = {
  request: ConversationQuestionRequest;
  response: ConversationQuestionResponse | null;
};

export function TurnActivity({
  turnId,
  timestamp,
  items,
  attempt,
  task,
  workspacePath,
  delegations = [],
  pollResults: suppliedPollResults,
  onOpenChild,
  questions = [],
  isStreaming = false,
  showCompleted = true,
  renderOtherItem,
}: {
  turnId: string;
  timestamp: MessageTurn['timestamp'];
  items: IndexedTurnItem[];
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  workspacePath?: string | null;
  delegations?: ConversationDelegationView[];
  pollResults?: readonly ToolResultBlock[];
  onOpenChild?: (childConversationId: string) => void;
  questions?: TimelineQuestion[];
  isStreaming?: boolean;
  showCompleted?: boolean;
  renderOtherItem?: (item: TurnRenderItem, index: number) => ReactNode;
}) {
  const { t, i18n } = useTranslation('conversation');
  const panelActions = useOptionalPanelActionsContext();
  const lifecycleIndex = useSubagentLifecycleIndex();
  const parentAgentId = attempt.session?.agent_id ?? null;
  const entries = useMemo(
    () =>
      items.flatMap(({ item, index }) => {
        if (item.kind !== 'tool' || !item.use) return [];
        return [
          {
            entry: toolBlockToNormalizedEntry(item.use, item.result, timestamp),
            index,
            toolUseId: item.use.tool_use_id,
            images: item.use.images ?? [],
            use: item.use,
            result: item.result,
            isHostDelegation: isHostDelegationTool(item.use),
            isSubagent: isNativeSubagentTool(item.use),
            isAskQuestion: isAskQuestionTool(item.use),
            isGoal: isGoalToolUse(item.use),
          },
        ];
      }),
    [items, timestamp]
  );
  const folded = useMemo(() => {
    const localIds = new Set(
      entries.map((entry) => entry.use.tool_use_id).filter(Boolean)
    );
    return foldSubagentLifecycle(
      entries.map(({ use, result }) => ({ use, result })),
      lifecycleIndex.events.filter(
        (event) => !event.toolUseId || !localIds.has(event.toolUseId)
      )
    );
  }, [entries, lifecycleIndex.events]);
  const hostLifecycleEntries = useMemo(
    () => entries.filter((entry) => isHostDelegationLifecycleTool(entry.use)),
    [entries]
  );
  const goalEntries = useMemo(
    () => entries.filter((entry) => entry.isGoal),
    [entries]
  );
  const regularEntries = useMemo(
    () =>
      entries.filter((entry) => {
        if (entry.isGoal) return false;
        if (entry.isHostDelegation) return false;
        if (isHostDelegationLifecycleTool(entry.use)) return false;
        if (isCompanionMcpDiscoverySearch(entry.use)) return false;
        if (
          entry.entry.entry_type.type === 'tool_use' &&
          entry.entry.entry_type.action_type.action === 'search' &&
          isCompanionSearchQuery(entry.entry.entry_type.action_type.query)
        ) {
          return false;
        }
        if (entry.isSubagent) return false;
        if (entry.isAskQuestion) return false;
        if (entry.toolUseId && folded.hiddenToolUseIds.has(entry.toolUseId)) {
          return false;
        }
        if (isCodexSubagentHeartbeat(entry.use)) return false;
        if (!isSubagentLifecycleTool(entry.use)) return true;
        return !shouldHideLifecycleTool(
          entry.use,
          entry.result,
          lifecycleIndex.spawnBindingIds
        );
      }),
    [entries, folded.hiddenToolUseIds, lifecycleIndex.spawnBindingIds]
  );
  const askQuestionEntries = useMemo(
    () =>
      entries.filter((entry) => {
        if (!entry.isAskQuestion) return false;
        const matched = matchTimelineQuestion(entry.use, questions);
        return !(matched && !matched.response && !entry.result);
      }),
    [entries, questions]
  );
  const hostDelegationEntries = useMemo(
    () => entries.filter((entry) => entry.isHostDelegation),
    [entries]
  );
  const pollResults = useMemo(
    () =>
      suppliedPollResults ??
      collectHostDelegationPollResults(
        entries.map(({ use, result }) => ({ use, result }))
      ),
    [entries, suppliedPollResults]
  );
  const subagentEntries = useMemo(
    () =>
      folded.cards.map((card) => {
        const match = entries.find(
          (entry) => entry.use.tool_use_id === card.use.tool_use_id
        );
        return {
          ...card,
          toolUseId: card.use.tool_use_id,
          index: match?.index ?? 0,
        };
      }),
    [entries, folded.cards]
  );

  const callCategories = new Map<string, ToolSummaryCategory>();
  const groupedRegularEntries = useMemo(
    () =>
      groupConsecutiveBackgroundTasks(regularEntries, (item) =>
        parseBackgroundPollTaskId(item.use)
      ),
    [regularEntries]
  );
  const rawCalls: (TurnToolChipItem & { rawEntry: ToolDisplayEntry })[] =
    groupedRegularEntries.flatMap((group) => {
      const primary =
        group.kind === 'poll_group'
          ? (group.items.at(-1) ?? group.items[0]!)
          : group.item;
      const pollCount = group.kind === 'poll_group' ? group.items.length : 1;
      const { entry, index, toolUseId, images, use } = primary;
      if (images.length > 0) return [];
      if (entry.entry_type.type !== 'tool_use') {
        throw new Error('Turn tool aggregate received a non-tool entry');
      }
      const toolEntry = entry.entry_type;
      const summary = getToolSummary(toolEntry, entry.content.trim());
      const description = getToolCallDescription(entry);
      const expansionKey = `${turnId}-${index}`;
      const action = toolEntry.action_type;
      const backgrounded = isToolCallBackgrounded(use.meta);
      const status = backgrounded
        ? 'complete'
        : getToolExitStatus(toolEntry) === 'error'
          ? 'error'
          : getToolChatStatus(toolEntry.status);
      const exitStatus =
        action.action === 'command_run' ? action.result?.exit_status : null;
      const errorMessage =
        status === 'error'
          ? toolEntry.status.status === 'denied'
            ? t('messageTurnView.toolSummary.permissionDenied')
            : toolEntry.status.status === 'timed_out'
              ? t('messageTurnView.toolSummary.timedOut')
              : exitStatus?.type === 'exit_code' && exitStatus.code !== 0
                ? t('messageTurnView.toolSummary.commandExitCode', {
                    code: exitStatus.code,
                  })
                : t('messageTurnView.toolSummary.failed')
          : undefined;
      callCategories.set(
        toolUseId || expansionKey,
        summaryCategory(action.action)
      );
      const editStats =
        action.action === 'file_edit'
          ? countFileChangesStats(
              entry.fileEdits?.flatMap((edit) => edit.changes) ??
                action.changes,
              entry.toolArguments
            )
          : { additions: undefined, deletions: undefined };
      const detailText =
        summary.detail && summary.detail !== summary.label
          ? summary.detail
          : entry.content.trim() && entry.content.trim() !== summary.label
            ? entry.content.trim()
            : '';
      const baseName = description ?? summary.label;
      const defaultDisplayName =
        pollCount > 1 ? `${baseName} ×${pollCount}` : baseName;
      const omitActionLabel =
        !description &&
        ((action.action === 'command_run' && Boolean(detailText)) ||
          (action.action === 'file_edit' && Boolean(action.path)));
      const displayName = omitActionLabel
        ? pollCount > 1
          ? `×${pollCount}`
          : ''
        : !description && action.action === 'file_read'
          ? pollCount > 1
            ? `Read ×${pollCount}`
            : 'Read'
          : defaultDisplayName;
      const baseStats = description ? undefined : action.action ===
        'file_read' ? (
        <FileReadStats
          action={action}
          workspacePath={workspacePath ?? attempt.container_ref}
        />
      ) : action.action === 'file_edit' ? (
        <FileEditPath
          action={action}
          workspacePath={workspacePath ?? attempt.container_ref}
        />
      ) : action.action === 'tool' && action.tool_name === 'list_dir' ? (
        <ToolCallTarget
          text={listDirPath(action.arguments) || detailText}
          path={listDirPath(action.arguments) || detailText}
          isFolder
          showIcon={false}
          onClick={() => {
            const rawDir = (listDirPath(action.arguments) || detailText).trim();
            if (!rawDir) return;
            const resolvedDir = resolveToolFilePath(
              rawDir,
              workspacePath ?? attempt.container_ref
            );
            const relativeDir = deriveRelativeFilePath(
              resolvedDir,
              workspacePath ?? attempt.container_ref
            );
            panelActions?.revealInFileTree(resolvedDir, {
              displayPath: relativeDir ?? rawDir,
              nodeType: 'folder',
            });
          }}
        />
      ) : detailText ? (
        <ToolCallTarget text={detailText} showIcon={false} />
      ) : undefined;
      const resolvedWorkspace = workspacePath ?? attempt.container_ref;
      const targetText = description
        ? undefined
        : action.action === 'file_read' || action.action === 'file_edit'
          ? (deriveRelativeFilePath(
              resolveToolFilePath(action.path, resolvedWorkspace),
              resolvedWorkspace
            ) ?? action.path)
          : action.action === 'tool' && action.tool_name === 'list_dir'
            ? listDirPath(action.arguments) || detailText || undefined
            : detailText || undefined;
      const statsNode = backgrounded ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {baseStats}
          <span
            data-testid="tool-backgrounded-badge"
            className="shrink-0 rounded bg-muted px-1 py-0.5 text-[11px] font-normal text-[var(--text-muted,hsl(var(--muted-foreground)))]"
          >
            {t('asyncTasks.backgroundBadge')}
          </span>
        </span>
      ) : (
        baseStats
      );
      return [
        {
          index,
          key: toolUseId || expansionKey,
          icon: toolIconKind(action),
          label: displayName,
          targetText,
          chip: statsNode,
          monoChip: false,
          additions: editStats.additions,
          deletions: editStats.deletions,
          status,
          errorMessage,
          rawEntry: entry,
          resultDetail: (
            <ToolCallResultDetail>
              <DisplayConversationEntry
                entry={entry}
                expansionKey={expansionKey}
                taskAttempt={attempt}
                task={task ?? undefined}
                workspacePath={resolvedWorkspace}
                toolDetailOnly
              />
            </ToolCallResultDetail>
          ),
        },
      ];
    });

  const detailKeys = rawCalls.map(
    (call) => `tool-detail:${turnId}:${call.key}`
  );
  const [expandedDetails, setExpanded] = useExpandableItems(detailKeys);
  const standaloneKeysRef: { current: Set<string> } = { current: new Set() };
  const preserveStandaloneExpansion = (entryKey: string, expanded: boolean) => {
    if (expanded && standaloneKeysRef.current.has(entryKey)) {
      setExpanded(`activity-batch:${turnId}:${entryKey}`, true);
    }
  };

  const calls = rawCalls.map((call, index) => ({
    ...call,
    isDetailExpanded: expandedDetails[index],
    onDetailExpandedChange: (expanded: boolean) => {
      setExpanded(detailKeys[index], expanded);
      preserveStandaloneExpansion(`tool-batch:${turnId}:${call.key}`, expanded);
    },
  }));

  const isEnglish = (i18n.resolvedLanguage ?? i18n.language)
    .toLowerCase()
    .startsWith('en');

  const entrySummaryCategory = (
    entry: ActivityEntry
  ): ToolSummaryCategory | null =>
    entry.kind === 'tool'
      ? (callCategories.get(entry.call.key) ?? 'other')
      : entry.kind === 'visible'
        ? entry.category === undefined
          ? 'other'
          : entry.category
        : null;

  const summarizeActivities = (batch: ActivityEntry[]): string => {
    const counts = SUMMARY_ORDER.flatMap((category) => {
      const count = batch.filter(
        (entry) => entrySummaryCategory(entry) === category
      ).length;
      return count > 0 ? [{ category, count }] : [];
    });
    if (counts.length === 0) return t('messageTurnView.toolCall');
    const separator = t('messageTurnView.toolSummary.separator');
    const formatClause = (
      category: ToolSummaryCategory,
      count: number,
      clauseIndex: number
    ) => {
      const text = t(`messageTurnView.toolSummary.${category}`, { count });
      return isEnglish && clauseIndex > 0 ? lowercaseLeadingAscii(text) : text;
    };
    if (counts.length <= 2) {
      return counts
        .map(({ category, count }, clauseIndex) =>
          formatClause(category, count, clauseIndex)
        )
        .join(separator);
    }
    const topTwo = counts
      .slice(0, 2)
      .map(({ category, count }, clauseIndex) =>
        formatClause(category, count, clauseIndex)
      )
      .join(separator);
    const remainingCount = counts
      .slice(2)
      .reduce((sum, item) => sum + item.count, 0);
    const otherClause = t('messageTurnView.toolSummary.otherActions', {
      count: remainingCount,
    });
    return `${topTwo}${t('messageTurnView.toolSummary.otherActionsJoin')}${otherClause}`;
  };

  const batchIconForEntries = (batch: ActivityEntry[]): TurnToolIconKind => {
    const icons = new Set<TurnToolIconKind>();
    for (const entry of batch) {
      if (entry.kind === 'tool') {
        icons.add(entry.call.icon);
      } else if (entry.kind === 'visible') {
        const category = entry.category ?? 'other';
        icons.add(categoryIconKind(category));
      }
    }
    if (icons.size === 1) {
      return [...icons][0]!;
    }
    return 'mixed';
  };

  const liveHeaderForBatch = (
    batch: ActivityEntry[]
  ): TurnToolBatchLiveHeader | null => {
    for (let idx = batch.length - 1; idx >= 0; idx -= 1) {
      const entry = batch[idx]!;
      if (entry.kind === 'tool') {
        return {
          icon: entry.call.icon,
          label: entry.call.label,
          targetText: entry.call.targetText,
          monoTarget: entry.call.monoChip,
          status: entry.call.status,
        };
      }
    }
    return null;
  };

  const activityEntries: ActivityEntry[] = [
    ...calls.map(
      (call): ActivityEntry => ({
        kind: 'tool',
        key: `tool-batch:${turnId}:${call.key}`,
        index: call.index,
        call,
        rawEntry: call.rawEntry,
      })
    ),
    ...goalEntries.map(({ entry, toolUseId, index }): ActivityEntry => {
      const entryKey = `tool-batch:${turnId}:${toolUseId || index}`;
      return {
        kind: 'visible',
        key: entryKey,
        index,
        content: (
          <GoalToolCall
            entry={entry}
            expansionKey={`goal-details:${turnId}:${toolUseId || index}`}
            sessionId={attempt.session?.id ?? null}
            onExpandedChange={(expanded) =>
              preserveStandaloneExpansion(entryKey, expanded)
            }
          />
        ),
      };
    }),
    ...askQuestionEntries.map(
      ({ use, result, toolUseId, index }): ActivityEntry => {
        const matched = matchTimelineQuestion(use, questions);
        return {
          kind: 'visible',
          key: `tool-batch:${turnId}:${toolUseId || index}`,
          index,
          alwaysVisible: true,
          content: (
            <AskQuestionToolCard
              use={use}
              result={result}
              request={matched?.request}
              response={matched?.response ?? null}
              expansionKey={`question-details:${turnId}:${toolUseId || index}`}
            />
          ),
        };
      }
    ),
    ...hostDelegationEntries.map(
      ({ use, result, toolUseId, index }): ActivityEntry => {
        const entryKey = `tool-batch:${turnId}:${toolUseId || index}`;
        return {
          kind: 'visible',
          key: entryKey,
          category: 'agents',
          index,
          content: (
            <HostDelegationToolCall
              use={use}
              result={result}
              event={matchHostDelegationView(use, delegations)}
              pollResults={pollResults}
              onOpenChild={onOpenChild}
              workspacePath={workspacePath ?? attempt.container_ref}
              expansionKey={`delegation-details:${turnId}:${toolUseId || index}`}
              onExpandedChange={(expanded) =>
                preserveStandaloneExpansion(entryKey, expanded)
              }
            />
          ),
        };
      }
    ),
    ...hostLifecycleEntries.map(
      ({ use, result, toolUseId, index }): ActivityEntry => ({
        kind: 'visible',
        key: `tool-batch:${turnId}:${toolUseId || index}`,
        index,
        content: <HostDelegationLifecycleRow use={use} result={result} />,
      })
    ),
    ...subagentEntries.map(
      ({
        use,
        result,
        lifecycle,
        children,
        toolUseId,
        index,
      }): ActivityEntry => {
        const match = entries.find(
          (entry) => entry.use.tool_use_id === use.tool_use_id
        );
        const entry = match?.entry;
        const toolEntry =
          entry?.entry_type.type === 'tool_use' ? entry.entry_type : null;
        const summary = toolEntry
          ? getToolSummary(toolEntry, entry?.content.trim() ?? '')
          : { label: t('genericTool.subagent'), detail: '' };
        const entryKey = `tool-batch:${turnId}:${toolUseId || index}`;
        return {
          kind: 'visible',
          key: entryKey,
          category: 'agents',
          index,
          content: (
            <SubagentToolCall
              expansionKey={`${turnId}-subagent-${toolUseId || index}`}
              label={summary.label}
              target={
                summary.detail && summary.detail !== summary.label
                  ? summary.detail
                  : undefined
              }
              use={use}
              result={result}
              lifecycle={lifecycle}
              childrenTools={children}
              parentAgentId={parentAgentId}
              workspacePath={workspacePath ?? attempt.container_ref}
              onExpandedChange={(expanded) =>
                preserveStandaloneExpansion(entryKey, expanded)
              }
            />
          ),
        };
      }
    ),
    ...regularEntries.flatMap(
      ({ entry, toolUseId, images, index }): ActivityEntry[] => {
        if (images.length === 0 || entry.entry_type.type !== 'tool_use')
          return [];
        const action = entry.entry_type.action_type;
        const key = `viewed-images:${turnId}:${toolUseId || index}`;
        return [
          {
            kind: 'visible',
            key,
            category: summaryCategory(action.action),
            index,
            content: (
              <ViewedImages
                expansionKey={`${key}:details`}
                onExpandedChange={(expanded) =>
                  preserveStandaloneExpansion(key, expanded)
                }
                images={images.map((image, imageIndex) => ({
                  key: `${key}:${imageIndex}`,
                  image,
                  path:
                    action.action === 'file_read'
                      ? action.path
                      : image.uri ||
                        t('viewedImages.image', { count: imageIndex + 1 }),
                }))}
              />
            ),
          },
        ];
      }
    ),
  ];

  for (const { item, index } of items) {
    if (item.kind !== 'thinking') {
      if (item.kind !== 'tool' || !item.use) {
        activityEntries.push({
          kind: 'visible',
          key: `activity:${turnId}:${index}`,
          index,
          category: 'otherActivities',
          content: renderOtherItem?.(item, index),
        });
      }
      continue;
    }
    const previous = activityEntries.at(-1);
    if (previous?.kind === 'thinking' && previous.endIndex === index - 1) {
      previous.texts.push(item.text);
      previous.endIndex = index;
    } else {
      activityEntries.push({
        kind: 'thinking',
        key: `thinking-batch:${turnId}:${index}`,
        index,
        endIndex: index,
        texts: [item.text],
      });
    }
  }
  activityEntries.sort((a, b) => a.index - b.index);

  if (!showCompleted) return null;

  const lastIndex = items.at(-1)?.index;
  const activityUnits: {
    kind: 'standalone' | 'batch';
    entries: ActivityEntry[];
  }[] = [];
  let batch: ActivityEntry[] = [];
  for (const entry of activityEntries) {
    const keepVisible =
      entry.kind === 'visible' && Boolean(entry.alwaysVisible);
    if (keepVisible) {
      if (batch.length > 0)
        activityUnits.push({ kind: 'batch', entries: batch });
      batch = [];
      activityUnits.push({ kind: 'standalone', entries: [entry] });
    } else {
      batch.push(entry);
    }
  }
  if (batch.length > 0) activityUnits.push({ kind: 'batch', entries: batch });

  standaloneKeysRef.current = new Set(
    activityUnits
      .filter((unit) => unit.kind === 'standalone' || unit.entries.length === 1)
      .map((unit) => unit.entries[0]!.key)
  );

  const openDiffChip = (diff: TurnToolDiffChip) => {
    panelActions?.openFilePreview(diff.resolvedPath, {
      mode: 'diff',
      diffViewMode: 'inline',
      displayPath: diff.displayPath,
      title: diff.displayPath,
    });
  };

  const renderActivity = (
    entry: ActivityEntry,
    inBatch: boolean
  ): ReactNode => {
    if (entry.kind === 'visible')
      return <div key={entry.key}>{entry.content}</div>;
    if (entry.kind === 'tool')
      return (
        <TurnToolChipRow
          key={entry.key}
          icon={entry.call.icon}
          label={entry.call.label}
          chip={entry.call.chip}
          monoChip={entry.call.monoChip}
          additions={entry.call.additions}
          deletions={entry.call.deletions}
          showInlineDiffCounts={!inBatch}
          status={entry.call.status}
          errorMessage={entry.call.errorMessage}
          detail={entry.call.resultDetail}
          expanded={entry.call.isDetailExpanded}
          onExpandedChange={entry.call.onDetailExpandedChange}
        />
      );
    return (
      <ThinkingEntry
        key={entry.key}
        content={entry.texts.join('\n\n')}
        count={entry.texts.length}
        expansionKey={`${turnId}-${entry.index}`}
        taskAttemptId={attempt.id}
        taskId={task?.id ?? attempt.task_id ?? undefined}
        workspacePath={workspacePath ?? attempt.container_ref}
        isStreaming={isStreaming && entry.endIndex === lastIndex}
        onExpandedChange={(expanded) =>
          preserveStandaloneExpansion(entry.key, expanded)
        }
      />
    );
  };

  if (activityUnits.length === 0) return null;

  const timestampLabel = formatBatchTimestamp(timestamp);

  return (
    <div className="conv-entry-item dimo-turn-tool-calls flex min-w-0 max-w-full flex-col gap-0.5">
      {activityUnits.map((unit) => {
        const anchorEntry = unit.entries[0]!;
        if (unit.kind === 'standalone' || unit.entries.length === 1) {
          return renderActivity(anchorEntry, false);
        }
        if (unit.entries.every((entry) => entry.kind === 'thinking')) {
          return unit.entries.map((entry) => renderActivity(entry, false));
        }
        const label = summarizeActivities(unit.entries);
        const batchDiffs = extractBatchDiffChips(
          unit.entries.flatMap((entry) =>
            entry.kind === 'tool' ? [entry.rawEntry] : []
          ),
          workspacePath ?? attempt.container_ref
        );
        const isActive =
          isStreaming &&
          unit.entries.some(
            (entry) =>
              (entry.kind === 'tool' &&
                (entry.call.status === 'running' ||
                  entry.call.status === 'pending')) ||
              (entry.kind === 'thinking' && entry.endIndex === lastIndex)
          );
        return (
          <TurnToolChipsBatch
            key={anchorEntry.key}
            expansionKey={`activity-batch:${turnId}:${anchorEntry.key}`}
            label={label}
            icon={batchIconForEntries(unit.entries)}
            liveHeader={liveHeaderForBatch(unit.entries)}
            itemCount={unit.entries.length}
            isStreaming={isStreaming}
            isActive={isActive}
            timestampLabel={timestampLabel}
            diffs={batchDiffs}
            onOpenDiff={openDiffChip}
          >
            {unit.entries.map((entry) => renderActivity(entry, true))}
          </TurnToolChipsBatch>
        );
      })}
    </div>
  );
}

export function doesToolUseMatchQuestionRequest(
  use: ToolUseBlock,
  request: ConversationQuestionRequest
): boolean {
  if (!isAskQuestionTool(use)) return false;
  if (use.tool_use_id && use.tool_use_id === request.question_id) return true;
  const requestTabs = questionTabsFromRequest(request);
  if (
    use.tool_use_id &&
    requestTabs.some((question) => question.id === use.tool_use_id)
  ) {
    return true;
  }
  const useTabs = questionTabsFromRequest(questionRequestFromToolUse(use));
  const isCustomQuestionId = (id: string) =>
    Boolean(id) && id !== 'answer' && !/^question-\d+$/.test(id);
  const useIds = new Set(
    useTabs.map((question) => question.id).filter(isCustomQuestionId)
  );
  if (
    useIds.size > 0 &&
    requestTabs.some(
      (question) =>
        useIds.has(question.id) ||
        (question.fieldName ? useIds.has(question.fieldName) : false)
    )
  ) {
    return true;
  }
  const title = firstQuestionTitle(useTabs);
  const firstHeader = useTabs[0]?.header?.trim() ?? '';
  if (!title && !firstHeader) return false;
  const prompt = request.prompt;
  const requestTexts = requestTabs.flatMap((question) => [
    question.question,
    question.header,
  ]);
  return Boolean(
    (title && (prompt.includes(title) || requestTexts.includes(title))) ||
      (firstHeader &&
        !isQuestionToolName(firstHeader) &&
        requestTexts.includes(firstHeader))
  );
}

export function collectAskQuestionToolUses(
  turns: readonly { turn: MessageTurn }[]
): ToolUseBlock[] {
  const askToolUses: ToolUseBlock[] = [];
  for (const { turn } of turns) {
    if (turn.role !== 'assistant') continue;
    for (const item of planTurnBlocks(turn.blocks)) {
      if (item.kind === 'tool' && item.use && isAskQuestionTool(item.use)) {
        askToolUses.push(item.use);
      }
    }
  }
  return askToolUses;
}

export function findMatchingAskQuestionToolInUses(
  request: ConversationQuestionRequest,
  askToolUses: readonly ToolUseBlock[]
): ToolUseBlock | null {
  if (askToolUses.length === 0) return null;
  for (let i = askToolUses.length - 1; i >= 0; i -= 1) {
    const use = askToolUses[i]!;
    if (doesToolUseMatchQuestionRequest(use, request)) return use;
  }
  for (let i = askToolUses.length - 1; i >= 0; i -= 1) {
    const use = askToolUses[i]!;
    if (
      !firstQuestionTitle(
        questionTabsFromRequest(questionRequestFromToolUse(use))
      )
    ) {
      return use;
    }
  }
  return null;
}

export function findMatchingAskQuestionTool(
  request: ConversationQuestionRequest,
  turns: readonly { turn: MessageTurn }[]
): ToolUseBlock | null {
  return findMatchingAskQuestionToolInUses(
    request,
    collectAskQuestionToolUses(turns)
  );
}

export function hasMatchingAskQuestionTool(
  request: ConversationQuestionRequest,
  turns: readonly { turn: MessageTurn }[]
): boolean {
  return findMatchingAskQuestionTool(request, turns) !== null;
}

function matchTimelineQuestion(
  use: ToolUseBlock,
  questions: TimelineQuestion[]
): TimelineQuestion | null {
  if (questions.length === 0) return null;
  const exact = questions.find((item) =>
    doesToolUseMatchQuestionRequest(use, item.request)
  );
  if (exact) return exact;
  const title = firstQuestionTitle(
    questionTabsFromRequest(questionRequestFromToolUse(use))
  );
  if (!title) return questions[0] ?? null;
  return null;
}
