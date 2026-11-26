import type { QueryClient } from '@tanstack/react-query';
import type { Session } from 'shared/types';
import { syncConversationSelectedAgent } from '@/features/conversation/conversationTimelineRegistry';
import {
  sessionsApi,
  type SessionStatus,
  type SessionSummary,
} from '@/lib/api';
import { normalizeAgentGroupKey } from '@/lib/providerInstancesApi';
import type { WorkspaceWithSession } from '@/types/attempt';

export const WORKSPACE_SESSIONS_CHANGED_EVENT = 'workspace-sessions-changed';
export const SESSION_AGENT_SWITCHED_EVENT = 'dimo:session-agent-switched';

export type WorkspaceSessionsChangedPayload = {
  workspace_id: string;
  conversation_id: string;
};

export type SessionAgentSwitchedDetail = {
  sessionId: string;
  agentId: string;
  executor: string;
  providerInstanceId?: string | null;
};

export function canonicalSessionAgentId(rawAgent: string): string {
  const trimmed = rawAgent.trim();
  if (!trimmed) return '';
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return trimmed.toLowerCase().replace(/-/g, '_');
  }
  return trimmed;
}

function normalizeCacheInstanceId(
  raw: string | null | undefined
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'local') return null;
  return trimmed;
}

export function syncSessionAgentInCaches(
  queryClient: QueryClient | null | undefined,
  sessionId: string | null | undefined,
  rawExecutor: string | null | undefined,
  rawProviderInstanceId?: string | null,
  options?: {
    deferBind?: boolean;
    forceInvalidate?: boolean;
  }
): void {
  const id = sessionId?.trim();
  const executor = rawExecutor?.trim();
  if (!id || !executor) return;
  const agentId = canonicalSessionAgentId(executor);
  if (!agentId) return;
  const targetGroup = normalizeAgentGroupKey(agentId);
  const nextInstanceId = normalizeCacheInstanceId(rawProviderInstanceId);
  const hasInstanceUpdate = nextInstanceId !== undefined;

  syncConversationSelectedAgent(id, agentId, options);

  if (queryClient) {
    queryClient.setQueriesData<Array<Record<string, unknown>>>(
      { queryKey: ['workspaceSessions'] },
      (current) => {
        if (!Array.isArray(current)) return current;
        let touched = false;
        const next = current.map((item) => {
          if (item?.id !== id) return item;
          const prevAgent =
            (typeof item.agent_id === 'string' && item.agent_id) ||
            (typeof item.executor === 'string' && item.executor) ||
            '';
          const agentChanged =
            normalizeAgentGroupKey(prevAgent) !== targetGroup;
          const currentInstance =
            typeof item.provider_instance_id === 'string'
              ? item.provider_instance_id
              : null;
          const instanceChanged =
            hasInstanceUpdate && currentInstance !== nextInstanceId;
          if (
            item.agent_id === agentId &&
            item.executor === agentId &&
            (!agentChanged || item.model == null) &&
            !instanceChanged
          ) {
            return item;
          }
          touched = true;
          return {
            ...item,
            agent_id: agentId,
            executor: agentId,
            ...('model' in item && (agentChanged || instanceChanged)
              ? { model: null }
              : {}),
            ...(hasInstanceUpdate
              ? { provider_instance_id: nextInstanceId }
              : {}),
          };
        });
        return touched ? next : current;
      }
    );

    queryClient.setQueryData<Session | undefined>(['session', id], (current) =>
      current
        ? {
            ...current,
            agent_id: agentId,
            executor: agentId,
            ...(hasInstanceUpdate
              ? { provider_instance_id: nextInstanceId }
              : {}),
          }
        : current
    );

    queryClient.setQueriesData<WorkspaceWithSession>(
      { queryKey: ['taskAttemptWithSession'] },
      (current) => {
        if (!current?.session || current.session.id !== id) return current;
        return {
          ...current,
          session: {
            ...current.session,
            agent_id: agentId,
            executor: agentId,
            ...(hasInstanceUpdate
              ? { provider_instance_id: nextInstanceId }
              : {}),
          },
        };
      }
    );

    queryClient.setQueriesData<Array<Record<string, unknown>>>(
      { queryKey: ['collaboration', 'conversations'] },
      (current) => {
        if (!Array.isArray(current)) return current;
        let touched = false;
        const next = current.map((item) => {
          const itemId = item?.id ?? item?.conversation_id;
          const currentInstance =
            typeof item?.provider_instance_id === 'string'
              ? item.provider_instance_id
              : null;
          const instanceChanged =
            hasInstanceUpdate && currentInstance !== nextInstanceId;
          if (
            itemId !== id ||
            (item.agent_id === agentId && !instanceChanged)
          ) {
            return item;
          }
          touched = true;
          return {
            ...item,
            agent_id: agentId,
            ...(hasInstanceUpdate
              ? { provider_instance_id: nextInstanceId }
              : {}),
          };
        });
        return touched ? next : current;
      }
    );

    queryClient.setQueriesData<Array<Record<string, unknown>> | null>(
      { queryKey: ['collaboration', 'sidebar'] },
      (current) => {
        if (!Array.isArray(current)) return current;
        let touched = false;
        const next = current.map((item) => {
          const member = item?.member as Record<string, unknown> | undefined;
          if (!member || member.conversation_id !== id) return item;
          if (member.agent === agentId && member.agent_id === agentId) {
            return item;
          }
          touched = true;
          return {
            ...item,
            member: {
              ...member,
              ...('agent' in member ? { agent: agentId } : {}),
              ...('agent_id' in member ? { agent_id: agentId } : {}),
            },
          };
        });
        return touched ? next : current;
      }
    );
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<SessionAgentSwitchedDetail>(
        SESSION_AGENT_SWITCHED_EVENT,
        {
          detail: {
            sessionId: id,
            agentId,
            executor,
            ...(hasInstanceUpdate
              ? { providerInstanceId: nextInstanceId }
              : {}),
          },
        }
      )
    );
  }
}

