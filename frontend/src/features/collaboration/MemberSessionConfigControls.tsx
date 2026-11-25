import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { AgentSessionControlsErrorCard } from '@/components/sessions/SessionCreationStatusCard';
import {
  advertisedSessionConfigValues,
  presentableSessionConfigOptions,
  resolvedConfigOptionChoices,
  sanitizeDependentConfigValues,
  selectConfigOptionValue,
  visibleSessionConfigOptions,
} from '@/components/tasks/follow-up/SessionConfigOptionSelectors';
import { SessionSettingsSummary } from '@/components/tasks/follow-up/SessionSettingsSummary';
import { agentsApi } from '@/features/agents/api';
import {
  loadAgentSessionControlsCatalog,
  mergeCreateSessionControls,
  normalizeAgentType,
  sessionControlsQueryKey,
  sessionControlsSchemaQueryKey,
} from '@/features/agents/sessionControlsQuery';

export function MemberSessionConfigControls({
  agentId,
  modeId,
  values,
  onModeId,
  onValues,
}: {
  agentId: string;
  modeId: string;
  values: Record<string, string>;
  onModeId: (modeId: string) => void;
  onValues: (values: Record<string, string>) => void;
}) {
  const normalizedAgentId = normalizeAgentType(agentId);
  const catalogQuery = useQuery({
    queryKey: sessionControlsQueryKey(agentId, null),
    queryFn: () => loadAgentSessionControlsCatalog(agentId),
    enabled: Boolean(normalizedAgentId),
    staleTime: 60_000,
    gcTime: Infinity,
    retry: false,
  });
  const schemaQuery = useQuery({
    queryKey: sessionControlsSchemaQueryKey(agentId),
    queryFn: () => loadAgentSessionControlsCatalog(agentId),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const catalogFreshnessQuery = useQuery({
    queryKey: ['agentCapabilityCatalogFreshness', normalizedAgentId],
    queryFn: () => agentsApi.capabilityCatalogFresh(normalizedAgentId),
    enabled: Boolean(normalizedAgentId && catalogQuery.data),
    staleTime: 0,
    retry: false,
  });
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const backgroundRefreshAgent = useRef<string | null>(null);
  const activeAgentRef = useRef(normalizedAgentId);
  activeAgentRef.current = normalizedAgentId;

  useEffect(() => {
    backgroundRefreshAgent.current = null;
    setRefreshError(null);
  }, [normalizedAgentId]);

  const needsUncachedDiscovery = Boolean(
    normalizedAgentId &&
      catalogQuery.isFetched &&
      !catalogQuery.error &&
      catalogQuery.data === null
  );
  const needsStaleRefresh = Boolean(
    normalizedAgentId && catalogFreshnessQuery.data === false
  );

  useEffect(() => {
    if (
      !normalizedAgentId ||
      (!needsUncachedDiscovery && !needsStaleRefresh) ||
      backgroundRefreshAgent.current === normalizedAgentId
    ) {
      return;
    }
    backgroundRefreshAgent.current = normalizedAgentId;
    const targetAgent = normalizedAgentId;
    const isUncachedDiscovery = needsUncachedDiscovery;
    void agentsApi
      .refreshCapabilityCatalog(targetAgent)
      .then(async (refreshed) => {
        if (activeAgentRef.current !== targetAgent) return;
        if (!refreshed) {
          if (isUncachedDiscovery) {
            setRefreshError(
              new Error('Agent session controls discovery failed')
            );
          }
          return;
        }
        setRefreshError(null);
        await catalogQuery.refetch();
        await catalogFreshnessQuery.refetch();
      })
      .catch((error: unknown) => {
        if (activeAgentRef.current !== targetAgent) return;
        if (isUncachedDiscovery) {
          setRefreshError(error);
        }
      });
  }, [
    catalogFreshnessQuery,
    catalogQuery,
    needsStaleRefresh,
    needsUncachedDiscovery,
    normalizedAgentId,
  ]);

  const catalog = mergeCreateSessionControls([
    catalogQuery.data,
    schemaQuery.data,
  ]);
  const visibleConfigOptions = visibleSessionConfigOptions(
    catalog?.config_options ?? []
  );
  const presentableConfigOptions = presentableSessionConfigOptions(
    visibleConfigOptions,
    catalog?.modes ?? []
  );
  const advertisedConfigValues =
    advertisedSessionConfigValues(visibleConfigOptions);
  const sanitizedConfigValues = sanitizeDependentConfigValues(
    visibleConfigOptions,
    {
      ...advertisedConfigValues,
      ...values,
    }
  );
  const hasControls = Boolean(
    catalog &&
      (catalog.modes.length > 0 ||
        presentableConfigOptions.some(
          (option) =>
            typeof option.value === 'boolean' ||
            resolvedConfigOptionChoices(
              option,
              visibleConfigOptions,
              sanitizedConfigValues
            ).length > 1
        ))
  );

  if (!normalizedAgentId) return null;
  if (!catalog || !hasControls) {
    const activeError = catalogQuery.error ?? refreshError;
    if (activeError) {
      return (
        <AgentSessionControlsErrorCard
          agentId={normalizedAgentId}
          error={activeError}
        />
      );
    }
    return null;
  }

  const presentableConfigKeys = new Set(
    presentableConfigOptions.map((option) => option.key)
  );
  const configOverrides = Object.fromEntries(
    Object.entries(sanitizedConfigValues).filter(([key]) =>
      presentableConfigKeys.has(key)
    )
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SessionSettingsSummary
        sessionModes={{
          current: catalog.current_mode ?? null,
          modes: catalog.modes,
        }}
        options={visibleConfigOptions}
        selectedMode={modeId || catalog.current_mode || null}
        pending={configOverrides}
        onSelectMode={onModeId}
        onSelectConfigOption={(key, value) => {
          if (!modeId && catalog.current_mode) {
            onModeId(catalog.current_mode);
          }
          onValues(
            selectConfigOptionValue(
              visibleConfigOptions,
              configOverrides,
              key,
              value
            )
          );
        }}
      />
    </div>
  );
}
