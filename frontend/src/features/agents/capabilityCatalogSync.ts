import { useEffect } from 'react';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import type { AgentSessionControlsSnapshot } from 'shared/types';
import { backendListen } from '@/lib/backendTransport';
import { agentsApi } from './api';
import {
  sessionControlsQueryKey,
  sessionControlsSchemaQueryKey,
} from './sessionControlsQuery';

export type AgentCapabilityCatalogUpdatedEvent = {
  agentId: string;
  providerInstanceId?: string | null;
  controls: AgentSessionControlsSnapshot;
};

export function applyCapabilityCatalogUpdate(
  queryClient: QueryClient,
  event: AgentCapabilityCatalogUpdatedEvent
): void {
  const scopedInstance = event.providerInstanceId?.trim() || null;
  queryClient.setQueryData(
    sessionControlsQueryKey(event.agentId, null, scopedInstance),
    event.controls
  );
  queryClient.setQueryData(
    sessionControlsSchemaQueryKey(event.agentId, scopedInstance),
    event.controls
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
    const cacheKeyFor = (
      agentId: string,
      providerInstanceId?: string | null
    ) => `${agentId.trim().toLowerCase()}::${providerInstanceId?.trim() || ''}`;

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
