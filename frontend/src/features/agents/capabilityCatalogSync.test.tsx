import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionControlsSnapshot } from 'shared/types';
import {
  type AgentCapabilityCatalogUpdatedEvent,
  useAgentCapabilityCatalogSync,
} from './capabilityCatalogSync';
import {
  sessionControlsQueryKey,
  sessionControlsSchemaQueryKey,
} from './sessionControlsQuery';

const capabilityCatalogsSnapshot = vi.fn();
let catalogListener:
  | ((payload: AgentCapabilityCatalogUpdatedEvent) => void)
  | null = null;
const unlistenMock = vi.fn();

vi.mock('./api', () => ({
  agentsApi: {
    capabilityCatalogsSnapshot: () => capabilityCatalogsSnapshot(),
  },
}));

vi.mock('@/lib/backendTransport', () => ({
  backendListen: vi.fn(
    (
      event: string,
      handler: (payload: AgentCapabilityCatalogUpdatedEvent) => void
    ) => {
      if (event === 'agent-capability-catalog-updated') {
        catalogListener = handler;
      }
      return Promise.resolve(unlistenMock);
    }
  ),
}));

const CLAUDE_CONTROLS: AgentSessionControlsSnapshot = {
  modes: [{ id: 'default', label: 'Default', description: null }],
  current_mode: 'default',
  config_options: [
    {
      key: 'model',
      label: 'Model',
      category: 'model',
      value: 'claude-sonnet-4-6',
      choices: [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }],
    },
  ],
};

const AGY_CONTROLS: AgentSessionControlsSnapshot = {
  modes: [{ id: 'planning', label: 'Planning', description: null }],
  current_mode: 'planning',
  config_options: [],
};

function SyncHarness() {
  useAgentCapabilityCatalogSync();
  return null;
}

describe('useAgentCapabilityCatalogSync', () => {
  beforeEach(() => {
    capabilityCatalogsSnapshot.mockReset();
    unlistenMock.mockReset();
    catalogListener = null;
  });

  it('hydrates query cache from batch snapshot on mount and updates in place on EventBus push', async () => {
    capabilityCatalogsSnapshot.mockResolvedValue({
      claude_code: CLAUDE_CONTROLS,
    });
    const client = new QueryClient();

    const { unmount } = render(
      <QueryClientProvider client={client}>
        <SyncHarness />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(
        client.getQueryData(sessionControlsQueryKey('claude_code', null))
      ).toEqual(CLAUDE_CONTROLS);
    });
    expect(
      client.getQueryData(sessionControlsSchemaQueryKey('claude_code'))
    ).toEqual(CLAUDE_CONTROLS);

    catalogListener?.({
      agentId: 'antigravity',
      providerInstanceId: null,
      controls: AGY_CONTROLS,
    });

    expect(
      client.getQueryData(sessionControlsQueryKey('antigravity', null))
    ).toEqual(AGY_CONTROLS);
    expect(
      client.getQueryData(sessionControlsSchemaQueryKey('antigravity'))
    ).toEqual(AGY_CONTROLS);

    unmount();
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a late-resolving bootstrap snapshot overwrite a newer EventBus push', async () => {
    const deferred: {
      resolve?: (value: Record<string, AgentSessionControlsSnapshot>) => void;
    } = {};
    capabilityCatalogsSnapshot.mockImplementation(
      () =>
        new Promise<Record<string, AgentSessionControlsSnapshot>>((resolve) => {
          deferred.resolve = resolve;
        })
    );
    const client = new QueryClient();

    render(
      <QueryClientProvider client={client}>
        <SyncHarness />
      </QueryClientProvider>
    );

    const fresherClaude: AgentSessionControlsSnapshot = {
      ...CLAUDE_CONTROLS,
      config_options: [
        {
          key: 'model',
          label: 'Model',
          category: 'model',
          value: 'claude-opus-4-7',
          choices: [{ value: 'claude-opus-4-7', label: 'Claude Opus 4.7' }],
        },
      ],
    };

    catalogListener?.({
      agentId: 'claude_code',
      providerInstanceId: null,
      controls: fresherClaude,
    });

    deferred.resolve?.({
      claude_code: CLAUDE_CONTROLS,
      antigravity: AGY_CONTROLS,
    });

    await waitFor(() => {
      expect(
        client.getQueryData(sessionControlsQueryKey('antigravity', null))
      ).toEqual(AGY_CONTROLS);
    });
    expect(
      client.getQueryData(sessionControlsQueryKey('claude_code', null))
    ).toEqual(fresherClaude);
  });
});
