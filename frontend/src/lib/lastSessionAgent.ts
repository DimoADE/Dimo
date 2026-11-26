/**
 * Remembers the Agent selected when the user last created a new session and
 * resolves the default Agent for subsequent session creation, falling back to
 * the user's configured default Agent when unset or unavailable.
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { AgentId, ExecutorConfigs, ExecutorProfileId } from 'shared/types';

import { isEnabledInstalledAgent } from '@/features/agents/operationalAgent';
import {
  useSelectableAgents,
  type SelectableAgent,
} from '@/features/agents/useSelectableAgents';
import { persistFrontendPreference } from '@/lib/frontendPreferences';
import {
  getDefaultProfileForExecutor,
  getFirstAvailableProfile,
} from '@/utils/executor';

export const LAST_SESSION_AGENT_KEY = 'dimo:last-session-agent' as const;

const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cached: AgentId | null = null;
let storageListenerInstalled = false;

function parse(value: string | null): AgentId | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? (trimmed as AgentId) : null;
}

function read(): AgentId | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LAST_SESSION_AGENT_KEY);
  } catch {
    return null;
  }

  if (raw === cachedRaw) return cached;

  cachedRaw = raw;
  cached = parse(raw);
  return cached;
}

function emit(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

function installStorageListener(): void {
  if (storageListenerInstalled || typeof window === 'undefined') return;

  storageListenerInstalled = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== LAST_SESSION_AGENT_KEY) {
      return;
    }
    read();
    emit();
  });
}

export function getLastSessionAgent(): AgentId | null {
  return read();
}

export function recordLastSessionAgent(
  agentId: AgentId | string | null | undefined
): void {
  const normalized = parse(agentId ?? null);
  if (!normalized) return;
  if (normalized === read()) return;

  try {
    localStorage.setItem(LAST_SESSION_AGENT_KEY, normalized);
    persistFrontendPreference(LAST_SESSION_AGENT_KEY, normalized);
  } catch {
    // Keep the in-memory value even when persistence is unavailable.
  }

  cachedRaw = normalized;
  cached = normalized;
  emit();
}

export function clearLastSessionAgent(): void {
  try {
    localStorage.removeItem(LAST_SESSION_AGENT_KEY);
  } catch {
    // Ignore storage failures when resetting in-memory cache.
  }

  cachedRaw = null;
  cached = null;
  emit();
}

export function subscribeLastSessionAgent(listener: () => void): () => void {
  installStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLastSessionAgent(): AgentId | null {
  return useSyncExternalStore(
    subscribeLastSessionAgent,
    getLastSessionAgent,
    () => null
  );
}

function buildProfileForAgent(
  agentId: AgentId,
  configExecutorProfile: ExecutorProfileId | null | undefined,
  profiles: ExecutorConfigs['executors'] | null | undefined
): ExecutorProfileId {
  if (
    configExecutorProfile?.executor &&
    configExecutorProfile.executor === agentId
  ) {
    return configExecutorProfile;
  }
  return (
    getDefaultProfileForExecutor(agentId, profiles) ?? {
      executor: agentId,
      variant: null,
    }
  );
}

export interface ResolveNewSessionExecutorProfileInput {
  lastSessionAgent: AgentId | null | undefined;
  configExecutorProfile: ExecutorProfileId | null | undefined;
  profiles: ExecutorConfigs['executors'] | null | undefined;
  selectableAgents?: ReadonlyArray<SelectableAgent>;
}

export function resolveNewSessionExecutorProfile({
  lastSessionAgent,
  configExecutorProfile,
  profiles,
  selectableAgents,
}: ResolveNewSessionExecutorProfileInput): ExecutorProfileId | null {
  const normalizedLast = parse(lastSessionAgent ?? null);

  if (normalizedLast) {
    if (selectableAgents && selectableAgents.length > 0) {
      const matched =
        selectableAgents.find((agent) => agent.agentId === normalizedLast) ??
        selectableAgents.find(
          (agent) =>
            agent.agentId.toLowerCase() === normalizedLast.toLowerCase()
        );
      if (matched && isEnabledInstalledAgent(matched) && matched.runnable) {
        return buildProfileForAgent(
          matched.agentId,
          configExecutorProfile,
          profiles
        );
      }
      // Remembered agent is missing, disabled, uninstalled, or not runnable;
      // fall back to the user's configured default agent.
    } else {
      return buildProfileForAgent(
        normalizedLast,
        configExecutorProfile,
        profiles
      );
    }
  }

  if (configExecutorProfile?.executor) {
    return configExecutorProfile;
  }

  return getFirstAvailableProfile(profiles);
}

export function useNewSessionDefaultExecutorProfile({
  configExecutorProfile,
  profiles,
  refreshKey,
}: {
  configExecutorProfile: ExecutorProfileId | null | undefined;
  profiles: ExecutorConfigs['executors'] | null | undefined;
  refreshKey?: unknown;
}): ExecutorProfileId | null {
  const lastSessionAgent = useLastSessionAgent();
  const selectableAgents = useSelectableAgents(refreshKey);

  return useMemo(
    () =>
      resolveNewSessionExecutorProfile({
        lastSessionAgent,
        configExecutorProfile,
        profiles,
        selectableAgents,
      }),
    [configExecutorProfile, lastSessionAgent, profiles, selectableAgents]
  );
}
