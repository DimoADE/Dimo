import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/components/ui/toast';
import type { AgentSessionConfigOption, ExecutorProfileId } from 'shared/types';
import { listenToAgentEvents } from '@/features/agents/events';
import { conversationApi } from '@/features/conversation/conversationApi';
import {
  areConfigValuesEqual,
  dropPendingConfigValueAfterRejection,
  dropPendingModeAfterRejection,
  reconcilePendingConfigValues,
  reconcilePendingMode,
  selectConfigOptionValue,
} from './SessionConfigOptionSelectors';
import type { SessionComposerImage } from './SessionComposerInput';
import { revokeComposerImagePreviewUrl } from './sessionComposerImages';
import {
  persistPendingSessionControls,
  resolveComposerControlScopeTransition,
  type AutoCreatedComposerSession,
  type ComposerControlScopeSnapshot,
} from './sessionComposerSession';

export function useSessionComposerLocalState() {
  const [localMessage, setLocalMessage] = useState('');
  const [attachedImages, setAttachedImages] = useState<SessionComposerImage[]>(
    []
  );
  const attachedImagesRef = useRef<SessionComposerImage[]>(attachedImages);
  attachedImagesRef.current = attachedImages;
  useEffect(() => {
    return () => {
      attachedImagesRef.current.forEach(revokeComposerImagePreviewUrl);
    };
  }, []);
  const attachedImagePaths = useMemo(
    () => attachedImages.map((image) => image.path),
    [attachedImages]
  );
  const executorProfileRef = useRef<ExecutorProfileId | null>(null);

  return {
    localMessage,
    setLocalMessage,
    attachedImages,
    setAttachedImages,
    attachedImagePaths,
    executorProfileRef,
  };
}

export function useSessionComposerProfileSelection(
  defaultExecutorProfile: ExecutorProfileId | null
) {
  const [selectedExecutorProfile, setSelectedExecutorProfile] =
    useState<ExecutorProfileId | null>(defaultExecutorProfile);
  const effectiveExecutorProfile =
    selectedExecutorProfile ?? defaultExecutorProfile;

  return {
    selectedExecutorProfile,
    setSelectedExecutorProfile,
    effectiveExecutorProfile,
  };
}

export function useSessionComposerPendingControls({
  sessionId,
  targetExecutor,
  resolvedSessionExecutor,
  providerInstanceId = null,
}: {
  sessionId: string | undefined;
  targetExecutor: string | null | undefined;
  resolvedSessionExecutor: string | null | undefined;
  providerInstanceId?: string | null;
}) {
  const [selectedMode, setSelectedMode] = useState<string | null>(null);
  const [selectedConfigValues, setSelectedConfigValues] = useState<
    Record<string, string>
  >({});

  const selectedModeRef = useRef(selectedMode);
  selectedModeRef.current = selectedMode;
  const selectedConfigValuesRef = useRef(selectedConfigValues);
  selectedConfigValuesRef.current = selectedConfigValues;

  const justAutoCreatedSessionRef = useRef<AutoCreatedComposerSession | null>(
    null
  );
  const previousScopeRef = useRef<ComposerControlScopeSnapshot | null>(null);

  const markAutoCreatedSession = useCallback(
    (createdSessionId: string, executor: string) => {
      justAutoCreatedSessionRef.current = {
        sessionId: createdSessionId,
        executor,
      };
      persistPendingSessionControls({
        conversationId: createdSessionId,
        selectedMode: selectedModeRef.current,
        selectedConfigValues: selectedConfigValuesRef.current,
        setSessionMode: (args) => conversationApi.setSessionMode(args),
        setSessionConfigOption: (args) =>
          conversationApi.setSessionConfigOption(args),
      });
    },
    []
  );

  useEffect(() => {
    const currentScope: ComposerControlScopeSnapshot = {
      sessionId,
      targetExecutor,
      resolvedSessionExecutor,
      providerInstanceId,
    };
    const transition = resolveComposerControlScopeTransition({
      previous: previousScopeRef.current,
      current: currentScope,
      autoCreatedSession: justAutoCreatedSessionRef.current,
    });
    previousScopeRef.current = currentScope;
    justAutoCreatedSessionRef.current = transition.nextAutoCreatedSession;

    if (transition.shouldReset) {
      setSelectedMode(null);
      setSelectedConfigValues({});
      return;
    }

    if (transition.shouldPersistToAutoCreatedSession && sessionId) {
      persistPendingSessionControls({
        conversationId: sessionId,
        selectedMode: selectedModeRef.current,
        selectedConfigValues: selectedConfigValuesRef.current,
        setSessionMode: (args) => conversationApi.setSessionMode(args),
        setSessionConfigOption: (args) =>
          conversationApi.setSessionConfigOption(args),
      });
    }
  }, [sessionId, targetExecutor, resolvedSessionExecutor, providerInstanceId]);

  return {
    selectedMode,
    setSelectedMode,
    selectedConfigValues,
    setSelectedConfigValues,
    markAutoCreatedSession,
  };
}

