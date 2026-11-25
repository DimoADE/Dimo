import { useEffect } from 'react';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import type { AgentSessionControlsSnapshot } from 'shared/types';
import { backendListen } from '@/lib/backendTransport';
import { agentsApi } from './api';
import {
  mergeCreateSessionControls,
  normalizeAgentType,
  sessionControlsQueryKey,
  sessionControlsSchemaQueryKey,
} from './sessionControlsQuery';

export type AgentCapabilityCatalogUpdatedEvent = {
  agentId: string;
  providerInstanceId?: string | null;
  controls: AgentSessionControlsSnapshot;
};

function normalizeScopedInstance(
  providerInstanceId?: string | null
): string | null {
  const trimmed = providerInstanceId?.trim() ?? '';
  return trimmed.length > 0 && trimmed.toLowerCase() !== 'local'
    ? trimmed
    : null;
}

export function applyCapabilityCatalogUpdate(
  queryClient: QueryClient,
  event: AgentCapabilityCatalogUpdatedEvent
): void {
  const normalizedAgent = normalizeAgentType(event.agentId);
  if (!normalizedAgent) return;
  const scopedInstance = normalizeScopedInstance(event.providerInstanceId);
  queryClient.setQueryData(
    sessionControlsQueryKey(normalizedAgent, null, scopedInstance),
    event.controls
  );
  queryClient.setQueriesData<AgentSessionControlsSnapshot | null>(
    {
      predicate: (query) => {
        const key = query.queryKey;
        if (
          key[0] !== 'agent-session-controls-catalog' ||
          key[1] !== normalizedAgent
        ) {
          return false;
        }
        const keyInstance =
          typeof key[3] === 'string' ? normalizeScopedInstance(key[3]) : null;
        return keyInstance === scopedInstance;
      },
    },
    () => event.controls
  );
  queryClient.setQueryData<AgentSessionControlsSnapshot | null>(
    sessionControlsSchemaQueryKey(normalizedAgent, scopedInstance),
    (existing) =>
      mergeCreateSessionControls([event.controls, existing]) ?? event.controls
  );
}

/**
 * Hydrates TanStack Query session-controls cache at shell mount via a single
 * 0ms batch snapshot RPC, then keeps entries fresh in-place from
 * `agent-capability-catalog-updated` HostEventBus pushes.
 */
export function useAgentCapabilityCatalogSync(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let active = true;
    const receivedPushKeys = new Set<string>();
    const cacheKeyFor = (agentId: string, providerInstanceId?: string | null) =>
      `${normalizeAgentType(agentId)}::${normalizeScopedInstance(providerInstanceId) ?? ''}`;

    let unlisten: (() => void) | undefined;
    void backendListen<AgentCapabilityCatalogUpdatedEvent>(
      'agent-capability-catalog-updated',
      (payload) => {
        if (!active || !payload?.agentId || !payload.controls) return;
        receivedPushKeys.add(
          cacheKeyFor(payload.agentId, payload.providerInstanceId)
        );
        applyCapabilityCatalogUpdate(queryClient, payload);
      }
    )
      .then((dispose) => {
        if (!active) {
          dispose();
        } else {
          unlisten = dispose;
        }
      })
      .catch(() => undefined);

    void agentsApi
      .capabilityCatalogsSnapshot()
      .then((snapshots) => {
        if (!active || !snapshots) return;
        for (const [agentId, controls] of Object.entries(snapshots)) {
          if (!controls) continue;
          if (receivedPushKeys.has(cacheKeyFor(agentId, null))) continue;
          applyCapabilityCatalogUpdate(queryClient, {
            agentId,
            providerInstanceId: null,
            controls,
          });
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisten?.();
    };
  }, [queryClient]);
}
