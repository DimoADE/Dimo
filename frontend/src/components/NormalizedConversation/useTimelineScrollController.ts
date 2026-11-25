import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type RefObject,
  type UIEvent,
} from 'react';
import { elementScroll, useVirtualizer } from '@tanstack/react-virtual';
import type { ContextCompactPresentation } from '@/components/NormalizedConversation/MessageTurnView';
import { isGoalToolUse } from '@/components/NormalizedConversation/tools/GoalToolCall';
import type {
  ConversationTimelineItem,
  ConversationTimelineTurn,
} from '@/features/conversation/conversationStore';
import { computeAnchoredTimelineStartIndex } from '@/features/conversation/timelinePaging';
import { findInConversationTimeline } from '@/lib/conversationFind';
import {
  CONVERSATION_SCROLL_TO_GOAL_EVENT,
  CONVERSATION_SCROLL_TO_QUOTE_EVENT,
  CONVERSATION_SCROLL_TO_TURN_EVENT,
  consumePendingConversationJump,
  pulseQuoteTargetElement,
  type ConversationScrollToGoalDetail,
  type ConversationScrollToQuoteDetail,
  type ConversationScrollToTurnDetail,
} from '@/lib/conversationScroll';
import { bindConversationSummaryMarquee } from '@/components/logs/conversationSummaryMarquee';
import {
  buildTimelineVirtualEntries,
  type TimelineVirtualEntry,
} from '@/components/logs/assistantVirtualSlices';

function estimateVirtualEntrySize(
  entry: TimelineVirtualEntry | undefined,
  visibleTimelineItems: readonly ConversationTimelineItem[]
): number {
  if (!entry) return ESTIMATED_CONVERSATION_ROW_HEIGHT;
  if (entry.slice) {
    if (entry.slice.kind === 'process-fold' || entry.slice.kind === 'status') {
      return 36;
    }
    if (entry.slice.kind === 'block') {
      if (entry.key.includes(':md:')) {
        return entry.slice.inExpandedFold ? 84 : 128;
      }
      return entry.slice.inExpandedFold ? 36 : 48;
    }
  }
  const item = visibleTimelineItems[entry.timelineIndex];
  if (!item) return ESTIMATED_CONVERSATION_ROW_HEIGHT;
  if (item.kind === 'side') return 64;
  return item.item.turn.role === 'user'
    ? 72
    : ESTIMATED_CONVERSATION_ROW_HEIGHT;
}
import {
  CONVERSATION_OPEN_SETTLE_PASSES,
  CONVERSATION_TAIL_RESCUE_PASSES,
  ESTIMATED_CONVERSATION_ROW_HEIGHT,
  USER_MESSAGE_SCROLL_INSET_PX,
  cancelVirtualizerFollowScroll,
  captureTimelineReadingAnchor,
  conversationFollowIntent,
  conversationTailFollowAction,
  conversationTailNeedsRescue,
  findPreviousUserMessageVirtualIndex,
  findViewportAnchorVirtualIndex,
  getVirtualWindowTranslateY,
  isConversationNearBottom,
  isVirtualizerJumpActive,
  measureScrollMargin,
  measureUnscaledBlockHeight,
  remeasureMountedVirtualRows,
  resolveAnchoredPrependScrollTop,
  observeUnscaledElementRect,
  scheduleMeasuredScrollToIndex,
  scrollTopAfterPrepend,
  scrollTopToRevealVirtualWindow,
  virtualListHeightPx,
  type TimelineReadingAnchor,
  type VirtualizedListRef,
} from '@/components/logs/VirtualizedList';
import {
  getExpandableRevision,
  isExpandableOpen,
  useProcessExpandableRevision,
} from '@/stores/useExpandableStore';
import {
  findActiveConversationMessageNavEntry,
  type ConversationMessageNavEntry,
} from './thread/messageNavEntries';
import {
  shouldLoadOlderTimelinePage,
  timelineItemAsMessage,
  turnCopyText,
  dimoTurnIdFromTimelineRowId,
} from './timelineMemoHelpers';

const OVERSCAN = 10;
const ANCHOR_RESTORE_MAX_FRAMES = 45;
const ANCHOR_RESTORE_STABLE_FRAMES = 3;