export function useSessionComposerControlSync({
  sessionId,
  isChangingAgent,
  liveModeId,
  displaySessionConfigOptions,
  selectedConfigValues,
  setSelectedMode,
  setSelectedConfigValues,
}: {
  sessionId: string | undefined;
  isChangingAgent: boolean;
  liveModeId: string | null;
  displaySessionConfigOptions: AgentSessionConfigOption[];
  selectedConfigValues: Record<string, string>;
  setSelectedMode: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedConfigValues: React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >;
}) {
  useEffect(() => {
    setSelectedConfigValues((previous) => {
      const next = reconcilePendingConfigValues(
        displaySessionConfigOptions,
        previous
      );
      return areConfigValuesEqual(previous, next) ? previous : next;
    });
  }, [displaySessionConfigOptions, setSelectedConfigValues]);

  useEffect(() => {
    setSelectedMode((previous) => reconcilePendingMode(liveModeId, previous));
  }, [liveModeId, setSelectedMode]);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenToAgentEvents((envelope) => {
      if (!active || envelope.session_id !== sessionId) return;
      if (envelope.event.kind !== 'config_option_rejected') return;
      const rejection = envelope.event;
      setSelectedMode((previous) =>
        dropPendingModeAfterRejection(rejection, previous)
      );
      setSelectedConfigValues((previous) =>
        dropPendingConfigValueAfterRejection(rejection.config_id, previous)
      );
      const label = rejection.option_name || rejection.config_id;
      toast.warning(`${label}: ${rejection.requested} → ${rejection.actual}`);
    }).then((unsubscribe) => {
      if (!active) {
        unsubscribe();
        return;
      }
      unlisten = unsubscribe;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [sessionId, setSelectedConfigValues, setSelectedMode]);

  const handleSelectMode = useCallback(
    (modeId: string) => {
      setSelectedMode(modeId);
      if (!sessionId || isChangingAgent) return;
      void conversationApi
        .setSessionMode({ conversationId: sessionId, modeId })
        .catch((error: unknown) => {
          setSelectedMode((previous) =>
            previous === modeId ? null : previous
          );
          toast.error(error instanceof Error ? error.message : String(error));
        });
    },
    [isChangingAgent, sessionId, setSelectedMode]
  );

  const handleSelectConfigOption = useCallback(
    (key: string, value: string) => {
      const nextValues = selectConfigOptionValue(
        displaySessionConfigOptions,
        selectedConfigValues,
        key,
        value
      );
      const accepted = nextValues[key] === value;
      setSelectedConfigValues((previous) =>
        selectConfigOptionValue(
          displaySessionConfigOptions,
          previous,
          key,
          value
        )
      );
      if (!accepted || !sessionId || isChangingAgent) return;
      void conversationApi
        .setSessionConfigOption({ conversationId: sessionId, key, value })
        .catch((error: unknown) => {
          setSelectedConfigValues((previous) => {
            if (previous[key] !== value) return previous;
            const restored = { ...previous };
            delete restored[key];
            return restored;
          });
          toast.error(error instanceof Error ? error.message : String(error));
        });
    },
    [
      displaySessionConfigOptions,
      isChangingAgent,
      selectedConfigValues,
      sessionId,
      setSelectedConfigValues,
    ]
  );

  return { handleSelectMode, handleSelectConfigOption };
}
