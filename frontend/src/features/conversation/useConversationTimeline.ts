import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  getConversationSessionFacts,
  getConversationTimelineView,
  retainConversationSurface,
  retainConversationTimeline,
  subscribeConversationTimeline,
  type ConversationSessionFacts,
  type ConversationTimelineView,
} from './conversationTimelineRegistry';

export type UseConversationTimelineResult = ConversationTimelineView;

export function useConversationTimeline(
  conversationId: string | null,
  options?: { active?: boolean }
): UseConversationTimelineResult {
  const isActive = options?.active ?? true;
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      conversationId
        ? subscribeConversationTimeline(onStoreChange, conversationId)
        : () => {},
    [conversationId]
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => getConversationTimelineView(conversationId),
    () => getConversationTimelineView(conversationId)
  );
  useEffect(() => {
    if (!conversationId) return;
    return retainConversationSurface(conversationId);
  }, [conversationId]);
  useEffect(() => {
    if (!conversationId || !isActive) return;
    return retainConversationTimeline(conversationId);
  }, [conversationId, isActive]);
  return snapshot;
}

export function useConversationSessionFacts(
  conversationId: string | null
): ConversationSessionFacts {
  return useConversationTimelineSelector(
    conversationId,
    getConversationSessionFacts
  );
}

export function useConversationTimelineSelector<T>(
  conversationId: string | null,
  selector: (id: string | null) => T
): T {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      conversationId
        ? subscribeConversationTimeline(onStoreChange, conversationId)
        : () => {},
    [conversationId]
  );
  return useSyncExternalStore(
    subscribe,
    () => selector(conversationId),
    () => selector(conversationId)
  );
}