export function useTimelineScrollController({
  ref,
  panelRef,
  sessionId,
  timeline,
  timelineItems,
  navEntries,
  sideRowsLength,
  hasEarlier,
  loadOlder,
  olderTurnsPrependEpoch,
  collapseProcess,
  hideThinking,
  contextCompactByRowKey,
  scrollBehavior,
  onAtBottomChange,
  surfaceActive = true,
  isLoadingSkeleton = false,
}: {
  ref: ForwardedRef<VirtualizedListRef>;
  panelRef: RefObject<HTMLDivElement | null>;
  sessionId: string | null;
  timeline: ConversationTimelineTurn[];
  timelineItems: ConversationTimelineItem[];
  navEntries: ConversationMessageNavEntry[];
  sideRowsLength: number;
  hasEarlier: boolean;
  loadOlder: () => Promise<void>;
  olderTurnsPrependEpoch: number;
  collapseProcess: boolean;
  hideThinking: boolean;
  contextCompactByRowKey: Map<string, ContextCompactPresentation | null>;
  scrollBehavior: ScrollBehavior;
  onAtBottomChange?: (isAtBottom: boolean) => void;
  surfaceActive?: boolean;
  isLoadingSkeleton?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const virtualListRef = useRef<HTMLDivElement | null>(null);
  const virtualWindowRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const isAtBottomRef = useRef(true);
  const openSettlePassesRef = useRef(CONVERSATION_OPEN_SETTLE_PASSES);
  const [, setIsFollowingTail] = useState(true);
  const followTailRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const surfaceActiveRef = useRef(surfaceActive);
  const previousSurfaceActiveRef = useRef(surfaceActive);
  const observedViewportHeightRef = useRef(0);
  const hiddenScrollSnapshotRef = useRef<{
    sessionId: string | null;
    followTail: boolean;
    scrollTop: number;
  } | null>(null);
  const tailRescuePassesRef = useRef(0);
  const tailRescueBudgetRef = useRef(0);
  const tailRescueItemCountRef = useRef(0);
  const tailRescueWindowHeightRef = useRef(0);
  const revealScrollRef = useRef<number | null>(null);
  const revealRestoreRafRef = useRef<number | null>(null);
  const pinToBottomRafRef = useRef<number | null>(null);
  const programmaticScrollDepthRef = useRef(0);
  const smoothFollowRef = useRef(false);
  const seenExpansionRef = useRef<number | null>(null);
  const expansionInViewRef = useRef(false);

  const sessionPinRef = useRef<string | null>(null);
  const pinnedSessionReadyRef = useRef<string | null>(null);
  const anchoredTimelineStartRef = useRef<{
    sessionId: string | null;
    index: number | null;
  }>({ sessionId: null, index: null });
  const previousPrependEpochRef = useRef(0);
  const readingAnchorRef = useRef<TimelineReadingAnchor | null>(null);
  const previousTotalSizeRef = useRef(0);
  const cancelAnchorRestoreRef = useRef<(() => void) | null>(null);
  const pendingJumpTimelineIndexRef = useRef<{
    index: number;
    align: 'start' | 'center' | 'end' | 'auto';
  } | null>(null);
  const cancelJumpRef = useRef<(() => void) | null>(null);
  const skipNextPrependAdjustRef = useRef(false);
  const [visibleTailSession, setVisibleTailSession] = useState<{
    sessionId: string | null;
    count: number;
    revealEpoch: number;
  }>(() => ({
    sessionId,
    count: 24,
    revealEpoch: 0,
  }));

  const effectiveVisibleTailCount =
    visibleTailSession.sessionId === sessionId ? visibleTailSession.count : 24;
  const effectiveRevealEpoch =
    visibleTailSession.sessionId === sessionId
      ? visibleTailSession.revealEpoch
      : 0;
  const effectiveFollowTail =
    anchoredTimelineStartRef.current.sessionId !== sessionId
      ? true
      : followTailRef.current;
  const priorAnchoredStartIndex =
    anchoredTimelineStartRef.current.sessionId === sessionId
      ? anchoredTimelineStartRef.current.index
      : null;
  const inFlightTimelineIndex = useMemo(() => {
    for (let index = timelineItems.length - 1; index >= 0; index -= 1) {
      const item = timelineItems[index];
      if (item?.kind !== 'message') continue;
      if (item.item.phase === 'streaming' || item.item.phase === 'optimistic') {
        return index;
      }
    }
    return null;
  }, [timelineItems]);
  const visibleTimelineStartIndex = computeAnchoredTimelineStartIndex({
    totalItems: timelineItems.length,
    visibleTailCount: effectiveVisibleTailCount,
    followTail: effectiveFollowTail,
    anchoredStartIndex: priorAnchoredStartIndex,
    requiredIndex: effectiveFollowTail ? inFlightTimelineIndex : null,
  });
  anchoredTimelineStartRef.current = {
    sessionId,
    index: visibleTimelineStartIndex,
  };
  const hasHiddenEarlierItems = visibleTimelineStartIndex > 0;
  const visibleTimelineItems = useMemo(
    () =>
      visibleTimelineStartIndex > 0
        ? timelineItems.slice(visibleTimelineStartIndex)
        : timelineItems,
    [timelineItems, visibleTimelineStartIndex]
  );

  // Only `process:*` fold keys alter virtual row slicing; non-process card
  // expansions are measured by TanStack Virtual and checked via getExpandableRevision().
  const processExpandableRevision = useProcessExpandableRevision();
  const virtualEntries = useMemo(() => {
    void processExpandableRevision;
    return buildTimelineVirtualEntries({
      items: visibleTimelineItems,
      collapseProcess,
      hideThinking,
      processExpanded: (turnId, foldStartIndex) =>
        isExpandableOpen(`process:${turnId}:${foldStartIndex}`),
      isContextCompact: (rowKey) => contextCompactByRowKey.has(rowKey),
    });
  }, [
    collapseProcess,
    contextCompactByRowKey,
    hideThinking,
    processExpandableRevision,
    visibleTimelineItems,
  ]);

  const userMessageIndexes = useMemo(
    () =>
      virtualEntries.flatMap((entry, index) => {
        const item = visibleTimelineItems[entry.timelineIndex];
        return timelineItemAsMessage(item)?.turn.role === 'user' ? [index] : [];
      }),
    [visibleTimelineItems, virtualEntries]
  );
  const activeNavEntry = useMemo(
    () => findActiveConversationMessageNavEntry(navEntries, activeIndex),
    [activeIndex, navEntries]
  );

  const runProgrammaticScroll = useCallback((action: () => void) => {
    programmaticScrollDepthRef.current += 1;
    try {
      action();
    } finally {
      const release = () => {
        programmaticScrollDepthRef.current = Math.max(
          0,
          programmaticScrollDepthRef.current - 1
        );
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          queueMicrotask(release);
        });
      } else {
        queueMicrotask(release);
      }
    }
  }, []);

  const [paintedWindowHeight, setPaintedWindowHeight] = useState(0);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtualEntries.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) =>
      estimateVirtualEntrySize(virtualEntries[index], visibleTimelineItems),
    getItemKey: (index) => virtualEntries[index]?.key ?? index,
    overscan: OVERSCAN,
    scrollMargin,
    scrollPaddingStart: USER_MESSAGE_SCROLL_INSET_PX,
    observeElementRect: observeUnscaledElementRect,
    measureElement: measureUnscaledBlockHeight,
    scrollToFn: (offset, options, instance) => {
      runProgrammaticScroll(() => {
        elementScroll(offset, options, instance);
      });
      const container = containerRef.current;
      if (container) {
        lastScrollTopRef.current = container.scrollTop;
        lastScrollHeightRef.current = container.scrollHeight;
      }
    },
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const listHeight = virtualListHeightPx({
    totalSize,
    windowStart: virtualRows[0]?.start,
    scrollMargin,
    windowHeight: paintedWindowHeight,
  });

  const cancelAnchorRestore = useCallback(() => {
    cancelAnchorRestoreRef.current?.();
    cancelAnchorRestoreRef.current = null;
  }, []);

  const cancelPinToBottomRaf = useCallback(() => {
    if (
      pinToBottomRafRef.current !== null &&
      typeof cancelAnimationFrame === 'function'
    ) {
      cancelAnimationFrame(pinToBottomRafRef.current);
      pinToBottomRafRef.current = null;
    }
  }, []);

  const cancelRevealRestoreRaf = useCallback(() => {
    if (
      revealRestoreRafRef.current !== null &&
      typeof cancelAnimationFrame === 'function'
    ) {
      cancelAnimationFrame(revealRestoreRafRef.current);
      revealRestoreRafRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
      item,
      _delta,
      instance
    ) => {
      if (followTailRef.current) return false;
      return item.start < (instance.scrollOffset ?? 0);
    };
  }, [rowVirtualizer]);

  useLayoutEffect(
    () => () => {
      cancelAnchorRestore();
      cancelPinToBottomRaf();
      cancelRevealRestoreRaf();
    },
    [cancelAnchorRestore, cancelPinToBottomRaf, cancelRevealRestoreRaf, sessionId]
  );

  const cancelPendingJump = useCallback(() => {
    cancelAnchorRestore();
    cancelRevealRestoreRaf();
    cancelJumpRef.current?.();
    cancelJumpRef.current = null;
    pendingJumpTimelineIndexRef.current = null;
    cancelVirtualizerFollowScroll(rowVirtualizer);
  }, [cancelAnchorRestore, cancelRevealRestoreRaf, rowVirtualizer]);

  useEffect(() => () => cancelPendingJump(), [cancelPendingJump]);

  const jumpToVirtualIndex = useCallback(
    (index: number, align: 'start' | 'center' | 'end' | 'auto' = 'start') => {
      if (index < 0 || index >= virtualEntries.length) return;
      cancelAnchorRestore();
      readingAnchorRef.current = null;
      cancelJumpRef.current?.();
      cancelJumpRef.current = null;
      let pass = 0;
      const jump = (targetIndex: number) => {
        const currentPass = pass;
        pass += 1;
        if (currentPass > 0) {
          const list = virtualListRef.current;
          if (list) {
            remeasureMountedVirtualRows(list, rowVirtualizer.resizeItem);
          }
        }
        // Flush pendingMeasuredCacheIndexes into measurementsCache before
        // scrollToIndex reads the target offset; staying on scrollToIndex keeps
        // scrollState.index set so TanStack reconcileScroll converges as newly
        // mounted rows settle.
        rowVirtualizer.getTotalSize();
        rowVirtualizer.scrollToIndex(targetIndex, {
          align,
          behavior: 'auto',
        });
      };
      cancelJumpRef.current = scheduleMeasuredScrollToIndex(jump, index);
    },
    [cancelAnchorRestore, rowVirtualizer, virtualEntries.length]
  );

  const hasEarlierTimeline = hasHiddenEarlierItems || hasEarlier;
  const captureReadingAnchor = useCallback(() => {
    const container = containerRef.current;
    const list = virtualListRef.current;
    if (!container || !list) return;
    readingAnchorRef.current = captureTimelineReadingAnchor({
      items: rowVirtualizer.getVirtualItems(),
      scrollTop: container.scrollTop,
      scrollMarginDelta:
        measureScrollMargin(list, container) -
        rowVirtualizer.options.scrollMargin,
    });
  }, [rowVirtualizer]);

  const loadEarlierTimeline = useCallback(() => {
    cancelAnchorRestore();
    captureReadingAnchor();
    if (hasHiddenEarlierItems) {
      setVisibleTailSession((current) => {
        const baseCount = current.sessionId === sessionId ? current.count : 24;
        const currentlyVisibleCount = Math.max(
          baseCount,
          timelineItems.length - visibleTimelineStartIndex
        );
        const baseEpoch =
          current.sessionId === sessionId ? current.revealEpoch : 0;
        return {
          sessionId,
          count: Math.min(timelineItems.length, currentlyVisibleCount + 24),
          revealEpoch: baseEpoch + 1,
        };
      });
      return;
    }
    setVisibleTailSession((current) => {
      const baseEpoch =
        current.sessionId === sessionId ? current.revealEpoch : 0;
      return {
        sessionId,
        count: timelineItems.length + 24,
        revealEpoch: baseEpoch,
      };
    });
    void loadOlder();
  }, [
    cancelAnchorRestore,
    captureReadingAnchor,
    hasHiddenEarlierItems,
    loadOlder,
    sessionId,
    timelineItems.length,
    visibleTimelineStartIndex,
  ]);

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatchIndex, setFindMatchIndex] = useState(0);
  const findMatches = useMemo(
    () => (findOpen ? findInConversationTimeline(timeline, findQuery) : []),
    [findOpen, findQuery, timeline]
  );
  const safeFindMatchIndex =
    findMatches.length > 0
      ? Math.min(findMatchIndex, findMatches.length - 1)
      : 0;
  const currentFindMatch = findMatches[safeFindMatchIndex] ?? null;

  const detachFromBottom = useCallback(() => {
    cancelPendingJump();
    cancelPinToBottomRaf();
    const container = containerRef.current;
    if (container && smoothFollowRef.current) {
      smoothFollowRef.current = false;
      runProgrammaticScroll(() => {
        container.scrollTo({ top: container.scrollTop, behavior: 'auto' });
      });
    }
    followTailRef.current = false;
    setIsFollowingTail(false);
    openSettlePassesRef.current = 0;
    if (!isAtBottomRef.current) return;
    isAtBottomRef.current = false;
    onAtBottomChange?.(false);
  }, [
    cancelPendingJump,
    cancelPinToBottomRaf,
    onAtBottomChange,
    runProgrammaticScroll,
  ]);

  const handleJumpToVirtualIndex = useCallback(
    (targetIndex: number) => {
      detachFromBottom();
      jumpToVirtualIndex(targetIndex, 'center');
    },
    [detachFromBottom, jumpToVirtualIndex]
  );

  const scrollToTimelineIndexWithAlign = useCallback(
    (
      index: number,
      align: 'start' | 'center' | 'end' | 'auto' = 'start',
      shouldDetach = true
    ) => {
      if (index < 0 || index >= timelineItems.length) return;
      if (shouldDetach) {
        detachFromBottom();
      }
      if (index < visibleTimelineStartIndex) {
        cancelAnchorRestore();
        readingAnchorRef.current = null;
        pendingJumpTimelineIndexRef.current = { index, align };
        skipNextPrependAdjustRef.current = true;
        setVisibleTailSession((current) => {
          const baseEpoch =
            current.sessionId === sessionId ? current.revealEpoch : 0;
          return {
            sessionId,
            count: Math.min(
              timelineItems.length,
              timelineItems.length - index + 24
            ),
            revealEpoch: baseEpoch + 1,
          };
        });
        return;
      }
      const localIndex = index - visibleTimelineStartIndex;
      const virtualIndex = virtualEntries.findIndex(
        (entry) => entry.timelineIndex === localIndex
      );
      if (virtualIndex < 0) return;
      jumpToVirtualIndex(virtualIndex, align);
    },
    [
      cancelAnchorRestore,
      detachFromBottom,
      jumpToVirtualIndex,
      sessionId,
      timelineItems.length,
      virtualEntries,
      visibleTimelineStartIndex,
    ]
  );

  const scrollToFindMatch = useCallback(
    (matchIndex: number) => {
      const match = findMatches[matchIndex];
      if (!match) return;
      const key = timeline[match.rowIndex]?.key;
      if (!key) return;
      const targetTimelineIndex = timelineItems.findIndex(
        (item) => item.kind === 'message' && item.item.key === key
      );
      if (targetTimelineIndex < 0) return;
      scrollToTimelineIndexWithAlign(targetTimelineIndex, 'center', true);
    },
    [findMatches, scrollToTimelineIndexWithAlign, timeline, timelineItems]
  );

  const goToFindMatch = useCallback(
    (direction: 1 | -1) => {
      if (findMatches.length === 0) return;
      setFindMatchIndex((current) => {
        const clamped = Math.min(current, findMatches.length - 1);
        const next =
          (clamped + direction + findMatches.length) % findMatches.length;
        queueMicrotask(() => scrollToFindMatch(next));
        return next;
      });
    },
    [findMatches.length, scrollToFindMatch]
  );

  useEffect(() => {
    setFindMatchIndex(0);
  }, [findQuery]);

  useEffect(() => {
    cancelPendingJump();
    hiddenScrollSnapshotRef.current = null;
    setFindOpen(false);
    setFindQuery('');
    setFindMatchIndex(0);
    followTailRef.current = true;
    setIsFollowingTail(true);
    skipNextPrependAdjustRef.current = false;
  }, [cancelPendingJump, sessionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isFind =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f';
      if (!isFind) return;
      const panel = panelRef.current;
      if (!panel?.contains(document.activeElement)) return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [panelRef]);

  const updateAtBottomState = useCallback(
    (trustedUserScroll: boolean) => {
      if (!followTailRef.current || !trustedUserScroll) return;
      if (openSettlePassesRef.current > 0) return;
      const container = containerRef.current;
      if (!container) return;
      const next = isConversationNearBottom(container);
      if (isAtBottomRef.current === next) return;
      isAtBottomRef.current = next;
      onAtBottomChange?.(next);
    },
    [onAtBottomChange]
  );

  const updateActiveIndex = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const anchor = findViewportAnchorVirtualIndex(
      rowVirtualizer.getVirtualItems(),
      container.scrollTop,
      container.clientHeight
    );
    const localTimelineIndex =
      anchor == null ? null : (virtualEntries[anchor]?.timelineIndex ?? null);
    const next =
      localTimelineIndex == null
        ? null
        : localTimelineIndex + visibleTimelineStartIndex;
    setActiveIndex((current) => (current === next ? current : next));
  }, [rowVirtualizer, virtualEntries, visibleTimelineStartIndex]);

  const pinToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      const container = containerRef.current;
      if (!container) return;
      smoothFollowRef.current = behavior === 'smooth';
      cancelVirtualizerFollowScroll(rowVirtualizer);
      cancelPinToBottomRaf();
      runProgrammaticScroll(() => {
        if (behavior === 'smooth') {
          container.scrollTo({ top: container.scrollHeight, behavior });
        } else {
          container.scrollTop = container.scrollHeight;
        }
      });
      lastScrollTopRef.current = container.scrollTop;
      lastScrollHeightRef.current = container.scrollHeight;
      if (
        behavior !== 'smooth' &&
        typeof requestAnimationFrame === 'function'
      ) {
        pinToBottomRafRef.current = requestAnimationFrame(() => {
          pinToBottomRafRef.current = null;
          const currentContainer = containerRef.current;
          if (!currentContainer || !followTailRef.current) return;
          runProgrammaticScroll(() => {
            currentContainer.scrollTop = currentContainer.scrollHeight;
          });
          lastScrollTopRef.current = currentContainer.scrollTop;
          lastScrollHeightRef.current = currentContainer.scrollHeight;
        });
      }
    },
    [cancelPinToBottomRaf, rowVirtualizer, runProgrammaticScroll]
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      cancelPendingJump();
      followTailRef.current = true;
      setIsFollowingTail(true);
      openSettlePassesRef.current = 0;
      isAtBottomRef.current = true;
      onAtBottomChange?.(true);
      pinToBottom(behavior);
    },
    [cancelPendingJump, onAtBottomChange, pinToBottom]
  );

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      if (!surfaceActiveRef.current || !container.isConnected) return;
      const previous = lastScrollTopRef.current;
      const scrollTop = container.scrollTop;
      const previousHeight = lastScrollHeightRef.current;
      const scrollHeight = container.scrollHeight;
      lastScrollTopRef.current = scrollTop;
      lastScrollHeightRef.current = scrollHeight;
      const trustedUserScroll =
        event.nativeEvent.isTrusted && programmaticScrollDepthRef.current === 0;
      if (trustedUserScroll) {
        cancelRevealRestoreRaf();
      }
      if (readingAnchorRef.current && trustedUserScroll) {
        captureReadingAnchor();
      }
      const intent = conversationFollowIntent({
        trustedUserScroll,
        previousScrollTop: previous,
        scrollTop,
        nearBottom: isConversationNearBottom(container),
        attached: followTailRef.current,
        viewportHeight: container.clientHeight,
        previousScrollHeight: previousHeight,
        scrollHeight,
      });
      if (intent === 'detach') {
        detachFromBottom();
      } else if (intent === 'attach') {
        cancelAnchorRestore();
        readingAnchorRef.current = null;
        followTailRef.current = true;
        setIsFollowingTail(true);
        isAtBottomRef.current = true;
        onAtBottomChange?.(true);
      }
      if (
        trustedUserScroll &&
        shouldLoadOlderTimelinePage({
          hasEarlier: hasEarlierTimeline,
          isAtBottom: isAtBottomRef.current,
          scrollTop,
          previousScrollTop: previous,
        })
      ) {
        loadEarlierTimeline();
      }
      updateAtBottomState(trustedUserScroll);
      updateActiveIndex();
    },
    [
      cancelAnchorRestore,
      cancelRevealRestoreRaf,
      captureReadingAnchor,
      detachFromBottom,
      hasEarlierTimeline,
      loadEarlierTimeline,
      onAtBottomChange,
      updateActiveIndex,
      updateAtBottomState,
    ]
  );

  const scrollToIndex = useCallback(
    (index: number) => {
      scrollToTimelineIndexWithAlign(index, 'start', true);
      setActiveIndex(index);
    },
    [scrollToTimelineIndexWithAlign]
  );

  useEffect(() => {
    const onJump = (event: Event) => {
      const detail = (event as CustomEvent<ConversationScrollToTurnDetail>)
        .detail;
      if (!detail || detail.conversationId !== sessionId) return;
      const index = timelineItems.findIndex((item) => {
        if (item.kind !== 'message' || item.item.turn.role !== 'user') {
          return false;
        }
        const turnId = item.item.turn.id;
        return (
          turnId === detail.turnId ||
          dimoTurnIdFromTimelineRowId(turnId) === detail.turnId
        );
      });
      if (index < 0) return;
      scrollToIndex(index);
    };
    window.addEventListener(CONVERSATION_SCROLL_TO_TURN_EVENT, onJump);
    return () => {
      window.removeEventListener(CONVERSATION_SCROLL_TO_TURN_EVENT, onJump);
    };
  }, [scrollToIndex, sessionId, timelineItems]);

  useEffect(() => {
    const onJumpToGoal = (event: Event) => {
      const detail = (event as CustomEvent<ConversationScrollToGoalDetail>)
        .detail;
      if (!detail || detail.conversationId !== sessionId) return;
      for (let i = timelineItems.length - 1; i >= 0; i -= 1) {
        const item = timelineItems[i];
        if (item?.kind !== 'message') continue;
        const hasGoalTool = item.item.turn.blocks.some(
          (block) => block.type === 'tool_use' && isGoalToolUse(block)
        );
        if (hasGoalTool) {
          scrollToIndex(i);
          return;
        }
      }
    };
    window.addEventListener(CONVERSATION_SCROLL_TO_GOAL_EVENT, onJumpToGoal);
    return () => {
      window.removeEventListener(
        CONVERSATION_SCROLL_TO_GOAL_EVENT,
        onJumpToGoal
      );
    };
  }, [scrollToIndex, sessionId, timelineItems]);

  useEffect(() => {
    const pulseTimers: number[] = [];
    const applyJumpDetail = (detail: ConversationScrollToQuoteDetail) => {
      if (
        detail.conversationId &&
        sessionId &&
        detail.conversationId !== sessionId
      ) {
        return;
      }
      const needle = detail.snippet?.trim();
      let index = -1;
      if (detail.messageId) {
        const targetTurnPrefix = dimoTurnIdFromTimelineRowId(detail.messageId);
        index = timelineItems.findIndex(
          (item) =>
            (item.kind === 'message' &&
              (item.item.turn.id === detail.messageId ||
                item.item.key === detail.messageId ||
                (Boolean(targetTurnPrefix) &&
                  dimoTurnIdFromTimelineRowId(item.item.turn.id) ===
                    targetTurnPrefix))) ||
            (item.kind === 'side' && item.row.row_id === detail.messageId)
        );
      }
      if (index < 0 && detail.turnId) {
        index = timelineItems.findIndex(
          (item) =>
            item.kind === 'message' &&
            (item.item.turn.id === detail.turnId ||
              dimoTurnIdFromTimelineRowId(item.item.turn.id) === detail.turnId)
        );
      }
      if (index < 0 && detail.turnOrdinal != null) {
        let userOrdinal = 0;
        index = timelineItems.findIndex((item) => {
          if (item.kind !== 'message') return false;
          if (item.item.turn.role === 'user') {
            userOrdinal += 1;
          }
          return userOrdinal === detail.turnOrdinal;
        });
      }
      if (index < 0 && needle) {
        index = timelineItems.findIndex(
          (item) =>
            item.kind === 'message' &&
            turnCopyText(item.item.turn).includes(needle)
        );
      }
      if (index >= 0) {
        scrollToTimelineIndexWithAlign(index, 'center', true);
      }
      const runPulse = () => {
        if (containerRef.current) {
          pulseQuoteTargetElement(containerRef.current, detail);
        }
      };
      runPulse();
      pulseTimers.push(window.setTimeout(runPulse, 140));
    };

    if (timelineItems.length > 0) {
      const pending = consumePendingConversationJump(sessionId);
      if (pending) {
        applyJumpDetail(pending);
      }
    }

    const onJumpToQuote = (event: Event) => {
      const detail = (event as CustomEvent<ConversationScrollToQuoteDetail>)
        .detail;
      if (!detail) return;
      applyJumpDetail(detail);
    };
    window.addEventListener(CONVERSATION_SCROLL_TO_QUOTE_EVENT, onJumpToQuote);
    return () => {
      pulseTimers.forEach((timerId) => window.clearTimeout(timerId));
      window.removeEventListener(
        CONVERSATION_SCROLL_TO_QUOTE_EVENT,
        onJumpToQuote
      );
    };
  }, [scrollToTimelineIndexWithAlign, sessionId, timelineItems]);

  const updateScrollMargin = useCallback(() => {
    const container = containerRef.current;
    const list = virtualListRef.current;
    if (!container || !list) return;
    const next = measureScrollMargin(list, container);
    setScrollMargin((current) =>
      Math.abs(current - next) > 1 ? next : current
    );
  }, []);

  const virtualEntriesLengthRef = useRef(virtualEntries.length);
  virtualEntriesLengthRef.current = virtualEntries.length;

  const captureHiddenScrollSnapshot = useCallback(() => {
    if (hiddenScrollSnapshotRef.current?.sessionId === sessionId) return;
    const container = containerRef.current;
    const liveScrollTop =
      container && container.isConnected && container.clientHeight > 0
        ? container.scrollTop
        : 0;
    const scrollTop =
      liveScrollTop > 1 ? liveScrollTop : lastScrollTopRef.current;
    hiddenScrollSnapshotRef.current = {
      sessionId,
      followTail: followTailRef.current,
      scrollTop,
    };
  }, [sessionId]);

  const restoreScrollPositionAfterReveal = useCallback((): boolean => {
    const container = containerRef.current;
    const list = virtualListRef.current;
    if (!container || container.clientHeight <= 0) return false;

    const snapshot =
      hiddenScrollSnapshotRef.current?.sessionId === sessionId
        ? hiddenScrollSnapshotRef.current
        : null;
    const shouldFollowTail = snapshot
      ? snapshot.followTail
      : followTailRef.current;
    const savedScrollTop = snapshot
      ? snapshot.scrollTop
      : lastScrollTopRef.current;
    hiddenScrollSnapshotRef.current = null;
    revealScrollRef.current = null;
    updateScrollMargin();

    if (shouldFollowTail) {
      followTailRef.current = true;
      setIsFollowingTail(true);
      isAtBottomRef.current = true;
      onAtBottomChange?.(true);
      if (virtualEntriesLengthRef.current > 0) {
        pinnedSessionReadyRef.current = sessionId;
      }
      tailRescuePassesRef.current = 0;
      tailRescueBudgetRef.current = 0;
      if (list) {
        remeasureMountedVirtualRows(list, rowVirtualizer.resizeItem);
      }
      pinToBottom('auto');
      if (typeof requestAnimationFrame === 'function') {
        cancelRevealRestoreRaf();
        revealRestoreRafRef.current = requestAnimationFrame(() => {
          revealRestoreRafRef.current = null;
          const current = containerRef.current;
          const currentList = virtualListRef.current;
          if (
            !current ||
            !currentList ||
            !surfaceActiveRef.current ||
            current.clientHeight <= 0 ||
            !followTailRef.current
          ) {
            return;
          }
          remeasureMountedVirtualRows(currentList, rowVirtualizer.resizeItem);
          pinToBottom('auto');
        });
      }
      return true;
    }

    // Chromium resets scrollTop to 0 when a kept-alive panel is detached from
    // the document (`removeChild` in Dockview `onlyWhenVisible`) or hidden via
    // `display: none`. Restore the reader's saved offset when revealed again.
    if (
      savedScrollTop > 1 &&
      Math.abs(container.scrollTop - savedScrollTop) > 1
    ) {
      const applySavedTop = (targetContainer: HTMLDivElement) => {
        const maxScroll = Math.max(
          0,
          targetContainer.scrollHeight - targetContainer.clientHeight
        );
        const targetTop = Math.min(savedScrollTop, maxScroll);
        if (Math.abs(targetContainer.scrollTop - targetTop) > 1) {
          runProgrammaticScroll(() => {
            targetContainer.scrollTop = targetTop;
          });
        }
        lastScrollTopRef.current = targetContainer.scrollTop;
        lastScrollHeightRef.current = targetContainer.scrollHeight;
      };
      if (list) {
        remeasureMountedVirtualRows(list, rowVirtualizer.resizeItem);
      }
      applySavedTop(container);
      if (typeof requestAnimationFrame === 'function') {
        cancelRevealRestoreRaf();
        revealRestoreRafRef.current = requestAnimationFrame(() => {
          revealRestoreRafRef.current = null;
          const current = containerRef.current;
          if (
            !current ||
            !surfaceActiveRef.current ||
            current.clientHeight <= 0 ||
            followTailRef.current
          ) {
            return;
          }
          applySavedTop(current);
        });
      }
    }
    return true;
  }, [
    cancelRevealRestoreRaf,
    onAtBottomChange,
    pinToBottom,
    rowVirtualizer,
    runProgrammaticScroll,
    sessionId,
    updateScrollMargin,
  ]);

  useLayoutEffect(() => {
    surfaceActiveRef.current = surfaceActive;
    const wasActive = previousSurfaceActiveRef.current;
    previousSurfaceActiveRef.current = surfaceActive;
    if (wasActive && !surfaceActive) {
      captureHiddenScrollSnapshot();
      cancelPinToBottomRaf();
      cancelRevealRestoreRaf();
      observedViewportHeightRef.current = 0;
      return;
    }
    if (!wasActive && surfaceActive) {
      const restored = restoreScrollPositionAfterReveal();
      if (restored && containerRef.current) {
        observedViewportHeightRef.current = containerRef.current.clientHeight;
      }
    }
  }, [
    cancelPinToBottomRaf,
    cancelRevealRestoreRaf,
    captureHiddenScrollSnapshot,
    restoreScrollPositionAfterReveal,
    surfaceActive,
  ]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const list = virtualListRef.current;
    const win = virtualWindowRef.current;
    if (!container || !list) return;
    updateScrollMargin();
    observedViewportHeightRef.current = container.clientHeight;
    let viewportWidth = container.clientWidth;

    const syncVirtualWindowGeometryBeforePaint = (
      widthChanged: boolean
    ): void => {
      remeasureMountedVirtualRows(list, rowVirtualizer.resizeItem);
      const liveTotalSize = rowVirtualizer.getTotalSize();
      const liveScrollMargin = measureScrollMargin(list, container);
      const liveWindowHeight = win ? win.offsetHeight : 0;
      if (win) {
        setPaintedWindowHeight((current) =>
          Math.abs(current - liveWindowHeight) > 1 ? liveWindowHeight : current
        );
      }

      const rawFirstIndex = win?.firstElementChild?.getAttribute('data-index');
      const firstMountedIndex =
        rawFirstIndex != null && rawFirstIndex !== ''
          ? Number(rawFirstIndex)
          : NaN;
      const mountedWindowStart = Number.isFinite(firstMountedIndex)
        ? (rowVirtualizer.measurementsCache[firstMountedIndex]?.start ??
          rowVirtualizer.getVirtualItems()[0]?.start)
        : rowVirtualizer.getVirtualItems()[0]?.start;

      const nextListHeight = virtualListHeightPx({
        totalSize: liveTotalSize,
        windowStart: mountedWindowStart,
        scrollMargin: liveScrollMargin,
        windowHeight: liveWindowHeight,
      });

      const applyGeometry = () => {
        list.style.height = `${nextListHeight}px`;
        if (win && mountedWindowStart !== undefined) {
          win.style.transform = getVirtualWindowTranslateY(
            mountedWindowStart,
            liveScrollMargin
          );
        }

        if (!widthChanged) return;

        const currentViewportHeight = container.clientHeight;
        if (currentViewportHeight <= 0) return;

        const maxScroll = Math.max(
          0,
          container.scrollHeight - currentViewportHeight
        );
        const visualTop = Math.max(0, mountedWindowStart ?? liveScrollMargin);
        const visualBottom = visualTop + liveWindowHeight;

        if (followTailRef.current) {
          const bottomPadding =
            Number.parseFloat(getComputedStyle(container).paddingBottom) || 0;
          const targetTop =
            win && liveWindowHeight > 1
              ? Math.min(
                  Math.max(
                    0,
                    visualBottom + bottomPadding - currentViewportHeight
                  ),
                  maxScroll
                )
              : maxScroll;
          if (Math.abs(container.scrollTop - targetTop) > 1) {
            container.scrollTop = targetTop;
          }
          rowVirtualizer.scrollOffset = container.scrollTop;
          lastScrollTopRef.current = container.scrollTop;
          lastScrollHeightRef.current = container.scrollHeight;
          return;
        }

        let nextScrollTop = Math.min(container.scrollTop, maxScroll);
        if (win && liveWindowHeight > 1) {
          const viewBottom = nextScrollTop + currentViewportHeight;
          if (visualBottom <= nextScrollTop + 1) {
            nextScrollTop = Math.min(
              Math.max(0, visualBottom - currentViewportHeight),
              maxScroll
            );
          } else if (visualTop >= viewBottom - 1) {
            nextScrollTop = Math.min(visualTop, maxScroll);
          }
        }
        if (Math.abs(nextScrollTop - container.scrollTop) > 1) {
          container.scrollTop = nextScrollTop;
        }
        rowVirtualizer.scrollOffset = container.scrollTop;
        lastScrollTopRef.current = container.scrollTop;
        lastScrollHeightRef.current = container.scrollHeight;
      };

      if (widthChanged) {
        runProgrammaticScroll(applyGeometry);
      } else {
        applyGeometry();
      }
    };

    const observer = new ResizeObserver((entries) => {
      updateScrollMargin();
      const nextHeight = container.clientHeight;
      const prevHeight = observedViewportHeightRef.current;
      if (nextHeight === 0) {
        if (prevHeight > 0) {
          captureHiddenScrollSnapshot();
        }
        observedViewportHeightRef.current = 0;
        viewportWidth = container.clientWidth;
        return;
      }
      const revealed = prevHeight === 0 && nextHeight > 0;
      observedViewportHeightRef.current = nextHeight;
      if (revealed) {
        viewportWidth = container.clientWidth;
        // Streaming growth changes the list, not the viewport. Restoring only
        // on 0 -> >0 reveal avoids jitter while recovering from hidden/detached
        // panels whose scrollTop Chromium reset to 0.
        restoreScrollPositionAfterReveal();
        return;
      }
      const nextWidth = container.clientWidth;
      const widthChanged = Math.abs(nextWidth - viewportWidth) > 0.5;
      viewportWidth = nextWidth;
      const windowResized =
        win != null && entries.some((e) => e.target === win);
      if (windowResized || widthChanged) {
        syncVirtualWindowGeometryBeforePaint(widthChanged);
      }
    });
    observer.observe(container);
    observer.observe(list);
    if (win) observer.observe(win);
    return () => observer.disconnect();
  }, [
    captureHiddenScrollSnapshot,
    isLoadingSkeleton,
    restoreScrollPositionAfterReveal,
    rowVirtualizer,
    runProgrammaticScroll,
    sessionId,
    sideRowsLength,
    updateScrollMargin,
  ]);

  useLayoutEffect(() => {
    updateActiveIndex();
  }, [updateActiveIndex, virtualRows]);

  useLayoutEffect(() => {
    const pendingJump = pendingJumpTimelineIndexRef.current;
    if (!pendingJump || pendingJump.index < visibleTimelineStartIndex) return;
    const localIndex = pendingJump.index - visibleTimelineStartIndex;
    const virtualIndex = virtualEntries.findIndex(
      (entry) => entry.timelineIndex === localIndex
    );
    if (virtualIndex < 0) return;
    pendingJumpTimelineIndexRef.current = null;
    jumpToVirtualIndex(virtualIndex, pendingJump.align);
  }, [jumpToVirtualIndex, virtualEntries, visibleTimelineStartIndex]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const viewportHeight = container?.clientHeight ?? 0;
    const rawSessionChanged = sessionPinRef.current !== sessionId;
    if (rawSessionChanged) {
      pinnedSessionReadyRef.current = null;
    }
    const firstNonEmptyForSession =
      virtualEntries.length > 0 && pinnedSessionReadyRef.current !== sessionId;
    if (firstNonEmptyForSession && viewportHeight > 0) {
      pinnedSessionReadyRef.current = sessionId;
    }
    const sessionChanged = rawSessionChanged || firstNonEmptyForSession;
    const combinedPrependEpoch = olderTurnsPrependEpoch + effectiveRevealEpoch;
    const skipPrependAdjust = skipNextPrependAdjustRef.current;
    if (skipPrependAdjust) {
      skipNextPrependAdjustRef.current = false;
    }
    const prepended =
      !skipPrependAdjust &&
      combinedPrependEpoch > previousPrependEpochRef.current;
    if (container) {
      const anchor =
        prepended && !sessionChanged && !followTailRef.current
          ? readingAnchorRef.current
          : null;
      const list = virtualListRef.current;
      const anchoredTop =
        anchor && list
          ? resolveAnchoredPrependScrollTop({
              anchor,
              measurements: rowVirtualizer.measurementsCache,
              scrollMarginDelta:
                measureScrollMargin(list, container) -
                rowVirtualizer.options.scrollMargin,
              scrollHeight: container.scrollHeight,
              viewportHeight: container.clientHeight,
            })
          : null;
      const nextTop =
        anchoredTop ??
        scrollTopAfterPrepend({
          followTail: followTailRef.current,
          sessionChanged,
          prepended,
          previousTotalSize: previousTotalSizeRef.current,
          nextTotalSize: totalSize,
          scrollTop: container.scrollTop,
        });
      if (nextTop !== container.scrollTop) {
        runProgrammaticScroll(() => {
          container.scrollTop = nextTop;
        });
        lastScrollTopRef.current = container.scrollTop;
        lastScrollHeightRef.current = container.scrollHeight;
      }
      if (
        anchoredTop != null &&
        anchor &&
        list &&
        typeof requestAnimationFrame === 'function'
      ) {
        cancelAnchorRestore();
        let frame = 0;
        let framesElapsed = 0;
        let stableFrames = 0;
        const cancel = () => {
          cancelAnimationFrame(frame);
          container.removeEventListener('wheel', cancel, true);
          container.removeEventListener('pointerdown', cancel, true);
          container.removeEventListener('touchstart', cancel, true);
          window.removeEventListener('keydown', cancel, true);
          cancelAnchorRestoreRef.current = null;
        };
        const settle = () => {
          if (
            followTailRef.current ||
            ++framesElapsed > ANCHOR_RESTORE_MAX_FRAMES
          ) {
            cancel();
            return;
          }
          const target = resolveAnchoredPrependScrollTop({
            anchor,
            measurements: rowVirtualizer.measurementsCache,
            scrollMarginDelta:
              measureScrollMargin(list, container) -
              rowVirtualizer.options.scrollMargin,
            scrollHeight: container.scrollHeight,
            viewportHeight: container.clientHeight,
          });
          if (target == null) {
            cancel();
            return;
          }
          if (Math.abs(container.scrollTop - target) > 1) {
            stableFrames = 0;
            runProgrammaticScroll(() => {
              container.scrollTop = target;
            });
            lastScrollTopRef.current = container.scrollTop;
            lastScrollHeightRef.current = container.scrollHeight;
          } else if (++stableFrames >= ANCHOR_RESTORE_STABLE_FRAMES) {
            cancel();
            return;
          }
          frame = requestAnimationFrame(settle);
        };
        container.addEventListener('wheel', cancel, {
          capture: true,
          passive: true,
        });
        container.addEventListener('pointerdown', cancel, true);
        container.addEventListener('touchstart', cancel, {
          capture: true,
          passive: true,
        });
        window.addEventListener('keydown', cancel, true);
        cancelAnchorRestoreRef.current = cancel;
        frame = requestAnimationFrame(settle);
      }
    }
    previousPrependEpochRef.current = combinedPrependEpoch;
    if (
      prepended ||
      sessionChanged ||
      followTailRef.current ||
      skipPrependAdjust
    ) {
      readingAnchorRef.current = null;
    }
    previousTotalSizeRef.current = totalSize;
    sessionPinRef.current = sessionId;
    const currentExpandableRevision = getExpandableRevision();
    const expansionChanged =
      expansionInViewRef.current &&
      seenExpansionRef.current !== null &&
      seenExpansionRef.current !== currentExpandableRevision;
    expansionInViewRef.current = false;
    seenExpansionRef.current = currentExpandableRevision;
    const decision = conversationTailFollowAction({
      attached: followTailRef.current,
      sessionChanged,
      expansionChanged,
      settlePassesRemaining: openSettlePassesRef.current,
      itemCount: virtualEntries.length,
      nearBottom: isAtBottomRef.current,
      viewportHeight,
    });
    followTailRef.current = decision.attached;
    setIsFollowingTail((current) =>
      current === decision.attached ? current : decision.attached
    );
    openSettlePassesRef.current = decision.settlePassesRemaining;
    if (decision.action === 'release') {
      if (expansionChanged) {
        detachFromBottom();
      } else {
        cancelVirtualizerFollowScroll(rowVirtualizer);
        if (isAtBottomRef.current && !decision.attached) {
          isAtBottomRef.current = false;
          onAtBottomChange?.(false);
        }
      }
      return;
    }
    if (viewportHeight === 0) return;
    if (virtualEntries.length === 0) {
      if (!isAtBottomRef.current) {
        isAtBottomRef.current = true;
        onAtBottomChange?.(true);
      }
      return;
    }
    isAtBottomRef.current = true;
    onAtBottomChange?.(true);
    pinToBottom('auto');
  }, [
    cancelAnchorRestore,
    detachFromBottom,
    effectiveRevealEpoch,
    olderTurnsPrependEpoch,
    onAtBottomChange,
    pinToBottom,
    processExpandableRevision,
    rowVirtualizer,
    runProgrammaticScroll,
    paintedWindowHeight,
    sessionId,
    totalSize,
    virtualEntries.length,
  ]);

  const virtualStartIndex = virtualRows[0]?.index ?? -1;
  const virtualEndIndex = virtualRows[virtualRows.length - 1]?.index ?? -1;

  useLayoutEffect(() => {
    const list = virtualListRef.current;
    if (!list || virtualEntries.length === 0) return;
    remeasureMountedVirtualRows(list, rowVirtualizer.resizeItem);
  }, [
    rowVirtualizer,
    virtualEntries,
    virtualRows.length,
    virtualStartIndex,
    virtualEndIndex,
  ]);

  useLayoutEffect(() => {
    const height = virtualWindowRef.current?.offsetHeight ?? 0;
    setPaintedWindowHeight((current) =>
      Math.abs(current - height) > 1 ? height : current
    );
  }, [virtualEntries, virtualRows]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (
      !container ||
      !surfaceActiveRef.current ||
      !container.isConnected ||
      virtualRows.length === 0
    ) {
      return;
    }
    const virtualizerScrollOffset = rowVirtualizer.scrollOffset ?? 0;
    if (
      !followTailRef.current &&
      (pendingJumpTimelineIndexRef.current != null ||
        isVirtualizerJumpActive(rowVirtualizer) ||
        Math.abs(container.scrollTop - virtualizerScrollOffset) > 1)
    ) {
      revealScrollRef.current = null;
      return;
    }
    const liveWindowHeight =
      virtualWindowRef.current?.offsetHeight || paintedWindowHeight;
    const bottomPadding =
      Number.parseFloat(getComputedStyle(container).paddingBottom) || 0;
    const next = scrollTopToRevealVirtualWindow({
      scrollTop: container.scrollTop,
      viewportHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      windowStart: virtualRows[0]?.start,
      scrollMargin,
      windowHeight: liveWindowHeight,
      bottomPadding,
      followTail: followTailRef.current,
    });
    if (next == null) {
      revealScrollRef.current = null;
      return;
    }
    if (
      revealScrollRef.current != null &&
      Math.abs(revealScrollRef.current - next) <= 1
    ) {
      return;
    }
    revealScrollRef.current = next;
    runProgrammaticScroll(() => {
      container.scrollTop = next;
    });
    lastScrollTopRef.current = container.scrollTop;
    lastScrollHeightRef.current = container.scrollHeight;
  }, [
    paintedWindowHeight,
    rowVirtualizer,
    runProgrammaticScroll,
    scrollMargin,
    totalSize,
    virtualRows,
  ]);

  useLayoutEffect(() => {
    if (tailRescueItemCountRef.current !== virtualEntries.length) {
      tailRescueItemCountRef.current = virtualEntries.length;
      tailRescuePassesRef.current = 0;
      tailRescueBudgetRef.current = 0;
    }
    if (paintedWindowHeight > tailRescueWindowHeightRef.current + 1) {
      tailRescueWindowHeightRef.current = paintedWindowHeight;
      tailRescuePassesRef.current = 0;
    }
    const container = containerRef.current;
    if (!container || !surfaceActiveRef.current || !container.isConnected) {
      return;
    }
    const needsRescue = conversationTailNeedsRescue({
      attached: followTailRef.current,
      viewportHeight: container.clientHeight,
      itemCount: virtualEntries.length,
      visibleIndexes: virtualRows.map((row) => row.index),
    });
    if (
      !needsRescue ||
      tailRescuePassesRef.current >= CONVERSATION_TAIL_RESCUE_PASSES ||
      tailRescueBudgetRef.current >= CONVERSATION_TAIL_RESCUE_PASSES * 3
    ) {
      return;
    }
    tailRescuePassesRef.current += 1;
    tailRescueBudgetRef.current += 1;
    const list = virtualListRef.current;
    if (list) {
      remeasureMountedVirtualRows(list, rowVirtualizer.resizeItem);
    }
    pinToBottom('auto');
  }, [
    paintedWindowHeight,
    pinToBottom,
    rowVirtualizer,
    virtualEntries.length,
    virtualRows,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom(behavior?: ScrollBehavior) {
        scrollToBottom(behavior ?? scrollBehavior);
      },
      scrollToIndex(index, options) {
        const shouldDetach = (options?.behavior ?? scrollBehavior) === 'smooth';
        scrollToTimelineIndexWithAlign(
          index,
          options?.align ?? 'center',
          shouldDetach
        );
      },
      scrollToPreviousUserMessage() {
        const container = containerRef.current;
        if (!container) return;
        const anchor = findViewportAnchorVirtualIndex(
          rowVirtualizer.getVirtualItems(),
          container.scrollTop,
          container.clientHeight
        );
        const target = findPreviousUserMessageVirtualIndex(
          userMessageIndexes,
          anchor
        );
        if (target === null) return;
        detachFromBottom();
        jumpToVirtualIndex(target, 'center');
      },
    }),
    [
      detachFromBottom,
      jumpToVirtualIndex,
      rowVirtualizer,
      scrollBehavior,
      scrollToBottom,
      scrollToTimelineIndexWithAlign,
      userMessageIndexes,
    ]
  );

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    return bindConversationSummaryMarquee(root);
  }, []);

  const scrollTailOverlayIntoView = useCallback(() => {
    const container = containerRef.current;
    if (!container || !isAtBottomRef.current) return;
    runProgrammaticScroll(() => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'auto',
      });
    });
  }, [runProgrammaticScroll]);

  const markExpansionInView = useCallback(() => {
    expansionInViewRef.current = true;
  }, []);

  return {
    containerRef,
    virtualListRef,
    virtualWindowRef,
    scrollMargin,
    rowVirtualizer,
    virtualEntries,
    virtualRows,
    totalSize,
    listHeight,
    visibleTimelineStartIndex,
    visibleTimelineItems,
    hasEarlierTimeline,
    loadEarlierTimeline,
    activeIndex,
    activeNavEntry,
    userMessageIndexes,
    findOpen,
    setFindOpen,
    findQuery,
    setFindQuery,
    findMatchIndex: safeFindMatchIndex,
    setFindMatchIndex,
    findMatches,
    currentFindMatch,
    goToFindMatch,
    cancelPendingJump,
    detachFromBottom,
    handleJumpToVirtualIndex,
    handleScroll,
    scrollToIndex,
    scrollTailOverlayIntoView,
    markExpansionInView,
  };
}
