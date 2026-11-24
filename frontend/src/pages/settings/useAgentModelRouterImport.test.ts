import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentManagementView } from 'shared/types';

import {
  MODEL_ROUTER_IMPORT_EVENT,
  useAgentModelRouterImport,
  type PendingModelRouterImport,
} from './useAgentModelRouterImport';

const mocks = vi.hoisted(() => ({
  windowLabel: 'settings',
  eventHandlers: new Map<string, (payload: PendingModelRouterImport) => void>(),
  shellInvoke: vi.fn(),
  redeemImportTicket: vi.fn(),
  resolveCurrentHostIdentity: vi.fn(),
  hostClientStatus: vi.fn(),
  modelProviders: vi.fn(),
  saveModelProvider: vi.fn(),
  bindModelProvider: vi.fn(),
  confirmShow: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts.defaultValue === 'string') {
        return opts.defaultValue
          .replace('{{targetHost}}', String(opts.targetHost ?? ''))
          .replace('{{currentHost}}', String(opts.currentHost ?? ''));
      }
      return key;
    },
  }),
}));

vi.mock('@/lib/desktopShell', () => ({
  getDesktopWindowLabel: () => mocks.windowLabel,
  getDesktopShell: () => ({
    events: {
      listen: vi.fn(
        async (
          event: string,
          handler: (payload: PendingModelRouterImport) => void
        ) => {
          mocks.eventHandlers.set(event, handler);
          return () => {
            mocks.eventHandlers.delete(event);
          };
        }
      ),
    },
    invoke: (...args: unknown[]) => mocks.shellInvoke(...args),
  }),
}));

vi.mock('@/lib/api', () => ({
  hostClientApi: {
    status: (...args: unknown[]) => mocks.hostClientStatus(...args),
  },
}));

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: {
    show: (...args: unknown[]) => mocks.confirmShow(...args),
  },
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
}));

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
    modelProviders: (...args: unknown[]) => mocks.modelProviders(...args),
    saveModelProvider: (...args: unknown[]) => mocks.saveModelProvider(...args),
    bindModelProvider: (...args: unknown[]) => mocks.bindModelProvider(...args),
  },
  agentManagementErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

vi.mock('@/features/model-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/model-router')>();
  return {
    ...actual,
    accountApi: {
      ...actual.accountApi,
      redeemImportTicket: (...args: unknown[]) =>
        mocks.redeemImportTicket(...args),
    },
    resolveCurrentHostIdentity: (...args: unknown[]) =>
      mocks.resolveCurrentHostIdentity(...args),
  };
});

function makeBaseProvision(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: 'sk-vxr-test',
    agentId: 'claude_code',
    protocol: 'anthropic' as const,
    baseUrl: 'https://dimo.test/api/router',
    group: 'default',
    keyName: 'Dimo Router',
    model: { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
    ...overrides,
  };
}

