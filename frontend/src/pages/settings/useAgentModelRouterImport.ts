import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentAuthModeView,
  AgentAuthenticationStatus,
  AgentId,
  AgentManagementView,
  AgentModelProvidersView,
  DshProvidersView,
  OpenCodeProviderConnectionsView,
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
  isSameHostId,
  nextUniqueDshProviderId,
  nextUniqueOpenCodeProviderId,
  normalizeBareHostId,
  openCodeConnectRequest,
  providerSaveRequest,
  resolveCurrentHostIdentity,
  resolveRouterProviderName,
  type RouterProvision,
} from '@/features/model-router';
import { hostClientApi } from '@/lib/api';
import { getDesktopShell, getDesktopWindowLabel } from '@/lib/desktopShell';

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
  hostId?: string | null;
};

type RemoteImportTarget = {
  hostName: string;
  windowLabel?: string | null;
  profileId?: string | null;
};

async function invokeTargetAgentCommand<T>(
  remoteTarget: RemoteImportTarget | null,
  command: string,
  args: Record<string, unknown>,
  localCall: () => Promise<T>
): Promise<T> {
  if (!remoteTarget) {
    return localCall();
  }
  const shell = getDesktopShell();
  return shell.invoke<T>('remote_desktop_call', {
    profileId: remoteTarget.windowLabel
      ? 'active-host-client'
      : (remoteTarget.profileId ?? 'active-host-client'),
    ...(remoteTarget.windowLabel
      ? { windowLabel: remoteTarget.windowLabel }
      : {}),
    command,
    args,
  });
}

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
      providerName: string,
      remoteTarget: RemoteImportTarget | null = null
    ) => {
      try {
        if (targetAgentId === 'opencode' || targetAgentId === 'mimo_code') {
          const request = openCodeConnectRequest(provision, true, {
            providerId: savedProviderId ?? undefined,
            name: providerName,
          });
          await invokeTargetAgentCommand<OpenCodeProviderConnectionsView>(
            remoteTarget,
            'opencode_provider_connect',
            { agentId: targetAgentId, request },
            () =>
              agentManagementApi.connectOpenCodeProvider(request, targetAgentId)
          );
        } else if (targetAgentId === 'deepseek_harness') {
          const request = dshProviderSaveRequest(provision, true, {
            id: savedProviderId ?? undefined,
            displayName: providerName,
          });
          await invokeTargetAgentCommand<DshProvidersView>(
            remoteTarget,
            'dsh_provider_save',
            { request },
            () => agentManagementApi.saveDshProvider(request)
          );
          await invokeTargetAgentCommand<AgentAuthModeView>(
            remoteTarget,
            'agent_auth_mode_set',
            { agentId: 'deepseek_harness', mode: 'custom', apiKey: null },
            () =>
              agentManagementApi.setAuthMode('deepseek_harness', 'custom', null)
          );
          if (!remoteTarget) {
            clearAgentSettingsDraft('dsh-auth');
          }
        } else {
          if (!remoteTarget) {
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
          }
          let providerId = savedProviderId;
          if (!providerId) {
            const list =
              await invokeTargetAgentCommand<AgentModelProvidersView>(
                remoteTarget,
                'agent_model_providers',
                { agentId: targetAgentId },
                () => agentManagementApi.modelProviders(targetAgentId)
              );
            providerId =
              list.providers.find((item) => item.name === providerName)?.id ??
              null;
          }
          if (!providerId) {
            throw new Error(t('settings:agents.modelRouterImportFailed'));
          }
          await invokeTargetAgentCommand<AgentModelProvidersView>(
            remoteTarget,
            'agent_model_provider_bind',
            { agentId: targetAgentId, providerId },
            () => agentManagementApi.bindModelProvider(targetAgentId, providerId)
          );
        }
        if (!remoteTarget) {
          clearAgentSettingsDraft(`auth-mode:${targetAgentId}`);
          rememberAgentAuthKindTab(targetAgentId, 'provider');
          setProviderRefreshKey((current) => current + 1);
          await refreshAuthentication();
        }
        toast.success(
          t('settings:agents.modelRouterApplied', {
            model: remoteTarget
              ? `${provision.model.name} (${remoteTarget.hostName})`
              : provision.model.name,
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
        const targetHostId = normalizeBareHostId(
          provision.targetHostId ?? payload?.hostId
        );
        const currentHost = await resolveCurrentHostIdentity().catch(
          () => null
        );

        let remoteTarget: RemoteImportTarget | null = null;
        if (
          targetHostId &&
          currentHost?.hostId &&
          !isSameHostId(targetHostId, currentHost.hostId)
        ) {
          const hostClientStatus = await hostClientApi
            .status()
            .catch(() => null);
          const allProfiles = hostClientStatus?.profiles ?? [];
          const connectedProfile =
            allProfiles.find(
              (profile) =>
                isSameHostId(profile.host_id, targetHostId) &&
                (profile.connected || Boolean(profile.connected_window_label))
            ) ??
            (hostClientStatus?.connected &&
            hostClientStatus.profile &&
            isSameHostId(hostClientStatus.profile.host_id, targetHostId)
              ? hostClientStatus.profile
              : null);

          if (connectedProfile) {
            remoteTarget = {
              hostName:
                provision.targetHostName?.trim() ||
                connectedProfile.name?.trim() ||
                targetHostId,
              windowLabel: connectedProfile.connected_window_label ?? null,
              profileId: connectedProfile.id,
            };
          } else {
            const savedMatch = allProfiles.find((profile) =>
              isSameHostId(profile.host_id, targetHostId)
            );
            const targetHostLabel =
              provision.targetHostName?.trim() ||
              savedMatch?.name?.trim() ||
              targetHostId;
            const confirmed = await ConfirmDialog.show({
              title: t(
                'settings:agents.modelRouterTargetHostMismatchTitle',
                'Target Host Not Connected'
              ),
              message: t(
                'settings:agents.modelRouterTargetHostMismatchMessage',
                {
                  targetHost: targetHostLabel,
                  currentHost: currentHost.hostName,
                  defaultValue:
                    'This import targets "{{targetHost}}", which is not connected in this Dimo app. Import to the current local Host ({{currentHost}}) instead?',
                }
              ),
              confirmText: t(
                'settings:agents.modelRouterTargetHostMismatchConfirm',
                'Import to Current Host'
              ),
              cancelText: t('common:cancel', 'Cancel'),
            });
            if (confirmed !== 'confirmed') {
              return;
            }
          }
        }

        const targetAgentId = (provision.agentId?.trim() ||
          payload?.agentId?.trim() ||
          selectedAgentIdRef.current ||
          'claude_code') as AgentId;

        if (!remoteTarget) {
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
        }

        let savedProviderId: string | null = null;
        let providerName = resolveRouterProviderName(provision);
        if (targetAgentId === 'opencode' || targetAgentId === 'mimo_code') {
          const existing =
            await invokeTargetAgentCommand<OpenCodeProviderConnectionsView>(
              remoteTarget,
              'opencode_provider_connections',
              { agentId: targetAgentId },
              () => agentManagementApi.openCodeProviders(targetAgentId)
            );
          providerName = resolveRouterProviderName(
            provision,
            existing.providers.map((provider) => provider.name)
          );
          savedProviderId = nextUniqueOpenCodeProviderId(
            providerName,
            existing.providers.map((provider) => provider.provider_id)
          );
          const request = openCodeConnectRequest(provision, false, {
            providerId: savedProviderId,
            name: providerName,
          });
          await invokeTargetAgentCommand<OpenCodeProviderConnectionsView>(
            remoteTarget,
            'opencode_provider_connect',
            { agentId: targetAgentId, request },
            () =>
              agentManagementApi.connectOpenCodeProvider(request, targetAgentId)
          );
        } else if (targetAgentId === 'deepseek_harness') {
          const existing = await invokeTargetAgentCommand<DshProvidersView>(
            remoteTarget,
            'dsh_providers',
            {},
            () => agentManagementApi.dshProviders()
          );
          providerName = resolveRouterProviderName(
            provision,
            existing.providers.map((provider) => provider.display_name)
          );
          savedProviderId = nextUniqueDshProviderId(providerName, [
            ...existing.providers.map((provider) => provider.id),
            ...existing.catalog.map((provider) => provider.id),
            'deepseek',
          ]);
          const request = dshProviderSaveRequest(provision, false, {
            id: savedProviderId,
            displayName: providerName,
          });
          await invokeTargetAgentCommand<DshProvidersView>(
            remoteTarget,
            'dsh_provider_save',
            { request },
            () => agentManagementApi.saveDshProvider(request)
          );
        } else {
          const existing =
            await invokeTargetAgentCommand<AgentModelProvidersView>(
              remoteTarget,
              'agent_model_providers',
              { agentId: targetAgentId },
              () => agentManagementApi.modelProviders(targetAgentId)
            );
          providerName = resolveRouterProviderName(
            provision,
            existing.providers.map((provider) => provider.name)
          );
          const existingIds = new Set(
            existing.providers.map((provider) => provider.id)
          );
          const request = providerSaveRequest(provision, null, providerName);
          const saved =
            await invokeTargetAgentCommand<AgentModelProvidersView>(
              remoteTarget,
              'agent_model_provider_save',
              { request },
              () => agentManagementApi.saveModelProvider(request)
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

        if (!remoteTarget) {
          setProviderRefreshKey((current) => current + 1);
        }
        const description = remoteTarget
          ? `${remoteTarget.hostName} · ${providerName} · ${provision.model.name}`
          : `${providerName} · ${provision.model.name}`;
        toast.success(
          t(
            'settings:agents.modelRouterImportConfirmEnable',
            '模型导入成功，是否立即启用？'
          ),
          {
            description,
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
                  providerName,
                  remoteTarget
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
    const windowLabel = getDesktopWindowLabel();
    if (windowLabel && windowLabel.startsWith('settings-host-')) {
      return;
    }

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