export function invalidateWorkspaceSessions(
  queryClient: QueryClient,
  workspaceId: string
) {
  return queryClient.invalidateQueries({
    queryKey: ['workspaceSessions', workspaceId],
  });
}

type SessionListCacheEntry = Pick<Session, 'id'> | Pick<SessionSummary, 'id'>;

export function removeSessionsFromWorkspaceCaches(
  queryClient: QueryClient,
  sessionIds: Iterable<string>
) {
  const deletedSessionIds = new Set(sessionIds);
  if (deletedSessionIds.size === 0) {
    return;
  }

  queryClient.setQueriesData<SessionListCacheEntry[]>(
    { queryKey: ['workspaceSessions'] },
    (current) => {
      if (!Array.isArray(current)) {
        return current;
      }

      return current.filter((session) => !deletedSessionIds.has(session.id));
    }
  );

  queryClient.setQueriesData<WorkspaceWithSession>(
    { queryKey: ['taskAttemptWithSession'] },
    (current) => {
      if (!current?.session || !deletedSessionIds.has(current.session.id)) {
        return current;
      }

      return {
        ...current,
        session: undefined,
      };
    }
  );

  deletedSessionIds.forEach((sessionId) => {
    queryClient.removeQueries({
      queryKey: ['session', sessionId],
    });
  });
}

export interface CachedSessionReviewState {
  status: SessionStatus | string;
  isRunning: boolean;
  workspaceId: string | null;
}

export function isSessionReviewReady(session: {
  status?: SessionStatus | string | null;
  isRunning?: boolean;
}): boolean {
  return session.status === 'inreview' && !session.isRunning;
}