describe('useAgentModelRouterImport', () => {
  const selectAgent = vi.fn();
  const setFocusDiagnostics = vi.fn();
  const setRegistryOpen = vi.fn();
  const setProviderRefreshKey = vi.fn();
  const refreshAuthentication = vi.fn().mockResolvedValue(null);

  beforeEach(() => {
    mocks.windowLabel = 'settings';
    mocks.eventHandlers.clear();
    mocks.shellInvoke.mockReset();
    mocks.redeemImportTicket.mockReset();
    mocks.resolveCurrentHostIdentity.mockReset();
    mocks.hostClientStatus.mockReset();
    mocks.modelProviders.mockReset();
    mocks.saveModelProvider.mockReset();
    mocks.bindModelProvider.mockReset();
    mocks.confirmShow.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
    selectAgent.mockReset();
    setFocusDiagnostics.mockReset();
    setRegistryOpen.mockReset();
    setProviderRefreshKey.mockReset();
    refreshAuthentication.mockClear();

    mocks.shellInvoke.mockImplementation(async (command: string) => {
      if (command === 'take_pending_model_router_import') {
        return null;
      }
      if (command === 'remote_desktop_call') {
        return {
          providers: [{ id: 'remote-prov-1', name: 'Dimo Router' }],
        };
      }
      return null;
    });
    mocks.resolveCurrentHostIdentity.mockResolvedValue({
      hostId: 'host:local-uuid-1',
      hostName: 'ALICE-PC',
      kind: 'local',
    });
    mocks.hostClientStatus.mockResolvedValue({
      connected: false,
      profile: null,
      profiles: [],
    });
    mocks.modelProviders.mockResolvedValue({ providers: [] });
    mocks.saveModelProvider.mockResolvedValue({
      providers: [{ id: 'local-prov-1', name: 'Dimo Router' }],
    });
    mocks.bindModelProvider.mockResolvedValue({ providers: [] });
  });

  function renderImportHook() {
    return renderHook(() =>
      useAgentModelRouterImport({
        agents: [] as AgentManagementView[],
        selectedAgentId: 'claude_code',
        selectAgent,
        setFocusDiagnostics,
        setRegistryOpen,
        setProviderRefreshKey,
        refreshAuthentication,
      })
    );
  }

  it('imports directly to local host when hostId is omitted or matches local hostId (ignoring host: prefix)', async () => {
    mocks.redeemImportTicket.mockResolvedValue(
      makeBaseProvision({ targetHostId: 'local-uuid-1' })
    );

    renderImportHook();
    await waitFor(() =>
      expect(mocks.eventHandlers.has(MODEL_ROUTER_IMPORT_EVENT)).toBe(true)
    );

    await act(async () => {
      mocks.eventHandlers.get(MODEL_ROUTER_IMPORT_EVENT)?.({
        ticket: 'tkt_local_match',
        agentId: 'claude_code',
        hostId: 'local-uuid-1',
      });
    });

    await waitFor(() =>
      expect(mocks.saveModelProvider).toHaveBeenCalledTimes(1)
    );
    expect(mocks.confirmShow).not.toHaveBeenCalled();
    expect(selectAgent).toHaveBeenCalledWith('claude_code');
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it('routes import and enable action to a connected remote/SSH Host via remote_desktop_call', async () => {
    mocks.redeemImportTicket.mockResolvedValue(
      makeBaseProvision({
        targetHostId: 'ssh-host-uuid-9',
        targetHostName: 'GPU-Server',
      })
    );
    mocks.hostClientStatus.mockResolvedValue({
      connected: false,
      profile: null,
      profiles: [
        {
          id: 'prof-ssh-9',
          name: 'GPU-Server',
          origin: 'http://127.0.0.1:43210',
          host_id: 'ssh-host-uuid-9',
          connected: true,
          connected_window_label: 'host-prof-ssh-9',
          provision_kind: 'ssh',
        },
      ],
    });
    mocks.shellInvoke.mockImplementation(
      async (
        command: string,
        args?: { command?: string; args?: { request?: { name?: string } } }
      ) => {
        if (command === 'take_pending_model_router_import') return null;
        if (command === 'remote_desktop_call') {
          if (args?.command === 'agent_model_providers') {
            return { providers: [] };
          }
          if (args?.command === 'agent_model_provider_save') {
            return {
              providers: [
                {
                  id: 'remote-prov-99',
                  name: args.args?.request?.name ?? 'default',
                },
              ],
            };
          }
          if (args?.command === 'agent_model_provider_bind') {
            return { providers: [] };
          }
        }
        return null;
      }
    );

    renderImportHook();
    await waitFor(() =>
      expect(mocks.eventHandlers.has(MODEL_ROUTER_IMPORT_EVENT)).toBe(true)
    );

    await act(async () => {
      mocks.eventHandlers.get(MODEL_ROUTER_IMPORT_EVENT)?.({
        ticket: 'tkt_remote_connected',
        agentId: 'claude_code',
        hostId: 'ssh-host-uuid-9',
      });
    });

    await waitFor(() =>
      expect(mocks.shellInvoke).toHaveBeenCalledWith(
        'remote_desktop_call',
        expect.objectContaining({
          profileId: 'active-host-client',
          windowLabel: 'host-prof-ssh-9',
          command: 'agent_model_provider_save',
        })
      )
    );
    expect(mocks.saveModelProvider).not.toHaveBeenCalled();
    expect(mocks.confirmShow).not.toHaveBeenCalled();
    expect(selectAgent).not.toHaveBeenCalled();

    // Clicking "Enable" in the toast binds the provider on the same remote Host
    const toastOptions = mocks.toastSuccess.mock.calls[0]?.[1] as {
      description?: string;
      action?: { onClick: () => void };
    };
    expect(toastOptions?.description).toContain('GPU-Server');
    await act(async () => {
      toastOptions?.action?.onClick();
    });
    await waitFor(() =>
      expect(mocks.shellInvoke).toHaveBeenCalledWith(
        'remote_desktop_call',
        expect.objectContaining({
          profileId: 'active-host-client',
          windowLabel: 'host-prof-ssh-9',
          command: 'agent_model_provider_bind',
          args: { agentId: 'claude_code', providerId: 'remote-prov-99' },
        })
      )
    );
  });

  it('prompts confirmation when targetHostId is disconnected and respects Cancel vs Import to Current Host', async () => {
    mocks.redeemImportTicket.mockResolvedValue(
      makeBaseProvision({
        targetHostId: 'other-desktop-uuid',
        targetHostName: 'MacBook-Pro',
      })
    );
    mocks.confirmShow
      .mockResolvedValueOnce('cancelled')
      .mockResolvedValueOnce('confirmed');

    renderImportHook();
    await waitFor(() =>
      expect(mocks.eventHandlers.has(MODEL_ROUTER_IMPORT_EVENT)).toBe(true)
    );

    // 1. User cancels -> does not save locally
    await act(async () => {
      mocks.eventHandlers.get(MODEL_ROUTER_IMPORT_EVENT)?.({
        ticket: 'tkt_disconnected_cancel',
        agentId: 'claude_code',
        hostId: 'other-desktop-uuid',
      });
    });

    await waitFor(() => expect(mocks.confirmShow).toHaveBeenCalledTimes(1));
    expect(mocks.confirmShow.mock.calls[0]?.[0]?.message).toContain(
      'MacBook-Pro'
    );
    expect(mocks.confirmShow.mock.calls[0]?.[0]?.message).toContain('ALICE-PC');
    expect(mocks.saveModelProvider).not.toHaveBeenCalled();

    // 2. User confirms fallback to current local Host -> saves locally
    await act(async () => {
      mocks.eventHandlers.get(MODEL_ROUTER_IMPORT_EVENT)?.({
        ticket: 'tkt_disconnected_confirm',
        agentId: 'claude_code',
        hostId: 'other-desktop-uuid',
      });
    });

    await waitFor(() =>
      expect(mocks.saveModelProvider).toHaveBeenCalledTimes(1)
    );
    expect(selectAgent).toHaveBeenCalledWith('claude_code');
  });

  it('ignores deep-link import events in remote host settings windows to avoid duplicate single-use ticket redemption', async () => {
    mocks.windowLabel = 'settings-host-prof-ssh-9';

    renderImportHook();

    expect(mocks.eventHandlers.has(MODEL_ROUTER_IMPORT_EVENT)).toBe(false);
    expect(mocks.shellInvoke).not.toHaveBeenCalledWith(
      'take_pending_model_router_import'
    );
  });
});
