import { useCallback, useContext, useRef } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import type { ExecutorProfileId } from 'shared/types';
import { toast } from '@/components/ui/toast';
import {
  conversationApi,
  isUnimplementedConversationCommandError,
} from '@/features/conversation/conversationApi';
import {
  beginConversationEngineHandoff,
  cancelConversationEngineHandoff,
  completeConversationEngineHandoff,
} from '@/features/conversation/conversationTimelineRegistry';
import { recordMruProviderInstanceId } from '@/lib/providerInstanceMru';
import {
  LOCAL_PROVIDER_INSTANCE_ID,
  normalizeAgentGroupKey,
  normalizeProviderInstanceIdForApi,
} from '@/lib/providerInstancesApi';
import { syncSessionAgentInCaches } from '@/lib/sessionQueryCache';

function isUnavailableHandoffCommandError(error: unknown): boolean {
  if (isUnimplementedConversationCommandError(error)) {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /__tauri_internals__|reading\s+'invoke'|tauri\s+runtime/i.test(msg);
}

export interface ComposerEngineHandoffController {
  handleChangeExecutorProfile: (next: ExecutorProfileId | null) => void;
  handleChangeProviderInstance: (nextInstanceId: string) => void;
}

export function useComposerEngineHandoff({
  sessionId,
  currentExecutor,
  currentProviderInstanceId = null,
  onApplyExecutorProfile,
  onApplyProviderInstanceId,
  resolveTargetInstanceIdForAgent,
}: {
  sessionId: string | null | undefined;
  currentExecutor: string | null | undefined;
  currentProviderInstanceId?: string | null;
  onApplyExecutorProfile: (profile: ExecutorProfileId | null) => void;
  onApplyProviderInstanceId?: (
    instanceId: string | null,
    targetAgentId?: string | null
  ) => void;
  resolveTargetInstanceIdForAgent?: (agentId: string) => string | null;
}): ComposerEngineHandoffController {
  const queryClient = useContext(QueryClientContext);
  const switchSeqByConversationRef = useRef<Map<string, number>>(new Map());
  const activeSessionIdRef = useRef(sessionId);
  activeSessionIdRef.current = sessionId;

  const nextSwitchSeq = useCallback((conversationId: string): number => {
    const next =
      (switchSeqByConversationRef.current.get(conversationId) ?? 0) + 1;
    switchSeqByConversationRef.current.set(conversationId, next);
    return next;
  }, []);

  const isLatestSwitchSeq = useCallback(
    (conversationId: string, seq: number): boolean =>
      switchSeqByConversationRef.current.get(conversationId) === seq,
    []
  );

  const handleChangeExecutorProfile = useCallback(
    (nextProfile: ExecutorProfileId | null) => {
      const isDifferentAgent = Boolean(
        nextProfile &&
          (!currentExecutor ||
            normalizeAgentGroupKey(nextProfile.executor) !==
              normalizeAgentGroupKey(currentExecutor))
      );

      const resolvedTargetInstance =
        nextProfile && resolveTargetInstanceIdForAgent
          ? normalizeProviderInstanceIdForApi(
              resolveTargetInstanceIdForAgent(nextProfile.executor)
            )
          : undefined;

      if (!nextProfile || !sessionId || !isDifferentAgent) {
        if (nextProfile && resolvedTargetInstance !== undefined) {
          onApplyProviderInstanceId?.(
            resolvedTargetInstance,
            nextProfile.executor
          );
        }
        onApplyExecutorProfile(nextProfile);
        return;
      }

      const targetSessionId = sessionId;
      const previousExecutor = currentExecutor ?? null;
      const previousInstance = normalizeProviderInstanceIdForApi(
        currentProviderInstanceId
      );
      const previousProfile: ExecutorProfileId | null = previousExecutor
        ? {
            executor: previousExecutor as ExecutorProfileId['executor'],
            variant: null,
          }
        : null;
      const switchSeq = nextSwitchSeq(targetSessionId);
      const handoffToken = beginConversationEngineHandoff(
        targetSessionId,
        nextProfile.executor,
        { forceInvalidate: true }
      );

      if (resolvedTargetInstance !== undefined) {
        syncSessionAgentInCaches(
          queryClient,
          targetSessionId,
          nextProfile.executor,
          resolvedTargetInstance,
          { deferBind: true, forceInvalidate: true }
        );
        onApplyProviderInstanceId?.(
          resolvedTargetInstance,
          nextProfile.executor
        );
      } else {
        syncSessionAgentInCaches(
          queryClient,
          targetSessionId,
          nextProfile.executor,
          undefined,
          { deferBind: true, forceInvalidate: true }
        );
      }
      onApplyExecutorProfile(nextProfile);
      void conversationApi
        .confirmEngineHandoff({
          conversationId: targetSessionId,
          targetEngine: nextProfile.executor,
          ...(resolvedTargetInstance !== undefined
            ? {
                targetProviderInstanceId:
                  resolvedTargetInstance ?? LOCAL_PROVIDER_INSTANCE_ID,
              }
            : {}),
        })
        .then(() => {
          if (isLatestSwitchSeq(targetSessionId, switchSeq)) {
            completeConversationEngineHandoff(targetSessionId, handoffToken);
          }
        })
        .catch((error: unknown) => {
          if (isUnavailableHandoffCommandError(error)) {
            if (isLatestSwitchSeq(targetSessionId, switchSeq)) {
              completeConversationEngineHandoff(targetSessionId, handoffToken);
            }
            return;
          }
          if (isLatestSwitchSeq(targetSessionId, switchSeq)) {
            cancelConversationEngineHandoff(
              targetSessionId,
              null,
              handoffToken
            );
            if (previousExecutor) {
              if (resolvedTargetInstance !== undefined) {
                syncSessionAgentInCaches(
                  queryClient,
                  targetSessionId,
                  previousExecutor,
                  previousInstance,
                  { deferBind: false, forceInvalidate: true }
                );
              } else {
                syncSessionAgentInCaches(
                  queryClient,
                  targetSessionId,
                  previousExecutor,
                  undefined,
                  { deferBind: false, forceInvalidate: true }
                );
              }
            }
            if (activeSessionIdRef.current === targetSessionId) {
              if (resolvedTargetInstance !== undefined) {
                onApplyProviderInstanceId?.(previousInstance, previousExecutor);
              }
              onApplyExecutorProfile(previousProfile);
            }
          }
          toast.error(error instanceof Error ? error.message : String(error));
        });
    },
    [
      currentExecutor,
      currentProviderInstanceId,
      isLatestSwitchSeq,
      nextSwitchSeq,
      onApplyExecutorProfile,
      onApplyProviderInstanceId,
      queryClient,
      resolveTargetInstanceIdForAgent,
      sessionId,
    ]
  );

  const handleChangeProviderInstance = useCallback(
    (nextInstanceId: string) => {
      if (!currentExecutor) return;
      const nextStorageInstance =
        normalizeProviderInstanceIdForApi(nextInstanceId);
      const previousInstance = normalizeProviderInstanceIdForApi(
        currentProviderInstanceId
      );
      recordMruProviderInstanceId(currentExecutor, nextInstanceId);
      if (nextStorageInstance === previousInstance) {
        onApplyProviderInstanceId?.(nextStorageInstance, currentExecutor);
        return;
      }

      onApplyProviderInstanceId?.(nextStorageInstance, currentExecutor);
      if (!sessionId) {
        return;
      }

      const targetSessionId = sessionId;
      const nextWireInstance =
        nextStorageInstance ?? LOCAL_PROVIDER_INSTANCE_ID;
      const switchSeq = nextSwitchSeq(targetSessionId);
      const handoffToken = beginConversationEngineHandoff(
        targetSessionId,
        currentExecutor,
        { forceInvalidate: true }
      );

      syncSessionAgentInCaches(
        queryClient,
        targetSessionId,
        currentExecutor,
        nextStorageInstance,
        { deferBind: true, forceInvalidate: true }
      );

      void conversationApi
        .confirmEngineHandoff({
          conversationId: targetSessionId,
          targetEngine: currentExecutor,
          targetProviderInstanceId: nextWireInstance,
        })
        .then(() => {
          if (isLatestSwitchSeq(targetSessionId, switchSeq)) {
            completeConversationEngineHandoff(targetSessionId, handoffToken);
          }
        })
        .catch((error: unknown) => {
          if (isUnavailableHandoffCommandError(error)) {
            if (isLatestSwitchSeq(targetSessionId, switchSeq)) {
              completeConversationEngineHandoff(targetSessionId, handoffToken);
            }
            return;
          }
          if (isLatestSwitchSeq(targetSessionId, switchSeq)) {
            cancelConversationEngineHandoff(
              targetSessionId,
              null,
              handoffToken
            );
            syncSessionAgentInCaches(
              queryClient,
              targetSessionId,
              currentExecutor,
              previousInstance,
              { deferBind: false, forceInvalidate: true }
            );
            if (activeSessionIdRef.current === targetSessionId) {
              onApplyProviderInstanceId?.(previousInstance, currentExecutor);
            }
          }
          toast.error(error instanceof Error ? error.message : String(error));
        });
    },
    [
      currentExecutor,
      currentProviderInstanceId,
      isLatestSwitchSeq,
      nextSwitchSeq,
      onApplyProviderInstanceId,
      queryClient,
      sessionId,
    ]
  );

  return {
    handleChangeExecutorProfile,
    handleChangeProviderInstance,
  };
}
