import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentAuthenticationStatus,
  AgentId,
  AgentManagementView,
} from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';
import {
  accountApi,
  dshProviderSaveRequest,
  nextUniqueDshProviderId,
  nextUniqueOpenCodeProviderId,
  openCodeConnectRequest,
  providerSaveRequest,
  resolveRouterProviderName,
  type RouterProvision,
} from '@/features/model-router';
import { getDesktopShell } from '@/lib/desktopShell';

import { rememberAgentAuthKindTab } from './agentAuthKindTab';
import {
  clearAgentSettingsDraft,
  retainAgentSettingsDraft,
} from './agentSettingsDraftRetention';

export const MODEL_ROUTER_IMPORT_EVENT = 'dimo://modelrouter-import';

export type PendingModelRouterImport = {
  id?: number;
  ticket: string;
  agentId?: string | null;
};

export function useAgentModelRouterImport({
  agents,
  selectedAgentId,
  selectAgent,
  setFocusDiagnostics,
  setRegistryOpen,
  setProviderRefreshKey,
  refreshAuthentication,
}: {
  agents: AgentManagementView[];
  selectedAgentId: AgentId | null;
  selectAgent: (agentId: AgentId) => void;
  setFocusDiagnostics: Dispatch<SetStateAction<boolean>>;
  setRegistryOpen: Dispatch<SetStateAction<boolean>>;
  setProviderRefreshKey: Dispatch<SetStateAction<number>>;
  refreshAuthentication: () => Promise<AgentAuthenticationStatus | null>;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const processedImportTicketsRef = useRef<Set<string>>(new Set());
  const agentsListRef = useRef<AgentManagementView[]>(agents);
  agentsListRef.current = agents;
  const selectedAgentIdRef = useRef<AgentId | null>(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;

  const enableImportedModelRouterProvider = useCallback(
    async (
      targetAgentId: AgentId,
      provision: RouterProvision,
      savedProviderId: string | null,
      providerName: string
    ) => {
      try {
        if (targetAgentId === 'opencode' || targetAgentId === 'mimo_code') {
          await agentManagementApi.connectOpenCodeProvider(
            openCodeConnectRequest(provision, true, {
              providerId: savedProviderId ?? undefined,
              name: providerName,
            }),
            targetAgentId
          );
        } else if (targetAgentId === 'deepseek_harness') {
          await agentManagementApi.saveDshProvider(
            dshProviderSaveRequest(provision, true, {
              id: savedProviderId ?? undefined,
              displayName: providerName,
            })
          );
          await agentManagementApi.setAuthMode(
            'deepseek_harness',
            'custom',
            null
          );
          clearAgentSettingsDraft('dsh-auth');
        } else {
          const agent = agentsListRef.current.find(
            (item) => item.agent_id === targetAgentId
          );
          const signedIn =
            agent?.authentication === 'account' ||
            agent?.authentication === 'multiple_unknown';
          if (signedIn) {
            const confirmed = await ConfirmDialog.show({
              title: t('settings:agents.authSwitchToProviderTitle'),
              message: t('settings:agents.authSwitchToProviderMessage'),
              confirmText: t('settings:agents.authSwitchToProviderConfirm'),
              cancelText: t('common:cancel'),
              variant: 'destructive',
            });
            if (confirmed !== 'confirmed') {
              return;
            }
          }
          let providerId = savedProviderId;
          if (!providerId) {
            const list = await agentManagementApi.modelProviders(targetAgentId);
            providerId =
              list.providers.find((item) => item.name === providerName)?.id ??
              null;
          }
          if (!providerId) {
            throw new Error(t('settings:agents.modelRouterImportFailed'));
          }
          await agentManagementApi.bindModelProvider(targetAgentId, providerId);
        }
        clearAgentSettingsDraft(`auth-mode:${targetAgentId}`);
        rememberAgentAuthKindTab(targetAgentId, 'provider');
        setProviderRefreshKey((current) => current + 1);
        await refreshAuthentication();
        toast.success(
          t('settings:agents.modelRouterApplied', {
            model: provision.model.name,
          })
        );
      } catch (error) {
        toast.error(
          errorMessage(error, t('settings:agents.modelRouterImportFailed'))
        );
      }
    },
    [refreshAuthentication, setProviderRefreshKey, t]
  );

  const handleModelRouterImport = useCallback(
    async (payload: PendingModelRouterImport | null | undefined) => {
      const ticket = payload?.ticket?.trim();
      if (!ticket || processedImportTicketsRef.current.has(ticket)) {
        return;
      }
      processedImportTicketsRef.current.add(ticket);
      try {
        const provision = await accountApi.redeemImportTicket(ticket);
        const targetAgentId = (provision.agentId?.trim() ||
          payload?.agentId?.trim() ||
          selectedAgentIdRef.current ||
          'claude_code') as AgentId;

        selectAgent(targetAgentId);
        setFocusDiagnostics(false);
        setRegistryOpen(false);
        rememberAgentAuthKindTab(targetAgentId, 'provider');
        if (targetAgentId === 'deepseek_harness') {
          clearAgentSettingsDraft('dsh-auth');
        } else {
          retainAgentSettingsDraft(`auth-mode:${targetAgentId}`, {
            mode: 'model_provider',
            apiKey: '',
          });
        }

        let savedProviderId: string | null = null;
        let providerName = resolveRouterProviderName(provision);
        if (targetAgentId === 'opencode' || targetAgentId === 'mimo_code') {
          const existing =
            await agentManagementApi.openCodeProviders(targetAgentId);
          providerName = resolveRouterProviderName(
            provision,
            existing.providers.map((provider) => provider.name)
          );
          savedProviderId = nextUniqueOpenCodeProviderId(
            providerName,
            existing.providers.map((provider) => provider.provider_id)
          );
          await agentManagementApi.connectOpenCodeProvider(
            openCodeConnectRequest(provision, false, {
              providerId: savedProviderId,
              name: providerName,
            }),
            targetAgentId
          );
        } else if (targetAgentId === 'deepseek_harness') {
          const existing = await agentManagementApi.dshProviders();
          providerName = resolveRouterProviderName(
            provision,
            existing.providers.map((provider) => provider.display_name)
          );
          savedProviderId = nextUniqueDshProviderId(providerName, [
            ...existing.providers.map((provider) => provider.id),
            ...existing.catalog.map((provider) => provider.id),
            'deepseek',
          ]);
          await agentManagementApi.saveDshProvider(
            dshProviderSaveRequest(provision, false, {
              id: savedProviderId,
              displayName: providerName,
            })
          );
        } else {
          const existing =
            await agentManagementApi.modelProviders(targetAgentId);
          providerName = resolveRouterProviderName(
            provision,
            existing.providers.map((provider) => provider.name)
          );
          const existingIds = new Set(
            existing.providers.map((provider) => provider.id)
          );
          const saved = await agentManagementApi.saveModelProvider(
            providerSaveRequest(provision, null, providerName)
          );
          savedProviderId =
            saved.providers.find(
              (provider) =>
                provider.name === providerName && !existingIds.has(provider.id)
            )?.id ??
            saved.providers.find((provider) => provider.name === providerName)
              ?.id ??
            null;
        }

        setProviderRefreshKey((current) => current + 1);
        toast.success(
          t(
            'settings:agents.modelRouterImportConfirmEnable',
            '模型导入成功，是否立即启用？'
          ),
          {
            description: `${providerName} · ${provision.model.name}`,
            duration: 15000,
            cancel: {
              label: t('common:cancel', '取消'),
              onClick: () => {},
            },
            action: {
              label: t('settings:agents.enableNow', '启用'),
              onClick: () => {
                void enableImportedModelRouterProvider(
                  targetAgentId,
                  provision,
                  savedProviderId,
                  providerName
                );
              },
            },
          }
        );
      } catch (error) {
        processedImportTicketsRef.current.delete(ticket);
        toast.error(
          errorMessage(error, t('settings:agents.modelRouterImportFailed'))
        );
      }
    },
    [
      enableImportedModelRouterProvider,
      selectAgent,
      setFocusDiagnostics,
      setProviderRefreshKey,
      setRegistryOpen,
      t,
    ]
  );

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    const shell = getDesktopShell();
    void shell.events
      .listen<PendingModelRouterImport>(
        MODEL_ROUTER_IMPORT_EVENT,
        (payload) => {
          if (!active) return;
          void handleModelRouterImport(payload);
        }
      )
      .then((fn) => {
        if (!active) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => undefined);

    void shell
      .invoke<PendingModelRouterImport | null>(
        'take_pending_model_router_import'
      )
      .then((pending) => {
        if (!active || !pending) return;
        void handleModelRouterImport(pending);
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisten?.();
    };
  }, [handleModelRouterImport]);
}