export function findCachedSessionReviewState(
  queryClient: QueryClient | null | undefined,
  sessionId: string | null | undefined
): CachedSessionReviewState | null {
  const id = sessionId?.trim();
  if (!queryClient || !id) return null;

  const workspaceQueries = queryClient.getQueriesData<
    Array<Record<string, unknown>>
  >({ queryKey: ['workspaceSessions'] });
  for (const [, current] of workspaceQueries) {
    if (!Array.isArray(current)) continue;
    const match = current.find((item) => item?.id === id);
    if (match && typeof match.status === 'string') {
      return {
        status: match.status,
        isRunning: Boolean(match.is_running),
        workspaceId:
          typeof match.workspace_id === 'string' && match.workspace_id.trim()
            ? match.workspace_id
            : null,
      };
    }
  }

  const session = queryClient.getQueryData<Session>(['session', id]);
  if (session && typeof session.status === 'string') {
    return {
      status: session.status,
      isRunning: false,
      workspaceId: session.workspace_id?.trim() || null,
    };
  }

  return null;
}

export function syncSessionStatusInCaches(
  queryClient: QueryClient | null | undefined,
  sessionId: string | null | undefined,
  status: SessionStatus | string
): void {
  const id = sessionId?.trim();
  if (!queryClient || !id) return;

  queryClient.setQueriesData<Array<Record<string, unknown>>>(
    { queryKey: ['workspaceSessions'] },
    (current) => {
      if (!Array.isArray(current)) return current;
      let touched = false;
      const next = current.map((item) => {
        if (item?.id !== id || item.status === status) return item;
        touched = true;
        return {
          ...item,
          status,
        };
      });
      return touched ? next : current;
    }
  );

  queryClient.setQueryData<Session | undefined>(['session', id], (current) =>
    current && current.status !== status
      ? {
          ...current,
          status: status as Session['status'],
        }
      : current
  );
}

export function isDocumentForegroundActive(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.visibilityState === 'hidden') return false;
  if (typeof document.hasFocus === 'function') {
    return document.hasFocus();
  }
  return true;
}

export function subscribeDocumentForeground(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }
  const notify = () => listener();
  window.addEventListener('focus', notify);
  window.addEventListener('blur', notify);
  document.addEventListener('visibilitychange', notify);
  return () => {
    window.removeEventListener('focus', notify);
    window.removeEventListener('blur', notify);
    document.removeEventListener('visibilitychange', notify);
  };
}

const inFlightMarkViewedRequests = new Map<string, Promise<boolean>>();

export function markReviewSessionViewed(
  queryClient: QueryClient | null | undefined,
  sessionId: string | null | undefined,
  options?: {
    workspaceId?: string | null;
    onlyIfCached?: boolean;
    knownState?: {
      status?: SessionStatus | string | null;
      isRunning?: boolean;
    };
  }
): Promise<boolean> {
  const id = sessionId?.trim();
  if (!queryClient || !id) return Promise.resolve(false);

  const existing = inFlightMarkViewedRequests.get(id);
  if (existing) {
    return existing;
  }

  if (options?.knownState?.isRunning) {
    return Promise.resolve(false);
  }

  const cached = findCachedSessionReviewState(queryClient, id);
  const effectiveState =
    options?.knownState?.status != null
      ? {
          status: options.knownState.status,
          isRunning: Boolean(options.knownState.isRunning),
        }
      : cached;
  if (effectiveState && !isSessionReviewReady(effectiveState)) {
    return Promise.resolve(false);
  }
  if (!effectiveState && options?.onlyIfCached) {
    return Promise.resolve(false);
  }

  const workspaceId =
    options?.workspaceId?.trim() || cached?.workspaceId || null;
  const previousStatus = effectiveState?.status ?? null;

  syncSessionStatusInCaches(queryClient, id, 'done');

  const request = (async () => {
    try {
      await sessionsApi.markViewed(id);
      await queryClient.invalidateQueries({
        queryKey: workspaceId
          ? ['workspaceSessions', workspaceId]
          : ['workspaceSessions'],
      });
      return true;
    } catch {
      if (previousStatus) {
        syncSessionStatusInCaches(queryClient, id, previousStatus);
      }
      await queryClient.invalidateQueries({
        queryKey: workspaceId
          ? ['workspaceSessions', workspaceId]
          : ['workspaceSessions'],
      });
      return false;
    } finally {
      inFlightMarkViewedRequests.delete(id);
    }
  })();

  inFlightMarkViewedRequests.set(id, request);
  return request;
}
